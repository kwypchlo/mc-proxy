import z from "zod";
import configJson from "../.config.json";

const configSchema = z.object({
  tenants: z.array(
    z.object({
      name: z.string().min(1),
      servers: z.array(z.string()).min(1),
      tokens: z.array(z.string()).min(1),
    }),
  ),
  cache: z.object({
    ttl: z.number().int().nonnegative().default(75), // default to 75 seconds
    ttlMax: z.number().int().nonnegative().default(900), // default to 15 minutes
  }),
  redis: z
    .object({
      url: z.string().url(),
    })
    .optional(),
  coingeckoApiKey: z.string().optional(),
});

export const config = configSchema.parse(configJson);
