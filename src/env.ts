import { z } from "zod";

export const env = z
  .object({
    REDIS_URL: z.string().url(),
  })
  .parse(Bun.env);
