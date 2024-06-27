import Redis from "ioredis";
import { config } from "./config";

declare global {
  var redisClient: Redis;
}

const createClient = async (url: string) => {
  if ("redisClient" in globalThis) {
    return globalThis.redisClient;
  }
  return (globalThis.redisClient = new Redis(url, { enableAutoPipelining: true }));
};

export const redisClient = await createClient(config.redis.url);
