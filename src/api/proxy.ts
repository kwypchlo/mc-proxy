import ky, { HTTPError } from "ky";
import { cache, cacheStats } from "../cache";
import { config } from "../config";
import { getTenant, invalidTokens, useNextToken, pendingTokens } from "../tenant";
import type { Context, Next } from "hono";
import ms from "pretty-ms";
import type { StatusCode } from "hono/utils/http-status";
import { rand } from "../utils";
import { isEqual } from "lodash-es";

type ApiTweet = {
  author_id: string;
  created_at: string;
  edit_history_tweet_ids: string[];
  id: string;
  text: string;
};

type ApiTweetResponse = {
  data?: ApiTweet[];
  meta: {
    newest_id?: string;
    next_token?: string;
    oldest_id?: string;
    result_count: number;
  };
};

const mergeMore = (cached: ApiTweetResponse, more: ApiTweetResponse): ApiTweetResponse => {
  if (more.meta.result_count === 0) {
    console.log(`[Cache more] Tried to fetch more tweets but none were added, returning cached data`);

    return cached;
  }

  const tweets = more.data!.slice(); // clone array

  if (cached.meta.result_count > 0) {
    for (const cachedTweet of cached.data!) {
      const existing = tweets.find(({ id }) => id === cachedTweet.id);
      if (existing && isEqual(existing, cachedTweet)) {
        continue; // skip overlapping tweets (can happen when race condition with other tenants fetching same data)
      }

      if (existing && !isEqual(existing, cachedTweet)) {
        throw new Error(`Found duplicate tweet ${cachedTweet.id} in more data and its different`);
      }

      const edited = tweets.some(({ edit_history_tweet_ids }) => edit_history_tweet_ids.includes(cachedTweet.id));

      if (edited) {
        throw new Error(`Found edited tweet ${cachedTweet.id} in more data`);
      }

      tweets.push(cachedTweet);

      if (tweets.length === 50) break;
    }
  }

  console.log(`[Cache more] Found ${more.data!.length} new tweets for cached query, returning merged data`);

  const tweetsSlice = tweets.slice(0, 50); // ensure limit to 50 tweets

  return {
    data: tweetsSlice,
    meta: {
      newest_id: tweetsSlice[0].id,
      oldest_id: tweetsSlice[tweetsSlice.length - 1].id,
      result_count: tweetsSlice.length,
    },
  };
};

const tweets = async (
  search: string,
  tenant: (typeof config.tenants)[number],
): Promise<{ data?: ApiTweetResponse; status: StatusCode; cacheStatus: string }> => {
  const cacheCap = 24 * 60 * 60; // 24 hours
  let currentToken: null | ReturnType<typeof useNextToken> = null;
  let cacheStatus: "miss" | "hit" | "more" = "miss";

  try {
    let data: ApiTweetResponse = await ky("https://api.twitter.com/2/tweets/search/all", {
      searchParams: search,
      headers: { "user-agent": "v2FullArchiveSearchPython" },
      retry: { limit: 15, delay: (attempt) => [250, 500, rand(500, 1000)][Math.min(attempt - 1, 2)] },
      timeout: 15 * 1000, // 15 seconds timeout
      hooks: {
        beforeRequest: [
          async (request) => {
            if (currentToken !== null) {
              currentToken.releaseToken();
              currentToken = null;
            }

            const [cached, ttl] = await Promise.all([cache.get(search), cache.ttl(search)]);
            if (typeof cached === "string") {
              const data: ApiTweetResponse = JSON.parse(cached);

              console.log(`[Cache] Found data with ttl ${ttl} (cacheCap ${cacheCap}, config.ttl ${config.cache.ttl})`);

              if (cacheCap - config.cache.ttl < ttl) {
                cacheStatus = "hit";

                return Response.json(data);
              } else if (data.meta.newest_id) {
                cacheStatus = "more";

                const prevRequest = request.clone();
                const requestUrl = new URL(prevRequest.url);
                requestUrl.searchParams.set("since_id", data.meta.newest_id);
                requestUrl.searchParams.delete("start_time");

                request = new Request(requestUrl, {
                  headers: prevRequest.headers,
                });
              }
            }

            currentToken = useNextToken(tenant);

            request.headers.set("authorization", `Bearer ${currentToken.token}`);
          },
        ],
      },
    }).json();

    if (cacheStatus === "miss") {
      cacheStats.misses++;
      cache.set(search, JSON.stringify(data), cacheCap);
    } else if (cacheStatus === "hit") {
      cacheStats.hits++;
    } else if (cacheStatus === "more") {
      cacheStats.misses++;

      try {
        const cached = await cache.get(search);

        if (typeof cached !== "string") {
          throw new Error(`Cache miss for more - this should not happen!`);
        }

        data = mergeMore(JSON.parse(cached) as ApiTweetResponse, data);

        cache.set(search, JSON.stringify(data), cacheCap);
      } catch (error) {
        console.log(`[Cache more] ${String(error)}, fetching fresh data`);

        await cache.redisClient.del(search);

        return tweets(search, tenant);
      }
    }

    return { data, status: 200, cacheStatus };
  } catch (error) {
    const usedToken = currentToken === null ? null : (currentToken as ReturnType<typeof useNextToken>).token;

    if (error instanceof HTTPError) {
      const message = error.response.text ? await error.response.text() : "";

      console.log(`[Twitter Error] (${tenant.name}) ${error.response.status} ${error.response.statusText} ${message}`);

      if (usedToken !== null && [401, 403].includes(error.response.status)) {
        invalidTokens.set(usedToken, true);
      }

      return { data: undefined, status: error.response.status as StatusCode, cacheStatus };
    }

    console.log(`[Error] (${tenant.name}) ${String(error)}`);

    return { data: undefined, status: 500, cacheStatus };
  } finally {
    if (currentToken !== null) {
      (currentToken as ReturnType<typeof useNextToken>).releaseToken();
      currentToken = null;
    }
  }
};

export const proxyApi = async (c: Context) => {
  const start = performance.now();
  const tenant = getTenant(c);

  const { search, searchParams } = new URL(c.req.url);
  const { data, status, cacheStatus } = await tweets(search, tenant);

  console.log(
    `${status} (${tenant.name}) ${ms(performance.now() - start, {}).padEnd(5)} ${cacheStatus.padEnd(4)} ${status === 200 ? `${searchParams.get("query")}` : search}`,
  );

  return c.json(data, status);
};

export const proxyApiMiddleware = async (c: Context, next: Next) => {
  await next();

  // print cache stats every 50 handled requests
  if (++cacheStats.requests % 50 === 0) {
    const ratio = Math.floor((cacheStats.hits / (cacheStats.hits + cacheStats.misses)) * 100) || 0;

    console.log(
      `📦 Cache: redis ${cache.redisClient.isReady ? "ok" : "no"}, misses ${cacheStats.misses}, hits ${cacheStats.hits} (${ratio}%), size ${await cache.size()}, ttl: ${config.cache.ttl}`,
    );

    console.log(
      `🔑 Usage: ${JSON.stringify(Object.keys(pendingTokens).map((tenant) => [tenant, Object.values(pendingTokens[tenant])]))}`,
    );

    if (invalidTokens.size > 0) {
      console.log(`🚫 Invalid tokens: ${JSON.stringify(Array.from(invalidTokens.keys()), null, 2)}`);
    }
  }
};
