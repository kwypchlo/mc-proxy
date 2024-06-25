import redis from "redis";
import { config } from "./config.ts";

// Create a Redis client
const client = redis.createClient(config.redis);

client.on("error", (err) => console.log("Redis Client Error", err));

await client.connect();

// Lua script
const luaScript = `
        local namespace = redis.call('HGETALL', KEYS[1])

        return namespace
    `;

try {
  // Execute the Lua script with the key 'api_key_usage'
  const result = await client.eval(luaScript, { keys: ["api_key_usage"], arguments: [] });

  console.log("The least used key is:", result);
} catch (err) {
  console.error("Error executing Lua script:", err);
} finally {
  await client.quit();
}
