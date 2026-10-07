import { createHmac, timingSafeEqual } from "node:crypto";
import { AccessInputError } from "./access-input.ts";
import { canonicalAdUsername, canonicalGuid, type AdConfiguration, type AdIdentity } from "./ad-auth.ts";

export const enrollmentLifetimeMs = 5 * 60 * 1000;
type Actor = { id: string; context: string };
type Confirmation = {
  version: 1; actor: Actor; targetUserId: string | null; directory: string; binding: string;
  guid: string; username: string; displayName: string; issuedAt: number; expiresAt: number;
};
const reviewAgain = () => new AccessInputError("Find and review the AD user again before granting access.", 409);
function signature(payload: string, env = process.env) {
  const secret = env.ADMIN_SHARED_SECRET;
  if (!secret || !/^[A-Za-z0-9_-]{32,128}$/.test(secret))
    throw new AccessInputError("Directory account management unavailable.", 503);
  // Derive a separate purpose key from existing protected runtime material.
  // This proof is neither a login credential nor usable by another admin/session.
  const key = createHmac("sha256", secret).update("tanmar-ad-enrollment-key:v1").digest();
  return createHmac("sha256", key).update(payload).digest();
}
export function issueAdConfirmation(identity: AdIdentity, actor: Actor, config: AdConfiguration,
  targetUserId: string | null = null, now = Date.now(), env = process.env) {
  const confirmation: Confirmation = { version: 1, actor, targetUserId, directory: config.id, binding: config.binding,
    guid: identity.guid, username: identity.username, displayName: identity.displayName || identity.username,
    issuedAt: now, expiresAt: now + enrollmentLifetimeMs };
  const payload = Buffer.from(JSON.stringify(confirmation)).toString("base64url");
  return `${payload}.${signature(payload, env).toString("base64url")}`;
}
export function readAdConfirmation(value: unknown, actor: Actor, config: AdConfiguration,
  targetUserId: string | null, now = Date.now(), env = process.env): Confirmation {
  // Leave room for the other enrollment fields inside the 4-KiB JSON bound.
  if (typeof value !== "string" || value.length > 3500 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)) throw reviewAgain();
  const [payload, mac] = value.split("."), supplied = Buffer.from(mac, "base64url");
  if (supplied.length !== 32 || !timingSafeEqual(signature(payload, env), supplied)) throw reviewAgain();
  let parsed: Confirmation;
  try { parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { throw reviewAgain(); }
  if (!parsed || parsed.version !== 1 || parsed.actor?.id !== actor.id || parsed.actor?.context !== actor.context ||
      parsed.targetUserId !== targetUserId || parsed.directory !== config.id || parsed.binding !== config.binding ||
      !Number.isSafeInteger(parsed.issuedAt) || parsed.issuedAt > now || parsed.expiresAt !== parsed.issuedAt + enrollmentLifetimeMs ||
      now >= parsed.expiresAt || !canonicalAdUsername(parsed.username) || canonicalAdUsername(parsed.username) !== parsed.username ||
      typeof parsed.displayName !== "string" || parsed.displayName.length > 256 || /[\x00-\x1f]/.test(parsed.displayName)) throw reviewAgain();
  try { if (canonicalGuid(parsed.guid) !== parsed.guid) throw reviewAgain(); } catch { throw reviewAgain(); }
  return parsed;
}
