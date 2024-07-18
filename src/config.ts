import z from "zod";
import { redisSubscriber } from "./redis";

const configSchema = z.object({
  tenants: z.array(
    z.object({
      name: z.string().min(1),
      ttl: z.number().int().nonnegative().optional(),
      servers: z.array(z.string()).min(1),
      tokens: z.array(z.string()).min(1),
    }),
  ),
  cache: z.object({
    ttl: z.number().int().nonnegative().default(75), // default to 75 seconds
    ttlMax: z.number().int().nonnegative().default(900), // default to 15 minutes
  }),
  coingeckoApiKey: z.string().optional(),
});

const getConfig = async () => {
  const configString = await redisClient.get("config");

  if (configString === null) {
    throw new Error("Config not found in redis");
  }

  const newConfig = await configSchema.parseAsync(JSON.parse(configString));

  console.log(
    `🔧 Config refreshed from redis [tenants: ${newConfig.tenants.map(({ name }) => name).join(", ")}], [ttl: ${newConfig.cache.ttl}, ttlMax: ${newConfig.cache.ttlMax}], [coingecko: ${Boolean(newConfig.coingeckoApiKey)}]`,
  );

  return newConfig;
};

export type Config = z.infer<typeof configSchema>;
export let config = await getConfig();

await redisSubscriber.subscribe("__keyspace@0__:config");

redisSubscriber.on("message", async (channel, message) => {
  if (channel === "__keyspace@0__:config") {
    config = await getConfig();
  }
});
