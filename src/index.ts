import { Hono } from "hono";
import ms from "pretty-ms";
import ky, { HTTPError } from "ky";
import chalk from "chalk";
import { config } from "./config";
import { cache } from "./cache";
import { getTenant } from "./tenant";

const cStatusCode = (code: number) => (code === 200 ? chalk.green(code) : chalk.red(code));
const cResTime = (time: number) => {
  if (time < 4000) return ms(time);
  if (time < 7000) return chalk.yellow(ms(time));
  if (time < 8000) return chalk.red(ms(time));
  return chalk.redBright(ms(time));
};
const cSearch = (search: string) => chalk.gray(search);
const rand = (min: number, max: number): number => {
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

if (config.tenants.length === 0) {
  throw new Error("Provide at least one tenant in the .config.json file");
}

const endpoint = "https://api.twitter.com/2/tweets/search/all";
const cacheStats = { requests: 0, hits: 0, misses: 0 };
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
      const data = await ky(endpoint, {
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

const app = new Hono();

app.get("/", async (c) => {
  const start = performance.now();
  const tenant = getTenant(c);

  // print cache stats every 10 requests
  if (cacheStats.requests++ % 10 === 0) {
    const ratio = Math.floor((cacheStats.hits / (cacheStats.hits + cacheStats.misses)) * 100) || 0;

    console.log(
      `📦 Cache: misses ${cacheStats.misses}, hits ${cacheStats.hits} (${ratio}%), size ${cache.size}, ttl: ${config.cache.ttl}`,
    );
  }

  const { search } = new URL(c.req.url);
  const { data, status } = await tweets(search, tenant);

  console.log(`${cStatusCode(status)} (${tenant.name}) ${cResTime(performance.now() - start)} ${cSearch(search)}`);

  return c.json(data, status);
});

app.get("/stats", async (c) => {
  return c.json({
    ...cacheStats,
    ratio: `${Math.floor((cacheStats.hits / (cacheStats.hits + cacheStats.misses)) * 100) || 0}%`,
    size: cache.size,
    ttl: config.cache.ttl,
  });
});

app.get("/coingecko/comai", async (c) => {
  if (!config.coingeckoApiKey) {
    return c.json({ message: "Missing COINGECKO_API_KEY" }, 500);
  }

  if (cache.has("coingecko-comai")) {
    return c.json(cache.get("coingecko-comai"));
  }

  const data = await (
    await fetch("https://api.coingecko.com/api/v3/coins/commune-ai", {
      method: "GET",
      headers: {
        accept: "application/json",
        "x-cg-api-key": config.coingeckoApiKey,
      },
    })
  ).json();

  cache.set("coingecko-comai", data, { ttl: 10 * 60 * 1000 }); // ttl 10 minutes

  return c.json(data);
});

export default {
  hostname: "0.0.0.0",
  port: 3000,
  fetch: app.fetch,
};
