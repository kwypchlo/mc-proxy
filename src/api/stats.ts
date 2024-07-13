import type { Context } from "hono";
import { stats } from "../stats";
import { getConfig } from "../config";
import { redisClient } from "../redis";

export const statsApi = async (c: Context) => {
  const config = await getConfig();
  const cacheRatio = Math.floor((stats.hits / (stats.hits + stats.misses)) * 100) || 0;
  const retainRatio = Math.floor((stats.retained / (stats.fetched + stats.retained)) * 100) || 0;

  return c.json({
    ...stats,
    ratio: `${cacheRatio}%`,
    retainRatio: `${retainRatio}%`,
    size: await redisClient.dbsize(),
    ttl: config.cache.ttl,
  });
};
