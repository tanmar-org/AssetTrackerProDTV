import { createHash, timingSafeEqual } from "node:crypto";

export class InputError extends Error {
  status: number;
  retryAfter?: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(data, { status, headers: { "cache-control": "no-store", ...headers } });

// This independently deployed application owns its parsing/auth boundary. Count
// bytes while streaming, not just Content-Length, before parsing an 8-KiB object.
export async function readBody(request: Request) {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
    throw new InputError("Send an application/json request.", 415);
  if (Number(request.headers.get("content-length")) > 8192) throw new InputError("Request is too large.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new InputError("Send a JSON object.");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0, contents = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) { await reader.cancel(); throw new InputError("Request is too large.", 413); }
      contents += decoder.decode(value, { stream: true });
    }
    contents += decoder.decode();
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError("Send valid UTF-8 JSON.");
  } finally { reader.releaseLock(); }
  let body: unknown;
  try { body = JSON.parse(contents); } catch { throw new InputError("Send valid JSON."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new InputError("Send a JSON object.");
  return body as Record<string, unknown>;
}

export function matchesSecret(actual: string | null, expected: string | undefined) {
  return Boolean(expected && actual && timingSafeEqual(createHash("sha256").update(actual).digest(),
    createHash("sha256").update(expected).digest()));
}

export function authorized(request: Request) {
  const secret = process.env.ADMIN_SHARED_SECRET;
  return matchesSecret(request.headers.get("authorization"), secret ? `Bearer ${secret}` : undefined);
}

export function failure(error: unknown, message: string) {
  // PostgreSQL/lookup errors can contain private values. Return fixed messages.
  return error instanceof InputError ? json({ error: error.message }, error.status,
    error.status === 429 ? { "retry-after": String(error.retryAfter ?? 60) } : {}) : json({ error: message }, 503);
}

export function fields(body: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(body).some((key) => !allowed.includes(key)))
    throw new InputError("Unsupported request fields. Reload the service form.");
}

export function text(value: unknown, label: string, max: number, required = true, multiline = false) {
  // Staff notes may contain tabs/newlines; single-line public contact/worksite
  // fields cannot use control characters to disguise their contents.
  const controls = multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/;
  if (typeof value !== "string" || value.length > max || controls.test(value) || (required && !value.trim()))
    throw new InputError(`${label} must be ${required ? "nonempty " : ""}text of at most ${max} characters.`);
  return value.trim();
}

export function selector(body: Record<string, unknown>) {
  const hasId = Object.hasOwn(body, "assetId"), hasNumber = Object.hasOwn(body, "assetNumber");
  if (hasId === hasNumber) throw new InputError("Scan a valid receiver label.");
  const value = hasId ? body.assetId : body.assetNumber;
  const pattern = hasId ? /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/ : /^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,127}$/;
  if (typeof value !== "string" || !pattern.test(value)) throw new InputError("Scan a valid receiver label.");
  return { key: hasId ? "id" : "a", value };
}

export function submission(body: Record<string, unknown>, now = Date.now()) {
  fields(body, ["assetId", "assetNumber", "requesterName", "requesterPhone", "operatorName", "rigFrac", "lease",
    "errorCode", "latitude", "longitude", "gpsAccuracy", "gpsCapturedAt"]);
  const asset = selector(body);
  const details = {
    requesterName: text(body.requesterName, "Requester name", 120), requesterPhone: text(body.requesterPhone, "Callback phone", 40),
    operatorName: text(body.operatorName, "Operator name", 120), rigFrac: text(body.rigFrac, "Rig/Frac", 120),
    lease: text(body.lease, "Lease", 120), errorCode: text(body.errorCode, "Error code", 80),
  };
  // GPS is a bounded, fresh client claim, not proof of a person's location. Reject
  // null/string coercion (formerly null became zero) and impossible coordinates.
  const latitude = body.latitude, longitude = body.longitude, accuracy = body.gpsAccuracy;
  if (typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180 ||
      typeof accuracy !== "number" || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 10000)
    throw new InputError("Share a valid GPS location.");
  const capturedAt = body.gpsCapturedAt;
  if (typeof capturedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(capturedAt) ||
      !Number.isFinite(Date.parse(capturedAt)) || new Date(capturedAt).toISOString() !== capturedAt ||
      Date.parse(capturedAt) < now - 15 * 60 * 1000 || Date.parse(capturedAt) > now + 5 * 60 * 1000)
    throw new InputError("Refresh your GPS location before submitting.");
  return { asset, ...details, latitude, longitude, gpsAccuracy: accuracy, gpsCapturedAt: capturedAt };
}
