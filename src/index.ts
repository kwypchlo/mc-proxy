import { Hono } from "hono";
import ky, { HTTPError } from "ky";
import TTLCache from "@isaacs/ttlcache";
import config from "../.config.json";

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

if (config.apiTokens.length < 3) {
  throw new Error("Provide all the required API tokens in the .env.json file");
}

const apiTokens = config.apiTokens;
const ttl = 60_000; // 60 seconds max age
const endpoint = "https://api.twitter.com/2/tweets/search/all";

const cache = new TTLCache<string, Promise<any>>({ ttl });
const cacheStats = { hits: 0, misses: 0 };

const tweets = async (search: string): Promise<any> => {
  if (cache.has(search)) {
    cacheStats.hits++;
    return cache.get(search);
  }

  const promise = new Promise(async (resolve) => {
    try {
      const data = await ky(endpoint, {
        searchParams: search,
        headers: {
          authorization: `Bearer ${apiTokens[cacheStats.misses++ % apiTokens.length]}`,
          "user-agent": "v2FullArchiveSearchPython",
        },
        retry: { limit: 20, delay: () => rand(1000, 2000) },
      }).json();

      cache.setTTL(search, ttl);

      return resolve({ data, status: 200 });
    } catch (error) {
      cache.delete(search);

      if (error instanceof HTTPError) {
        console.log("\t", "[Twitter Api HTTPError]", error.response.status, error.response.statusText);

        return resolve({ data: undefined, status: error.response.status });
      }

      console.log("\t", "[Error]", String(error));

      return resolve({ data: undefined, status: 500 });
    }
  });

  cache.set(search, promise);

  return promise;
};

const app = new Hono();

app.get("/", async (c) => {
  const { search } = new URL(c.req.url);
  const { data, status } = await tweets(search);

  console.log(`GET [status: ${status}] ${search}`);

  if ((cacheStats.hits + cacheStats.misses) % 1 === 0) {
    const ratio = Math.floor((cacheStats.hits / (cacheStats.hits + cacheStats.misses)) * 100) || 0;

    console.log(`📦 Cache: misses ${cacheStats.misses}, hits ${cacheStats.hits} (${ratio}%), size ${cache.size}`);
  }

  return c.json(data, status);
});

export default app;
