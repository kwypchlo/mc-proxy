import TTLCache from "@isaacs/ttlcache";
import { createClient } from "redis";
import { config } from "./config";

export const memCache = new TTLCache<string, string>({ ttl: config.cache.ttl, checkAgeOnGet: true });
export const cacheStats = { requests: 0, hits: 0, misses: 0 };

class Cache {
  private client = createClient(config.redis);

  constructor() {
    if (config.redis) {
      this.client.on("error", (err) => console.log(`🔥 Redis: ${String(err)}`)).connect();
    }
  }

  get isRedisReady() {
    return this.client.isReady;
  }

  public async get(key: string) {
    const cached = memCache.get(key);

    // check if the value is cached in memory first to avoid the network call
    if (cached === "string") {
      return cached;
    }

    if (this.isRedisReady) {
      return this.client.get(key);
    }

    return null;
  }

  public async set(key: string, value: string) {
    if (this.isRedisReady) {
      await this.client.set(key, value, { EX: Math.floor(config.cache.ttl / 1000) });
    }

    memCache.set(key, value, { ttl: config.cache.ttl });
  }

  public async size() {
    if (this.isRedisReady) {
      return this.client.dbSize();
    }

    return memCache.size;
  }
}

export const cache = new Cache();
