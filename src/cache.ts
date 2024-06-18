import TTLCache from "@isaacs/ttlcache";
import { createClient } from "redis";
import { config } from "./config";

export const memCache = new TTLCache<string, string>({ ttl: config.cache.ttl, checkAgeOnGet: true });
export const cacheStats = { requests: 0, hits: 0, misses: 0 };

class Cache {
  public redisClient = createClient(config.redis);

  constructor() {
    if (config.redis) {
      this.redisClient.on("error", (err) => console.log(`🔥 Redis: ${String(err)}`)).connect();
    }
  }

  public async get(key: string) {
    if (this.redisClient.isReady) {
      return this.redisClient.get(key);
    }

    return memCache.get(key) ?? null;
  }

  public async set(key: string, value: string) {
    if (this.redisClient.isReady) {
      try {
        await this.redisClient.set(key, value, { EX: Math.floor(config.cache.ttl / 1000) });
      } catch (err) {
        console.log(`🔥 Redis: ${String(err)}`);
      }
    } else {
      memCache.set(key, value, { ttl: config.cache.ttl });
    }
  }

  public async size() {
    if (this.redisClient.isReady) {
      return this.redisClient.dbSize();
    }

    return memCache.size;
  }
}

export const cache = new Cache();
