import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { Database } from "@tanmar/database";
import { AccessInputError } from "./access-input.ts";

// Shared ceilings are separate from the existing five-failed-PIN account lock.
// Count admitted attempts, successful logins and denials; never record credentials.
export const loginLimits = Object.freeze({ global: 300, client: 60, username: 30, seconds: 60 });

export function loginClient(request: Request, proxySecret = process.env.LOGIN_PROXY_SECRET): string | null {
  // A client-supplied forwarding/IP header is not evidence of the source address.
  // Without configured ingress, only global/username ceilings are available.
  if (!proxySecret) return null;
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(proxySecret))
    throw new AccessInputError("Login ingress unavailable.", 503);
  const supplied = request.headers.get("x-login-proxy-secret") || "";
  const ip = request.headers.get("x-login-client-ip") || "";
  const expectedBytes = Buffer.from(proxySecret), suppliedBytes = Buffer.from(supplied);
  if (expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes) || !isIP(ip))
    throw new AccessInputError("Login ingress unavailable.", 503);
  // Equivalent IPv6 spellings share a bucket. Plain X-Forwarded-For is ignored.
  return isIP(ip) === 6 ? new URL(`http://[${ip}]/`).hostname : ip;
}

// The explicit clock supports deterministic window/race tests, never HTTP input.
// The caller supplies the canonical selector used by its actual authentication mode.
export async function reserveLoginAttempt(store: Database, username: string, client: string | null,
  now = Math.floor(Date.now() / 1000), proxySecret = process.env.LOGIN_PROXY_SECRET): Promise<number> {
  const window = Math.floor(now / loginLimits.seconds), expiry = (window + 1) * loginLimits.seconds;
  const digest = (value: string) => proxySecret
    ? createHmac("sha256", proxySecret).update(value).digest("hex")
    : createHash("sha256").update(`tanmar-login:${value}`).digest("hex");
  const buckets: { key: string; limit: number }[] = [{ key: `global:${window}`, limit: loginLimits.global }];
  if (client) buckets.push({ key: `client:${window}:${digest(client)}`, limit: loginLimits.client });
  buckets.push({ key: `username:${window}:${digest(username)}`, limit: loginLimits.username });

  return store.transaction(async tx => {
    await tx.prepare("DELETE FROM app_login_rate_limits WHERE expires_at <= $1").bind(now).run();
    // Always take global, then client, then username. The global row serializes
    // reservations and bounds cardinality before arbitrary selectors allocate rows.
    for (const bucket of buckets) {
      const row = await tx.prepare(`INSERT INTO app_login_rate_limits (bucket_key,hits,expires_at)
        VALUES ($1,1,$2) ON CONFLICT (bucket_key) DO UPDATE
        SET hits=LEAST(app_login_rate_limits.hits+1,$3) RETURNING hits`)
        .bind(bucket.key, expiry, bucket.limit + 1).first<{ hits: number }>();
      if (!row) throw new Error("Login reservation unavailable.");
      // Return to COMMIT exhausted attempts. Throwing here would undo the limit.
      if (row.hits > bucket.limit) return expiry - now;
    }
    return 0;
  });
}

export async function guardLogin(request: Request, username: string, store: Database) {
  if (request.headers.get("sec-fetch-site") === "cross-site")
    throw new AccessInputError("Open the staff sign-in page directly.", 403);
  const client = loginClient(request);
  const retryAfter = await reserveLoginAttempt(store, username, client);
  return retryAfter ? Response.json({ error: "Too many sign-in attempts. Please try again shortly." }, {
    status: 429, headers: { "retry-after": String(retryAfter), "cache-control": "no-store" },
  }) : null;
}
