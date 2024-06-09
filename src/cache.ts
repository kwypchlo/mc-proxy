import TTLCache from "@isaacs/ttlcache";
import { config } from "./config";

export const cache = new TTLCache<string, Promise<any>>({ ttl: config.cache.ttl, checkAgeOnGet: true });
