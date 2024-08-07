import type { Context } from "hono";
import { config } from "../config";

export const comaiApi = async (c: Context) => {
  if (!config.coingeckoApiKey) {
    return c.json({ message: "Missing COINGECKO_API_KEY" }, 500);
  }

  const cached = await redisClient.get("coingecko:comai");
  if (cached) return c.json(JSON.parse(cached));

  const data = await (
    await fetch("https://api.coingecko.com/api/v3/coins/commune-ai", {
      method: "GET",
      headers: {
        accept: "application/json",
        "x-cg-api-key": config.coingeckoApiKey,
      },
    })
  ).json();

  await redisClient.set("coingecko:comai", JSON.stringify(data), "EX", 10 * 60); // cache for 10 minutes

  return c.json(data);
};
