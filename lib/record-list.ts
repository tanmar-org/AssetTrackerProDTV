import { createHash } from "node:crypto";

// Both Node apps use the same bounded listing contract. Filters are data, never
// SQL fragments, upstream destinations or credentials. Cursors grant no access.
export class ListingInputError extends Error {}
type Kind = "requests" | "activity" | "operations";
export type RecordList = {
  limit: number; q: string; status: string; type: string; from: string; through: string;
  fingerprint: string; after: { time: string; id: string } | null;
};
const invalid = (): never => { throw new ListingInputError("Invalid list filters or page cursor. Refresh the list."); };

export function readRecordList(url: URL, kind: Kind): RecordList {
  const params = url.searchParams;
  const allowed = ["limit", "q", "cursor", ...(kind === "activity" ? ["type", "from", "through"] : ["status"])];
  if (url.search.length > 4096) invalid();
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) invalid();
  const limitText = params.get("limit") ?? "100";
  if (!/^(?:[1-9][0-9]?|100)$/.test(limitText)) invalid();
  const q = (params.get("q") ?? "").trim();
  if (q.length > 128 || /[\x00-\x1f\x7f]/.test(q)) invalid();
  const status = params.get("status") ?? "all", type = params.get("type") ?? "all";
  if (!(kind === "operations" ? ["all","active","pending","blocked","needs_review","done","failed"] : ["all", "Pending", "Completed", "Cancelled"]).includes(status) || !["all", "data", "user", "denied"].includes(type)) invalid();
  const from = params.get("from") ?? "", through = params.get("through") ?? "";
  for (const value of [from, through]) if (value &&
    (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)) invalid();
  if (from && through && from >= through) invalid();
  const limit = Number(limitText);
  // Bind navigation to the exact filters/page size, preventing accidental reuse
  // after filters change. Authentication still applies to every forged cursor.
  const fingerprint = createHash("sha256").update(JSON.stringify([kind, limit, q, status, type, from, through])).digest("hex");
  let after: RecordList["after"] = null;
  const cursor = params.get("cursor");
  if (cursor !== null) {
    if (!/^[A-Za-z0-9_-]{1,1024}$/.test(cursor)) invalid();
    let decoded;
    try { decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { invalid(); }
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded) || Object.keys(decoded).sort().join(",") !== "f,id,t,v" ||
      decoded.v !== 1 || decoded.f !== fingerprint || typeof decoded.t !== "string" || !decoded.t || decoded.t.length > 64 ||
      typeof decoded.id !== "string" || !decoded.id || decoded.id.length > 256 || /[\x00-\x1f\x7f]/.test(decoded.t + decoded.id)) invalid();
    after = { time: decoded.t, id: decoded.id };
  }
  return { limit, q, status, type, from, through, fingerprint, after };
}

// Escape SQL wildcard characters so search means a literal substring. Queries
// additionally bind all values separately through the PostgreSQL facade.
export function literalSearch(value: string) { return `%${value.replace(/[\\%_]/g, "\\$&")}%`; }

export function recordPage<T extends { id: string }>(rows: T[], list: RecordList, time: (row: T) => string) {
  const records = rows.slice(0, list.limit), last = records.at(-1);
  const nextCursor = rows.length > list.limit && last ? Buffer.from(JSON.stringify({
    v: 1, f: list.fingerprint, t: time(last), id: last.id,
  })).toString("base64url") : null;
  return { records, page: { limit: list.limit, nextCursor } };
}
