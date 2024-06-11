import ky, { HTTPError } from "ky";
import { cache, cacheStats } from "../cache";
import { config } from "../config";
import { getTenant } from "../tenant";
import type { Context, Next } from "hono";
import ms from "pretty-ms";

const rand = (min: number, max: number): number => {
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

const invalid = new Map();

const tweets = async (search: string, tenant: (typeof config.tenants)[number]): Promise<any> => {
  const cached = cache.get(search);
  if (cached instanceof Promise) {
    const { status } = await cached;

    if (status === 200) {
      cacheStats.hits++;
      return cached;
    }
  }

  const tokens = tenant.tokens.filter((token) => invalid.has(token) === false);
  const token = tokens[cacheStats.misses++ % tokens.length];
  const promise = new Promise(async (resolve) => {
    try {
      const data = await ky("https://api.twitter.com/2/tweets/search/all", {
        searchParams: search,
        headers: {
          authorization: `Bearer ${token}`,
          "user-agent": "v2FullArchiveSearchPython",
        },
        retry: { limit: 20, delay: () => rand(1000, 2000) },
      }).json();

      cache.setTTL(search, config.cache.ttl);

      return resolve({ data, status: 200 });
    } catch (error) {
      cache.delete(search);

      if (error instanceof HTTPError) {
        console.log(
          `[Twitter Api HTTPError] (${tenant.name} ${token.slice(-5)}) ${error.response.status}  ${error.response.statusText}`,
        );

        if (error.response.status === 403) {
          invalid.set(token, true);
        }

        return resolve({ data: undefined, status: error.response.status });
      }

      console.log(`[Error] (${tenant.name} ${token.slice(-5)}) ${String(error)}`);

      return resolve({ data: undefined, status: 500 });
    }
  });

  cache.set(search, promise, { ttl: config.cache.ttl });

  return promise;
};

export const proxyApi = async (c: Context) => {
  const start = performance.now();
  const tenant = getTenant(c);

  const { search } = new URL(c.req.url);
  const { data, status } = await tweets(search, tenant);

  console.log(`${status} (${tenant.name}) ${ms(performance.now() - start)} ${search}`);

  return c.json(data, status);
};

export const proxyApiMiddleware = async (c: Context, next: Next) => {
  await next();

  // print cache stats every 10 handled requests
  if (++cacheStats.requests % 10 === 0) {
    const ratio = Math.floor((cacheStats.hits / (cacheStats.hits + cacheStats.misses)) * 100) || 0;

    console.log(
      `📦 Cache: misses ${cacheStats.misses}, hits ${cacheStats.hits} (${ratio}%), size ${cache.size}, ttl: ${config.cache.ttl}`,
    );
  }
};
