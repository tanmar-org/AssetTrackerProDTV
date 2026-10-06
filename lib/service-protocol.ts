import { createHash } from "node:crypto";
import { AccessInputError } from "./access-input.ts";

export type ServiceCommand = {
  operationId: string; id: string; kind: "status" | "delete";
  expectedVersion: number; status: "Pending" | "Completed" | "Cancelled" | null; notes: string;
};
export type ServiceSnapshot = {
  id: string; assetId: string | null; assetNumber: string; action: string; status: string; notes: string;
  requestedAt: string; completedAt: string | null; version: number;
  accountNumber: string; accountName: string; errorCode: string; operatorName: string;
  requesterName: string; requesterPhone: string; rigFrac: string; lease: string; mapUrl: string; gpsAccuracy: number;
};
export type ServiceReceipt = {
  operationId: string; requestId: string; fingerprint: string; outcome: "applied" | "rejected";
  reason: "" | "version_conflict" | "not_found" | "pending_conflict";
  appliedAt: string; deleted: boolean; request: ServiceSnapshot | null;
};
export const validServiceId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
export const validOperationId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);

// The immutable command is the idempotency identity. Never accept a reused UUID
// for different fields, and never derive business changes from client metadata.
export function serviceCommand(body: Record<string, unknown>): ServiceCommand {
  const allowed = ["operationId","id","kind","expectedVersion","status","notes"];
  if (Object.keys(body).some(key => !allowed.includes(key)) || !validOperationId(body.operationId) || !validServiceId(body.id) ||
    !["status","delete"].includes(body.kind as string) || !Number.isInteger(body.expectedVersion) ||
    (body.expectedVersion as number) < 1 || (body.expectedVersion as number) >= 2147483647)
    throw new AccessInputError("Reload requests and use a valid operation ID and request version.");
  if (body.kind === "status" && !["Pending","Completed","Cancelled"].includes(body.status as string) ||
    body.kind === "delete" && body.status !== undefined && body.status !== null)
    throw new AccessInputError("Choose a valid service status.");
  const notes = body.notes === undefined ? "" : body.notes;
  if (typeof notes !== "string" || notes.length > 2048 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(notes))
    throw new AccessInputError("Notes must be text of at most 2048 characters.");
  return { operationId: (body.operationId as string).toLowerCase(), id: body.id as string, kind: body.kind as ServiceCommand["kind"],
    expectedVersion: body.expectedVersion as number, status: body.kind === "delete" ? null : body.status as ServiceCommand["status"], notes };
}
export function serviceFingerprint(command: ServiceCommand) {
  return createHash("sha256").update(JSON.stringify([command.id,command.kind,command.expectedVersion,command.status,command.notes])).digest("hex");
}

// Project only bounded, authoritative request fields used in tracker history.
// Existing/imported rows must pass the same event schema before a QR write starts.
export function serviceSnapshot(value: unknown): ServiceSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AccessInputError("Invalid internal request snapshot.");
  const row = value as Record<string, unknown>;
  if (!validServiceId(row.id) || row.assetId !== null && !validServiceId(row.assetId) || !Number.isInteger(row.version) ||
    (row.version as number) < 1 || !["Pending","Completed","Cancelled"].includes(row.status as string) ||
    typeof row.gpsAccuracy !== "number" || !Number.isFinite(row.gpsAccuracy) || row.gpsAccuracy < 0 || row.gpsAccuracy > 10000)
    throw new AccessInputError("Invalid internal request snapshot.");
  const result: Record<string, unknown> = { id: row.id, assetId: row.assetId, version: row.version, status: row.status, gpsAccuracy: row.gpsAccuracy };
  const fields: Record<string, number> = {assetNumber:128,action:128,notes:2048,requestedAt:64,accountNumber:128,accountName:256,
    errorCode:128,operatorName:120,requesterName:120,requesterPhone:40,rigFrac:256,lease:256,mapUrl:512};
  for (const [key,max] of Object.entries(fields)) {
    const text = row[key];
    if (typeof text !== "string" || text.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))
      throw new AccessInputError("Historical request metadata needs administrator reconciliation.");
    result[key] = text;
  }
  if (row.completedAt !== null && (typeof row.completedAt !== "string" || row.completedAt.length > 64))
    throw new AccessInputError("Invalid internal request snapshot.");
  const business = /^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,127}$/;
  let map: URL;
  try {map = new URL(result.mapUrl as string);} catch {throw new AccessInputError("Invalid internal request map.");}
  if(!business.test(result.assetNumber as string) || result.accountNumber && !business.test(result.accountNumber as string) ||
    !Number.isFinite(Date.parse(result.requestedAt as string)) || row.completedAt !== null && !Number.isFinite(Date.parse(row.completedAt as string)) ||
    map.protocol !== "https:" || map.username || map.password || map.port ||
    !(map.hostname === "maps.google.com" || ["google.com","www.google.com"].includes(map.hostname) && map.pathname.startsWith("/maps")))
    throw new AccessInputError("Historical request metadata needs administrator reconciliation.");
  result.completedAt = row.completedAt;
  return result as ServiceSnapshot;
}
