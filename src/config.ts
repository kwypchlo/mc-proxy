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
    ttl: z.number().default(60000),
  }),
});

export const config = configSchema.parse(configJson);