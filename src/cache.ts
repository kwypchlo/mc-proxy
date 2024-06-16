import TTLCache from "@isaacs/ttlcache";
import { config } from "./config";

export const cache = new TTLCache<string, string>({ ttl: config.cache.ttl, checkAgeOnGet: true });
export const cacheStats = { requests: 0, hits: 0, misses: 0 };
