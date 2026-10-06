import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { database } from "./database";
import { InputError, matchesSecret } from "./input";

type Bucket = { scope: string; value: string; seconds: number; limit: number };
const digest = (value: string) => {
  if (!process.env.ADMIN_SHARED_SECRET) throw new Error("Request credential is not configured.");
  return createHmac("sha256", process.env.ADMIN_SHARED_SECRET).update(value).digest("hex");
};

// Atomic PostgreSQL counters are shared by all QR processes. Expired buckets are
// removed on subsequent requests; no raw IP, label value, or contact is stored.
// Global ceilings also bound bucket cardinality when client IDs are unavailable.
async function consume(buckets: Bucket[]) {
  const now = Math.floor(Date.now() / 1000);
  const retryAfter = await database().transaction(async (store) => {
    await store.prepare("DELETE FROM request_rate_limits WHERE expires_at <= $1").bind(now).run();
    let waitSeconds = 0;
    for (const bucket of buckets) {
      const window = Math.floor(now / bucket.seconds);
      const key = `${bucket.scope}:${window}:${digest(bucket.value)}`;
      const result = await store.prepare(`INSERT INTO request_rate_limits (bucket_key, hits, expires_at)
        VALUES ($1, 1, $2) ON CONFLICT (bucket_key) DO UPDATE
        SET hits = LEAST(request_rate_limits.hits + 1, $3) RETURNING hits`)
        .bind(key, (window + 1) * bucket.seconds, bucket.limit + 1).first<{ hits: number }>();
      if (!result || result.hits > bucket.limit) waitSeconds = (window + 1) * bucket.seconds - now;
      // Stop after a denied global bucket so arbitrary selectors/headers cannot
      // allocate new per-client rows once the shared capacity is exhausted.
      if (waitSeconds) break;
    }
    return waitSeconds; // Commit denied attempts too; throwing here would reset counters.
  });
  if (retryAfter) {
    const error = new InputError("Too many requests. Please try again later.", 429);
    error.retryAfter = retryAfter;
    throw error;
  }
}

export async function guardPublic(request: Request, kind: "submit" | "lookup") {
  if (request.headers.get("sec-fetch-site") === "cross-site") throw new InputError("Open the receiver service form directly.", 403);
  const proxySecret = process.env.REQUEST_PROXY_SECRET;
  const buckets: Bucket[] = [
    { scope: `${kind}-minute`, value: "global", seconds: 60, limit: kind === "submit" ? 30 : 120 },
    { scope: `${kind}-hour`, value: "global", seconds: 3600, limit: kind === "submit" ? 200 : 1200 },
  ];
  // Never trust X-Forwarded-For from the internet. An optional dedicated proxy
  // secret authenticates a single overwritten client-IP header. When configured,
  // missing/forged headers fail closed; private staff APIs do not use this gate.
  if (proxySecret) {
    const ip = request.headers.get("x-request-client-ip") || "";
    if (!matchesSecret(request.headers.get("x-request-proxy-secret"), proxySecret) || !isIP(ip))
      throw new InputError("Service ingress unavailable.", 503);
    // Canonicalize IPv6 aliases; Node accepts compressed/expanded IPv6 spellings.
    const canonical = isIP(ip) === 6 ? new URL(`http://[${ip}]/`).hostname : ip;
    buckets.push({ scope: `${kind}-client`, value: canonical, seconds: kind === "submit" ? 600 : 60,
      limit: kind === "submit" ? 10 : 30 });
  }
  await consume(buckets);
}

export function guardAsset(id: string) {
  // Use the resolved immutable ID so old asset-number links and new ID links
  // cannot obtain separate budgets for the same receiver.
  return consume([{ scope: "submit-asset", value: id, seconds: 600, limit: 5 }]);
}
