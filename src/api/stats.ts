import type { Context } from "hono";
import { cache, cacheStats } from "../cache";
import { config } from "../config";

export const statsApi = async (c: Context) => {
  return c.json({
    ...cacheStats,
    ratio: `${Math.floor((cacheStats.hits / (cacheStats.hits + cacheStats.misses)) * 100) || 0}%`,
    size: cache.size,
    ttl: config.cache.ttl,
  });
};
