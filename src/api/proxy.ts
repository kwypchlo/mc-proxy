import ky, { HTTPError } from "ky";
import { cache, cacheStats } from "../cache";
import { config } from "../config";
import { getTenant, invalidTokens, useNextToken, pendingTokens } from "../tenant";
import type { Context, Next } from "hono";
import ms from "pretty-ms";
import type { StatusCode } from "hono/utils/http-status";
import chalk from "chalk";
import { rand } from "../utils";
import z from "zod";

const zTweet = z.object({
  author_id: z.string().min(1),
  created_at: z.string().min(1),
  edit_history_tweet_ids: z.array(z.string()).nonempty(),
  id: z.string().min(1),
  text: z.string().min(1),
});

const zTweetResponse = z.object({
  data: z.array(zTweet).optional(),
  meta: z.object({
    newest_id: z.string().optional(),
    next_token: z.string().optional(),
    oldest_id: z.string().optional(),
    result_count: z.number().int().nonnegative(),
  }),
});

type ApiTweetResponse = z.infer<typeof zTweetResponse>;

const mergeMore = (cached: ApiTweetResponse, more: ApiTweetResponse): ApiTweetResponse => {
  if (more.meta.result_count === 0) {
    console.log(`[Cache more] Fetched more tweets but result returned empty, returning cached data`);

    return cached;
  }

  const newTweets = more.data!.slice(); // clone new tweets
  const newTweetsIds = new Set(newTweets.flatMap(({ edit_history_tweet_ids }) => edit_history_tweet_ids));
  const cachedTweets = cached.data!.filter(({ id }) => newTweetsIds.has(id) === false); // filter edited tweets
  const newTweetsSlice = newTweets.concat(cachedTweets).slice(0, 50); // limit to 50 tweets

  console.log(`[Cache more] Fetched ${more.meta.result_count} new tweets for cached query, returning merged data`);

  cacheStats.retained += 50 - more.meta.result_count; // count retained tweets
  cacheStats.fetched += more.meta.result_count; // count fetched tweets

  return {
    data: newTweetsSlice,
    meta: {
      newest_id: newTweetsSlice[0].id,
      oldest_id: newTweetsSlice[newTweetsSlice.length - 1].id,
      result_count: newTweetsSlice.length,
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

              if (cacheCap - config.cache.ttl < ttl) {
                cacheStatus = "hit";

                return Response.json(data);
              } else if (data.meta.newest_id) {
                cacheStatus = "more";

                const prevRequest = request.clone();
                const requestUrl = new URL(prevRequest.url);
                requestUrl.searchParams.set("since_id", data.meta.newest_id);
                requestUrl.searchParams.delete("start_time");

                request = new Request(requestUrl.toString());
              }
            }

            currentToken = useNextToken(tenant);

            request.headers.set("authorization", `Bearer ${currentToken.token}`);

            return request;
          },
        ],
      },
    }).json();

    zTweetResponse.parse(data); // validate response

    if (cacheStatus === "miss") {
      cacheStats.misses++;
      cacheStats.fetched += data.meta.result_count; // count fetched tweets

      await cache.set(search, JSON.stringify(data), cacheCap);
    } else if (cacheStatus === "hit") {
      cacheStats.hits++;
    } else if (cacheStatus === "more") {
      cacheStats.misses++;

      const cached = await cache.get(search);
      if (typeof cached !== "string") {
        console.log(`[Error] Cache miss for more - this should not happen!`);

        return tweets(search, tenant);
      }

      data = mergeMore(JSON.parse(cached) as ApiTweetResponse, data);

      await cache.set(search, JSON.stringify(data), cacheCap);
    }

    return { data, status: 200, cacheStatus };
  } catch (error) {
    const usedToken = currentToken === null ? null : (currentToken as ReturnType<typeof useNextToken>).token;

    if (error instanceof HTTPError) {
      const message = await error.response.text();

      console.log(
        `${chalk.red("[Twitter Error]")} (${tenant.name}) ${error.response.status} ${error.response.statusText} ${message}`,
      );

      if (usedToken !== null && [401, 403].includes(error.response.status)) {
        invalidTokens.set(usedToken, true);
      }

      return { data: undefined, status: error.response.status as StatusCode, cacheStatus };
    } else if (error instanceof z.ZodError) {
      console.log(`${chalk.red("[Response Validaton Error]")} (${tenant.name}) ${JSON.stringify(error.format())}`);
    } else {
      console.log(`${chalk.red("[Error]")} (${tenant.name}) ${String(error)}`);
    }

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
    `${status} (${tenant.name}) ${ms(performance.now() - start, {}).padEnd(5)} ${cacheStatus.padEnd(4)} ${chalk.gray(status === 200 ? `${searchParams.get("query")}` : search)}`,
  );

  return c.json(data, status);
};

export const proxyApiMiddleware = async (c: Context, next: Next) => {
  await next();

  // print cache stats every 50 handled requests
  if (++cacheStats.requests % 50 === 0) {
    const cacheRatio = Math.floor((cacheStats.hits / (cacheStats.hits + cacheStats.misses)) * 100) || 0;
    const retainRatio = Math.floor((cacheStats.retained / (cacheStats.fetched + cacheStats.retained)) * 100) || 0;

    console.log(
      `📦 Cache: redis ${cache.redisClient.isReady ? "ok" : "no"}, misses ${cacheStats.misses}, hits ${cacheStats.hits} (${cacheRatio}%), size ${await cache.size()}, ttl: ${config.cache.ttl}`,
    );

    console.log(
      `📊 Tweets: fetched ${cacheStats.fetched}, retained ${cacheStats.retained} (${retainRatio}%), total ${cacheStats.fetched + cacheStats.retained} tweets`,
    );

    console.log(
      `🔑 Api keys in use: ${JSON.stringify(Object.keys(pendingTokens).map((tenant) => [tenant, Object.values(pendingTokens[tenant])]))}`,
    );

    if (invalidTokens.size > 0) {
      console.log(`🚫 Invalid tokens: ${JSON.stringify(Array.from(invalidTokens.keys()), null, 2)}`);
    }
  }
};
