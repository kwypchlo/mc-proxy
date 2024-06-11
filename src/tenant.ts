import type { Context } from "hono";
import { getConnInfo } from "hono/bun";
import { config } from "./config";
import { HTTPException } from "hono/http-exception";

export const getTenant = (c: Context) => {
  const connInfo = getConnInfo(c);

  console.log("connInfo", connInfo);

  if (connInfo.remote.addressType !== "IPv4") {
    throw new HTTPException(400, { message: `Invalid address type: ${connInfo.remote.addressType}` });
  }

  const address = connInfo.remote.address;

  if (!address) {
    throw new HTTPException(400, { message: "Failed to get remote address" });
  }

  const tenant = config.tenants.find(({ servers }) => servers.includes(address));

  if (tenant === undefined) {
    throw new HTTPException(403, { message: `Tenant not found for remote address ${address}` });
  }

  if (tenant.tokens.length === 0) {
    throw new HTTPException(403, { message: `No tokens found for tenant ${tenant.name}` });
  }

  return tenant;

  //   if (tenant.tokens.every((token) => invalid.has(token))) {
  //     return c.json({ data: `Twitter Api Forbidden` }, 403);
  //   }
};
