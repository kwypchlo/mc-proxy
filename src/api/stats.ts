import type { Context } from "hono";
import { cache, cacheStats } from "../cache";
import { config } from "../config";

export const statsApi = async (c: Context) => {
  const cacheRatio = Math.floor((cacheStats.hits / (cacheStats.hits + cacheStats.misses)) * 100) || 0;
  const retainRatio = Math.floor((cacheStats.retained / (cacheStats.fetched + cacheStats.retained)) * 100) || 0;

  return c.json({
    ...cacheStats,
    ratio: `${cacheRatio}%`,
    retainRatio: `${retainRatio}%`,
    size: cache.size,
    ttl: config.cache.ttl,
  });
};
