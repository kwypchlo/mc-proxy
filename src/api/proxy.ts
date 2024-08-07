import ky, { HTTPError } from "ky";
import { stats } from "../stats";
import { config, type Config } from "../config";
import { getTenant, invalidTokens, useNextToken } from "../tenant";
import type { Context, Next } from "hono";
import ms from "pretty-ms";
import type { StatusCode } from "hono/utils/http-status";
import chalk from "chalk";
import { rand } from "../utils";
import z from "zod";
import { redisClient } from "../redis";

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
    return cached;
  }

  const newTweets = more.data!.slice(); // clone new tweets
  const newTweetsIds = new Set(newTweets.flatMap(({ edit_history_tweet_ids }) => edit_history_tweet_ids));
  const cachedTweets = cached.data!.filter(({ id }) => newTweetsIds.has(id) === false); // filter edited tweets
  const newTweetsSlice = newTweets.concat(cachedTweets).slice(0, 50); // limit to 50 tweets

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
  tenant: Config["tenants"][number],
): Promise<{ data?: ApiTweetResponse; status: StatusCode; cacheStatus: string }> => {
  let currentToken: null | ReturnType<typeof useNextToken> = null;
  let cacheStatus: "miss" | "hit" | "more" = "miss";
  let cachedTweetResponse: ApiTweetResponse | null = null;

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

            const [cached, ttl] = await Promise.all([redisClient.get(search), redisClient.ttl(search)]);
            if (typeof cached === "string") {
              cachedTweetResponse = JSON.parse(cached) as ApiTweetResponse;

              if (config.cache.ttlMax - (tenant.ttl ?? config.cache.ttl) < ttl) {
                cacheStatus = "hit";

                // if cached data is cached for more than ttl max, limit to ttl max
                // this can happen when ttl max is reduced and cached data with previous ttl value exists
                if (ttl > config.cache.ttlMax) {
                  await redisClient.expire(search, config.cache.ttlMax);
                }

                return Response.json(cachedTweetResponse);
              } else if (cachedTweetResponse.meta.newest_id) {
                cacheStatus = "more";

                const prevRequest = request.clone();
                const requestUrl = new URL(prevRequest.url);
                requestUrl.searchParams.set("since_id", cachedTweetResponse.meta.newest_id);
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
      stats.misses++;
      stats.fetched += data.meta.result_count; // count fetched tweets

      await redisClient.set(search, JSON.stringify(data), "EX", config.cache.ttlMax);
    } else if (cacheStatus === "hit") {
      stats.hits++;
    } else if (cacheStatus === "more") {
      stats.misses++;

      if (cachedTweetResponse === null) {
        throw new Error("Cached data is null when trying to merge with new data!");
      }

      if (data.meta.result_count) {
        stats.fetched += data.meta.result_count; // count fetched tweets
        stats.retained += 50 - data.meta.result_count; // count retained tweets

        data = mergeMore(cachedTweetResponse, data);

        await redisClient.set(search, JSON.stringify(data), "EX", config.cache.ttlMax);
      } else {
        data = cachedTweetResponse;

        await redisClient.expire(search, config.cache.ttlMax);
      }
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

      if (error.response.status === 400) {
        return { data: { data: [], meta: { result_count: 0 } }, status: 200, cacheStatus: "miss" };
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
  const tenant = await getTenant(c);

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
  if (++stats.requests % 50 === 0) {
    const cacheRatio = Math.floor((stats.hits / (stats.hits + stats.misses)) * 100) || 0;
    const retainRatio = Math.floor((stats.retained / (stats.fetched + stats.retained)) * 100) || 0;

    console.log(
      `📦 Cache: redis ${redisClient.status}, misses ${stats.misses}, hits ${stats.hits} (${cacheRatio}%), size ${await redisClient.dbsize()}, ttl: ${config.cache.ttl} (${config.cache.ttlMax} max)`,
    );

    console.log(
      `📊 Tweets: fetched ${stats.fetched}, retained ${stats.retained} (${retainRatio}%), total ${stats.fetched + stats.retained} requested`,
    );

    // console.log(
    //   `🔑 Api keys in use: ${JSON.stringify(Object.keys(pendingTokens).map((tenant) => [tenant, Object.values(pendingTokens[tenant])]))}`,
    // );

    if (invalidTokens.size > 0) {
      console.log(`🚫 Invalid tokens: ${JSON.stringify(Array.from(invalidTokens.keys()), null, 2)}`);
    }
  }
};
