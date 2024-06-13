import ky, { HTTPError } from "ky";
import { cache, cacheStats } from "../cache";
import { config } from "../config";
import { getTenant } from "../tenant";
import type { Context, Next } from "hono";
import ms from "pretty-ms";
import { shuffle } from "lodash-es";
import { HTTPException } from "hono/http-exception";

const invalid = new Map();
const usage = {} as Record<string, { [token: string]: number }>;

const rand = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1) + min);
const useNextToken = (tenant: (typeof config.tenants)[number]) => {
  const tokens = shuffle(tenant.tokens.filter((token) => invalid.has(token) === false));
  let selected = tokens[0];

  for (const token of tokens) {
    if (!(tenant.name in usage)) {
      usage[tenant.name] = {};
    }

    if (!(token in usage[tenant.name])) {
      usage[tenant.name][token] = 0;
    }

    if (usage[tenant.name][token] < usage[tenant.name][selected]) {
      selected = token;
    }
  }

  usage[tenant.name][selected]++;

  return {
    token: selected,
    releaseToken: () => {
      usage[tenant.name][selected]--;
    },
  };
};

const tweets = async (search: string, tenant: (typeof config.tenants)[number]): Promise<any> => {
  if (tenant.tokens.every((token) => invalid.has(token))) {
    throw new HTTPException(403, { message: `All tokens are invalid for tenant ${tenant.name}` });
  }

  const cached = cache.get(search);
  if (cached instanceof Promise) {
    const { status } = await cached;

    if (status === 200) {
      cacheStats.hits++;
      return cached;
    }
  }

  cacheStats.misses++;

  const promise = new Promise(async (resolve) => {
    let currentToken: null | ReturnType<typeof useNextToken> = null;

    try {
      const data = await ky("https://api.twitter.com/2/tweets/search/all", {
        searchParams: search,
        headers: { "user-agent": "v2FullArchiveSearchPython" },
        retry: { limit: 10, delay: () => rand(1000, 2000) },
        timeout: 15 * 1000, // 15 seconds timeout
        hooks: {
          beforeRequest: [
            async (request) => {
              if (currentToken !== null) {
                currentToken.releaseToken();
              }

              currentToken = useNextToken(tenant);

              request.headers.set("authorization", `Bearer ${currentToken.token}`);
            },
          ],
        },
      }).json();

      if (currentToken !== null) {
        (currentToken as ReturnType<typeof useNextToken>).releaseToken();
        currentToken = null;
      }

      cache.setTTL(search, config.cache.ttl);

      return resolve({ data, status: 200 });
    } catch (error) {
      const usedToken = currentToken === null ? null : (currentToken as ReturnType<typeof useNextToken>).token;

      if (currentToken !== null) {
        (currentToken as ReturnType<typeof useNextToken>).releaseToken();
        currentToken = null;
      }

      cache.delete(search);

      if (error instanceof HTTPError) {
        console.log(`[Twitter Api HTTPError] (${tenant.name}}) ${error.response.status}  ${error.response.statusText}`);

        if (usedToken !== null && [401, 403].includes(error.response.status)) {
          invalid.set(usedToken, true);
        }

        return resolve({ data: undefined, status: error.response.status });
      }

      console.log(`[Error] (${tenant.name}) ${String(error)}`);

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

    console.log(
      `🔑 Usage: ${JSON.stringify(Object.keys(usage).map((tenant) => [tenant, Object.values(usage[tenant])]))}`,
    );

    if (invalid.size > 0) {
      console.log(`🚫 Invalid tokens: ${JSON.stringify(Array.from(invalid.keys()), null, 2)}`);
    }
  }
};
