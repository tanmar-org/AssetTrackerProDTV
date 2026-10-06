import { createHash } from "node:crypto";

// Synthetic test cookies only. Production JS receives this non-bearer context
// from the auth API; the real HttpOnly token remains inaccessible to the UI.
export function sessionHeaders(cookie) {
  if (!cookie) return {};
  const token = cookie.split("=")[1];
  return { "x-tracker-session-context": createHash("sha256").update(`tanmar-browser-session:${token}`).digest("hex") };
}
