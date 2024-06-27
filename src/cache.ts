import TTLCache from "@isaacs/ttlcache";
import { config } from "./config";
import { redisClient } from "./redis";

export const memCache = new TTLCache<string, string>({ ttl: config.cache.ttl, checkAgeOnGet: true });
export const cacheStats = { requests: 0, hits: 0, misses: 0, fetched: 0, retained: 0 };

class Cache {
  public async get(key: string) {
    if (redisClient.status === "ready") {
      return redisClient.get(key);
    }

    return memCache.get(key) ?? null;
  }

  public async ttl(key: string) {
    if (redisClient.status === "ready") {
      return redisClient.ttl(key);
    }

    // use ceil to round up milliseconds when converting to seconds
    // redis compat: return -2 when key not found or expired
    return Math.ceil(memCache.getRemainingTTL(key) / 1000) || -2;
  }

  public async expire(key: string, ttl: number) {
    if (redisClient.status === "ready") {
      try {
        await redisClient.expire(key, ttl);
      } catch (err) {
        console.log(`🔥 Redis: ${String(err)}`);
      }
    } else {
      memCache.setTTL(key, ttl * 1000);
    }
  }

  public async set(key: string, value: string, ttl?: number) {
    if (redisClient.status === "ready") {
      try {
        await redisClient.set(key, value, "EX", ttl ?? config.cache.ttl);
      } catch (err) {
        console.log(`🔥 Redis: ${String(err)}`);
      }
    } else {
      memCache.set(key, value, { ttl: (ttl ?? config.cache.ttl) * 1000 });
    }
  }

  public async size() {
    if (redisClient.status === "ready") {
      return redisClient.dbsize();
    }

    return memCache.size;
  }
}

export const cache = new Cache();
