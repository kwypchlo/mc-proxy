import { Hono } from "hono";
import { comaiApi } from "./api/comai";
import { statsApi } from "./api/stats";
import { proxyApi, proxyApiMiddleware } from "./api/proxy";

const app = new Hono();

app.use("/", proxyApiMiddleware);
app.get("/", proxyApi);
app.get("/stats", statsApi);
app.get("/coingecko/comai", comaiApi);

export default {
  hostname: "0.0.0.0",
  port: 3000,
  fetch: app.fetch,
};
