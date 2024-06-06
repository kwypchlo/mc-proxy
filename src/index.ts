import { Hono } from "hono";
import ky, { HTTPError } from "ky";
import TTLCache from "@isaacs/ttlcache";
import config from "../.config.json";

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

if (config.tenants.length === 0) {
  throw new Error("Provide at least one tenant in the .config.json file");
}

const ttl = config?.cache?.ttl ?? 60_000; // defaults to 60 seconds max age
const endpoint = "https://api.twitter.com/2/tweets/search/all";

const cache = new TTLCache<string, Promise<any>>({ ttl });
const cacheStats = { hits: 0, misses: 0 };

const tweets = async (search: string, tenant: (typeof config.tenants)[number]): Promise<any> => {
  if (tenant.tokens.length === 0) {
    return { data: `No tokens found for tenant ${tenant.name}`, status: 403 };
  }

  if (cache.has(search)) {
    cacheStats.hits++;
    return cache.get(search);
  }

  const currentMiss = cacheStats.misses++;
  const promise = new Promise(async (resolve) => {
    try {
      const data = await ky(endpoint, {
        searchParams: search,
        headers: {
          authorization: `Bearer ${tenant.tokens[currentMiss % tenant.tokens.length]}`,
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

const remoteAddr = (c: any): string | null => {
  try {
    const { address } = c.env.requestIP(c.req.raw);

    return address;
  } catch {
    return null;
  }
};

const app = new Hono();

app.get("/", async (c) => {
  const addr = remoteAddr(c);
  if (addr === null) return c.json({ data: "Failed to get remote address" }, 400);
  const tenant = config.tenants.find(({ servers }) => servers.includes(addr));
  if (tenant === undefined) return c.json({ data: `Tenant not found for remote address ${addr}`, status: 403 });

  const { search } = new URL(c.req.url);
  const { data, status } = await tweets(search, tenant);

  console.log(`GET [status: ${status}] (${tenant.name}) ${search}`);

  if ((cacheStats.hits + cacheStats.misses) % 10 === 0) {
    const ratio = Math.floor((cacheStats.hits / (cacheStats.hits + cacheStats.misses)) * 100) || 0;

    console.log(`📦 Cache: misses ${cacheStats.misses}, hits ${cacheStats.hits} (${ratio}%), size ${cache.size}`);
  }

  return c.json(data, status);
});

export default {
  hostname: "0.0.0.0",
  port: 3000,
  fetch: app.fetch,
};
