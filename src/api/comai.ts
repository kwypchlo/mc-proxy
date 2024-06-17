import type { Context } from "hono";
import { config } from "../config";
import TTLCache from "@isaacs/ttlcache";

const memCache = new TTLCache<string, string>({ ttl: 10 * 60 * 1000, checkAgeOnGet: true }); // ttl 10 minutes

export const comaiApi = async (c: Context) => {
  if (!config.coingeckoApiKey) {
    return c.json({ message: "Missing COINGECKO_API_KEY" }, 500);
  }

  if (memCache.has("coingecko-comai")) {
    return c.json(memCache.get("coingecko-comai"));
  }

  const data = await (
    await fetch("https://api.coingecko.com/api/v3/coins/commune-ai", {
      method: "GET",
      headers: {
        accept: "application/json",
        "x-cg-api-key": config.coingeckoApiKey,
      },
    })
  ).json();

  memCache.set("coingecko-comai", data);

  return c.json(data);
};
