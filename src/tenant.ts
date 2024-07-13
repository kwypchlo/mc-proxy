import type { Context } from "hono";
import { getConnInfo } from "hono/bun";
import { config, type Config } from "./config";
import { HTTPException } from "hono/http-exception";
import { shuffle } from "lodash-es";

export const invalidTokens = new Map();
export const pendingTokens = {} as Record<string, { [token: string]: number }>;

export const getTenant = (c: Context) => {
  const connInfo = getConnInfo(c);

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

  if (tenant.tokens.every((token) => invalidTokens.has(token))) {
    throw new HTTPException(403, { message: `All tokens are invalid for tenant ${tenant.name}` });
  }

  return tenant;
};

export const useNextToken = (tenant: Config["tenants"][number]) => {
  const tokens = shuffle(tenant.tokens.filter((token) => invalidTokens.has(token) === false));
  let selected = tokens[0];

  for (const token of tokens) {
    if (!(tenant.name in pendingTokens)) {
      pendingTokens[tenant.name] = {};
    }

    if (!(token in pendingTokens[tenant.name])) {
      pendingTokens[tenant.name][token] = 0;
    }

    if (pendingTokens[tenant.name][token] < pendingTokens[tenant.name][selected]) {
      selected = token;
    }
  }

  pendingTokens[tenant.name][selected]++;

  return {
    token: selected,
    pendingCount: pendingTokens[tenant.name][selected] - 1,
    releaseToken: () => {
      pendingTokens[tenant.name][selected]--;
    },
  };
};
