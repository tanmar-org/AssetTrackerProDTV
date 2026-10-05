import { AccessInputError } from "./access-input.ts";

export type InventoryRecord = Record<string, unknown> & { id: string };
export type InventoryState = {
  master: InventoryRecord[]; accounts: InventoryRecord[]; assignments: InventoryRecord[];
  activations: InventoryRecord[]; receiverEvents: InventoryRecord[];
  auditState: Record<string, unknown> | null;
  rentalStock: { batches: InventoryRecord[] };
};

type Rule = (value: unknown, path: string) => void;
function invalid(path: string, message: string): never {
  // Report the field path, never echo receiver/contact values from rejected data.
  throw new AccessInputError(`Invalid inventory: ${path} ${message}.`);
}
const text = (max = 256, required = false): Rule => (value, path) => {
  if (typeof value !== "string" || value.length > max || (required && !value.trim()) || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value))
    invalid(path, `must be ${required ? "nonempty " : ""}text of at most ${max} characters`);
};
const identifier: Rule = (value, path) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) invalid(path, "must be a safe record identifier");
};
const businessId: Rule = (value, path) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,127}$/.test(value)) invalid(path, "must be a text identifier (preserve leading zeroes)");
};
const optional = (rule: Rule): Rule => (value, path) => { if (value !== "") rule(value, path); };
const nullable = (rule: Rule): Rule => (value, path) => { if (value !== null) rule(value, path); };
const choice = (...values: string[]): Rule => (value, path) => { if (!values.includes(value as string)) invalid(path, `must be one of ${values.join(", ")}`); };
const integer = (min = 0, max = 20000): Rule => (value, path) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) invalid(path, `must be an integer from ${min} to ${max}`);
};
const boolean: Rule = (value, path) => { if (typeof value !== "boolean") invalid(path, "must be true or false"); };
const date: Rule = (value, path) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value.slice(0, 10)).toISOString().slice(0, 10) !== value.slice(0, 10)) invalid(path, "must be a valid ISO date/time");
};
const mapLink: Rule = (value, path) => {
  if (value === "") return;
  text(512)(value, path);
  try {
    const url = new URL(value as string);
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
        !(url.hostname === "maps.google.com" || ["google.com", "www.google.com"].includes(url.hostname) && url.pathname.startsWith("/maps")))
      invalid(path, "must be an HTTPS Google Maps link");
  } catch { invalid(path, "must be an HTTPS Google Maps link"); }
};
const array = (rule: Rule, max = 20000): Rule => (value, path) => {
  if (!Array.isArray(value) || value.length > max) invalid(path, `must be an array of at most ${max} records`);
  value.forEach((item, index) => rule(item, `${path}[${index}]`));
};
const object = (fields: Record<string, Rule>, required: string[]): Rule => (value, path) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(path, "must be an object");
  const row = value as Record<string, unknown>;
  for (const key of Object.keys(row)) {
    if (!Object.hasOwn(fields, key)) invalid(path, "contains an unsupported field");
    fields[key](row[key], `${path}.${key}`);
  }
  for (const key of required) if (!Object.hasOwn(row, key)) invalid(`${path}.${key}`, "is required");
};
const receiver = object({
  id: identifier, assetNumber: businessId, model: text(128), accessCard: optional(businessId), rid: optional(businessId),
  serial: optional(businessId), type: text(128), condition: choice("Good", "Test", "Bad"), notes: text(2048),
  rentState: choice("On Rent", "Off Rent"), offRentSince: optional(date),
}, ["id", "assetNumber", "rentState"]);
const account = object({ id: identifier, number: businessId, name: text(256, true), location: text(256), office: text(256) }, ["id", "number", "name"]);
const assignment = object({ id: identifier, assetId: identifier, accountId: identifier, assignedAt: date }, ["id", "assetId", "accountId", "assignedAt"]);
const activation = object({
  id: identifier, assetId: identifier, accountId: optional(identifier), action: choice("Activate", "Deactivate"),
  status: choice("Pending", "Completed", "Cancelled"), requestedAt: date, completedAt: nullable(optional(date)), requesterName: text(120), notes: text(2048),
}, ["id", "assetId", "action", "status", "requestedAt"]);
const event = object({
  id: identifier, receiverId: identifier, title: text(256, true), detail: text(2048), kind: choice("assignment", "rent", "service", "condition", "inactive", "audit"),
  date, changedBy: text(128), activationId: identifier, status: optional(choice("Pending", "Completed", "Cancelled")), action: text(128),
  requestedAt: optional(date), completedAt: optional(date), accountNumber: optional(businessId), accountName: text(256), notes: text(2048),
  errorCode: text(128), operatorName: text(120), requesterName: text(120), requesterPhone: text(40), rigFrac: text(256), lease: text(256),
  mapUrl: mapLink, gpsAccuracy: (value, path) => { if (value !== "" && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) invalid(path, "must be nonnegative GPS accuracy"); },
  source: choice("Manual", "QR"),
}, ["id", "receiverId", "title", "kind", "date"]);
const stockItem = object({ receiverId: identifier, issuedAt: date, releasedAt: optional(date), removedAt: date, removedBy: text(128), removalReason: text(2048) }, ["receiverId", "issuedAt", "releasedAt"]);
const removedItem = object({ receiverId: identifier, removedAt: date, removedBy: text(128), reason: text(2048), condition: choice("Good", "Test", "Bad") }, ["receiverId", "removedAt", "removedBy", "reason"]);
const stockBatch = object({
  id: identifier, batchNumber: integer(1, 1000000000), managerName: text(120, true), lowThreshold: integer(1, 30), issuedAt: date,
  completedAt: optional(date), status: choice("Active", "Completed"), originalCount: integer(1), receiverIds: array(identifier),
  items: array(stockItem), removedItems: array(removedItem),
}, ["id", "batchNumber", "managerName", "lowThreshold", "issuedAt", "completedAt", "status", "originalCount", "receiverIds", "items"]);
const issue = object({
  issueId: identifier, assetNumber: optional(businessId), accessCard: optional(businessId), rid: optional(businessId), key: text(300),
  accountNumber: optional(businessId), status: choice("needs-research", "confirmed", "corrected", "ignored"), notes: text(2048), changedBy: text(128), updatedAt: optional(date),
}, ["issueId", "status"]);
const auditResult = object({
  accountNumber: businessId, accountName: text(256), appCount: integer(), auditCount: integer(), matchedCount: integer(),
  countMatch: boolean, perfect: boolean, accountExists: boolean, missingFromAudit: array(issue), missingFromApp: array(issue),
}, ["accountNumber", "appCount", "auditCount", "matchedCount", "countMatch", "perfect", "accountExists", "missingFromAudit", "missingFromApp"]);
const audit = object({ fileName: text(512), importedAt: date, results: array(auditResult, 10000) }, ["fileName", "importedAt", "results"]);
const stateRule = object({
  master: array(receiver), accounts: array(account, 10000), assignments: array(assignment), activations: array(activation, 10000),
  receiverEvents: array(event), auditState: nullable(audit), rentalStock: object({ batches: array(stockBatch, 1000) }, ["batches"]),
}, ["master", "accounts", "assignments", "activations", "receiverEvents", "auditState", "rentalStock"]);

function unique(values: unknown[], path: string) {
  if (new Set(values).size !== values.length) invalid(path, "contains duplicates");
}

// The same complete schema applies to ordinary edits, administrator replacements,
// and recovery. JSONB syntax validation alone does not protect business links.
export function validateInventory(value: unknown): InventoryState {
  stateRule(value, "state");
  const state = value as InventoryState;
  for (const key of ["master", "accounts", "assignments", "activations", "receiverEvents"] as const)
    unique(state[key].map((row) => row.id), `state.${key}.id`);
  unique(state.master.map((row) => String(row.assetNumber).toUpperCase()), "state.master.assetNumber");
  unique(state.accounts.map((row) => String(row.number).toUpperCase()), "state.accounts.number");
  unique(state.assignments.map((row) => row.assetId), "state.assignments.assetId");
  const receivers = new Set(state.master.map((row) => row.id));
  const accounts = new Set(state.accounts.map((row) => row.id));
  const counts = new Map<string, number>();
  state.assignments.forEach((row, index) => {
    if (!receivers.has(row.assetId as string) || !accounts.has(row.accountId as string)) invalid(`state.assignments[${index}]`, "references an unknown receiver/account");
    counts.set(row.accountId as string, (counts.get(row.accountId as string) ?? 0) + 1);
  });
  if ([...counts.values()].some((count) => count > 20)) invalid("state.assignments", "exceeds the 20-receiver account capacity");
  state.activations.forEach((row, index) => {
    if (!receivers.has(row.assetId as string) || row.accountId && !accounts.has(row.accountId as string)) invalid(`state.activations[${index}]`, "references an unknown receiver/account");
    if (row.status === "Completed" && !row.completedAt || row.status !== "Completed" && row.completedAt) invalid(`state.activations[${index}].completedAt`, "does not match the request status");
  });
  state.receiverEvents.forEach((row, index) => { if (!receivers.has(row.receiverId as string)) invalid(`state.receiverEvents[${index}].receiverId`, "references an unknown receiver"); });
  const batches = state.rentalStock.batches;
  unique(batches.map((row) => row.id), "state.rentalStock.batches.id");
  unique(batches.map((row) => row.batchNumber), "state.rentalStock.batches.batchNumber");
  if (batches.filter((row) => row.status === "Active").length > 1) invalid("state.rentalStock", "has more than one active batch");
  batches.forEach((batch, index) => {
    const path = `state.rentalStock.batches[${index}]`;
    const ids = batch.receiverIds as string[];
    const items = batch.items as Record<string, unknown>[];
    const removed = (batch.removedItems ?? []) as Record<string, unknown>[];
    unique(ids, `${path}.receiverIds`);
    unique(items.map((item) => item.receiverId), `${path}.items.receiverId`);
    unique(removed.map((item) => item.receiverId), `${path}.removedItems.receiverId`);
    const itemIds = new Set(items.map((item) => item.receiverId));
    const currentIds = new Set(ids);
    const removedIds = new Set(removed.map((item) => item.receiverId));
    if (ids.some((id) => !receivers.has(id) || !itemIds.has(id) || removedIds.has(id)) ||
        items.some((item) => !receivers.has(item.receiverId as string) || !currentIds.has(item.receiverId as string) && !removedIds.has(item.receiverId) || item.issuedAt !== batch.issuedAt) ||
        removed.some((item) => !itemIds.has(item.receiverId)) || items.length !== batch.originalCount || items.length !== ids.length + removed.length)
      invalid(path, "has inconsistent receiver links/counts");
    if (batch.status === "Active" && (!ids.length || batch.completedAt) || batch.status === "Completed" && !batch.completedAt)
      invalid(path, "has an inconsistent completion status/date");
  });
  if (state.auditState) {
    const results = state.auditState.results as Record<string, unknown>[];
    unique(results.map((row) => String(row.accountNumber).toUpperCase()), "state.auditState.results.accountNumber");
    const issues: unknown[] = [];
    results.forEach((row, index) => {
      const appMissing = row.missingFromAudit as Record<string, unknown>[];
      const auditMissing = row.missingFromApp as Record<string, unknown>[];
      issues.push(...appMissing.map((item) => item.issueId), ...auditMissing.map((item) => item.issueId));
      if (row.appCount !== Number(row.matchedCount) + appMissing.length || row.auditCount !== Number(row.matchedCount) + auditMissing.length ||
          row.countMatch !== (row.appCount === row.auditCount) || row.perfect !== (row.accountExists && row.countMatch && !appMissing.length && !auditMissing.length))
        invalid(`state.auditState.results[${index}]`, "has inconsistent comparison counts");
    });
    if (issues.length > 20000) invalid("state.auditState", "contains too many issues");
    unique(issues, "state.auditState.issueId");
  }
  return state;
}

// PostgreSQL JSONB can reorder object keys. Array order remains meaningful.
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
}
