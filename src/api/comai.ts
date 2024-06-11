import type { Context } from "hono";
import { cache } from "../cache";
import { config } from "../config";

export const comaiApi = async (c: Context) => {
  if (!config.coingeckoApiKey) {
    return c.json({ message: "Missing COINGECKO_API_KEY" }, 500);
  }

  if (cache.has("coingecko-comai")) {
    return c.json(cache.get("coingecko-comai"));
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

  cache.set("coingecko-comai", data, { ttl: 10 * 60 * 1000 }); // ttl 10 minutes

  return c.json(data);
};
