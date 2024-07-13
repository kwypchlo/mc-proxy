import Redis from "ioredis";
import { env } from "./env";

declare global {
  var redisClient: Redis;
  var redisSubscriber: Redis;
}

const createClient = async (url: string) => {
  if ("redisClient" in globalThis) {
    return globalThis.redisClient;
  }
  return (globalThis.redisClient = new Redis(url, { enableAutoPipelining: true }));
};

const createSubscriber = async (url: string) => {
  if ("redisSubscriber" in globalThis) {
    return globalThis.redisSubscriber;
  }
  const redisSubscriber = (globalThis.redisSubscriber = new Redis(url, { enableAutoPipelining: true }));

  // ensure keyspace events are enabled and configured to send events for all key types
  await redisSubscriber.config("SET", "notify-keyspace-events", "KEA");

  console.log("Subscribing to keyspace events");

  return redisSubscriber;
};

export const redisClient = await createClient(env.REDIS_URL);
export const redisSubscriber = await createSubscriber(env.REDIS_URL);

redisSubscriber.removeAllListeners(); // reset event listeners to avoid memory leaks on hot reload
