import ky, { HTTPError } from "ky";
import { cache, cacheStats } from "../cache";
import { config } from "../config";
import { getTenant, invalidTokens, useNextToken, pendingTokens } from "../tenant";
import type { Context, Next } from "hono";
import ms from "pretty-ms";
import type { StatusCode } from "hono/utils/http-status";
import { rand } from "../utils";

const tweets = async (
  search: string,
  tenant: (typeof config.tenants)[number],
): Promise<{ data: any; status: StatusCode }> => {
  let currentToken: null | ReturnType<typeof useNextToken> = null;
  let cacheStatus: "miss" | "hit" = "miss";

  try {
    const data = await ky("https://api.twitter.com/2/tweets/search/all", {
      searchParams: search,
      headers: { "user-agent": "v2FullArchiveSearchPython" },
      retry: { limit: 10, delay: () => rand(1000, 1500) },
      timeout: 15 * 1000, // 15 seconds timeout
      hooks: {
        beforeRequest: [
          async (request) => {
            if (currentToken !== null) {
              currentToken.releaseToken();
              currentToken = null;
            }

            const cached = await cache.get(search);
            if (typeof cached === "string") {
              cacheStatus = "hit";
              return Response.json(JSON.parse(cached));
            }

            currentToken = useNextToken(tenant);

            request.headers.set("authorization", `Bearer ${currentToken.token}`);
          },
        ],
      },
    }).json();

    if (cacheStatus === "miss") {
      cacheStats.misses++;
      await cache.set(search, JSON.stringify(data));
    } else if (cacheStatus === "hit") {
      cacheStats.hits++;
    }

    return { data, status: 200 };
  } catch (error) {
    const usedToken = currentToken === null ? null : (currentToken as ReturnType<typeof useNextToken>).token;

    if (error instanceof HTTPError) {
      console.log(`[Twitter Api HTTPError] (${tenant.name}) ${error.response.status}  ${error.response.statusText}`);

      if (usedToken !== null && [401, 403].includes(error.response.status)) {
        invalidTokens.set(usedToken, true);
      }

      return { data: undefined, status: error.response.status as StatusCode };
    }

    console.log(`[Error] (${tenant.name}) ${String(error)}`);

    return { data: undefined, status: 500 };
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
  const { data, status } = await tweets(search, tenant);

  console.log(
    `${status} (${tenant.name}) ${ms(performance.now() - start, {}).padEnd(5)} ${status === 200 ? `${searchParams.get("query")}` : search}`,
  );

  return c.json(data, status);
};

export const proxyApiMiddleware = async (c: Context, next: Next) => {
  await next();

  // print cache stats every 50 handled requests
  if (++cacheStats.requests % 50 === 0) {
    const ratio = Math.floor((cacheStats.hits / (cacheStats.hits + cacheStats.misses)) * 100) || 0;

    console.log(
      `📦 Cache: redis ${cache.isRedisReady ? "ok" : "no"}, misses ${cacheStats.misses}, hits ${cacheStats.hits} (${ratio}%), size ${await cache.size()}, ttl: ${config.cache.ttl}`,
    );

    console.log(
      `🔑 Usage: ${JSON.stringify(Object.keys(pendingTokens).map((tenant) => [tenant, Object.values(pendingTokens[tenant])]))}`,
    );

    if (invalidTokens.size > 0) {
      console.log(`🚫 Invalid tokens: ${JSON.stringify(Array.from(invalidTokens.keys()), null, 2)}`);
    }
  }
};
