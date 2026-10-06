import { ListingInputError, literalSearch, readRecordList, recordPage } from "../../../../lib/record-list";
import { database } from "../../../lib/database";
import { authorized, failure, fields, InputError, json, readBody, submission, text } from "../../../lib/input";
import { lookupAsset } from "../../../lib/asset-lookup";
import { guardAsset, guardPublic } from "../../../lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RequestRow = {
  id: string; asset_id: string | null; asset_number: string; model: string; receiver_type: string;
  serial_number: string; rid: string; access_card: string; rent_state: string; account_number: string;
  account_name: string; recorded_location: string; office: string; operator_name: string;
  requester_name: string; requester_phone: string; rig_frac: string; lease: string; error_code: string;
  latitude: number; longitude: number; gps_accuracy: number; gps_captured_at: string;
  action: string; status: string; notes: string; requested_at: string; completed_at: string | null;
};

// JSON public submissions and the private bearer proxy need no browser CORS.
export function OPTIONS() { return new Response(null, { status: 403 }); }

function mapRow(row: RequestRow) {
  return {
    id: row.id,
    assetId: row.asset_id,
    assetNumber: row.asset_number,
    model: row.model,
    receiverType: row.receiver_type,
    serialNumber: row.serial_number,
    rid: row.rid,
    accessCard: row.access_card,
    rentState: row.rent_state,
    accountNumber: row.account_number,
    accountName: row.account_name,
    recordedLocation: row.recorded_location,
    office: row.office,
    operatorName: row.operator_name,
    requesterName: row.requester_name,
    requesterPhone: row.requester_phone,
    rigFrac: row.rig_frac,
    lease: row.lease,
    errorCode: row.error_code,
    latitude: row.latitude,
    longitude: row.longitude,
    gpsAccuracy: row.gps_accuracy,
    gpsCapturedAt: row.gps_captured_at,
    action: row.action,
    status: row.status,
    notes: row.notes,
    requestedAt: row.requested_at,
    completedAt: row.completed_at,
    mapUrl: `https://maps.google.com/?q=${row.latitude},${row.longitude}`,
    source: "QR",
  };
}

// Only contact/worksite/GPS are public claims. Every receiver/account field comes
// from the authenticated tracker lookup, refreshed for each submission.
export async function POST(request: Request) {
  try {
    await guardPublic(request, "submit");
    const input = submission(await readBody(request));
    const asset = await lookupAsset(input.asset);
    await guardAsset(asset.id);
    const id = crypto.randomUUID(), requestedAt = new Date().toISOString();
    // PostgreSQL's partial unique indexes serialize simultaneous submissions and
    // status reopens. No SELECT-before-INSERT race, and no existing request ID leak.
    const inserted = await database().prepare(`INSERT INTO service_requests (
      id, asset_id, asset_number, model, receiver_type, serial_number, rid, access_card, rent_state,
      account_number, account_name, recorded_location, office, operator_name, requester_name,
      requester_phone, rig_frac, lease, error_code, latitude, longitude, gps_accuracy, gps_captured_at,
      action, status, notes, requested_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,
      'Reactivate / Refresh','Pending','',$24) ON CONFLICT DO NOTHING RETURNING id`)
      .bind(id, asset.id, asset.assetNumber, asset.model, asset.receiverType, asset.serialNumber, asset.rid,
        asset.accessCard, asset.rentState, asset.accountNumber, asset.accountName, asset.recordedLocation,
        asset.office, input.operatorName, input.requesterName, input.requesterPhone, input.rigFrac, input.lease,
        input.errorCode, input.latitude, input.longitude, input.gpsAccuracy, input.gpsCapturedAt, requestedAt)
      .first<{ id: string }>();
    if (!inserted) return json({ error: "A pending request already exists for this receiver." }, 409);
    return json({ id, status: "Pending", requestedAt }, 201);
  } catch (error) { return failure(error, "Unable to submit the service request. Please try again later."); }
}

// Full metadata is available only to the authenticated staff proxy.
// Every page requires the internal bearer credential. Public submissions never
// gain list access. Return bounded pages without removing historical records.
export async function GET(request: Request) {
  if (!authorized(request)) return json({ error: "Unauthorized" }, 401);
  try {
    const list = readRecordList(new URL(request.url), "requests");
    const values: unknown[] = [], conditions = ["deleted_at IS NULL"];
    const bind = (value: unknown) => { values.push(value); return `$${values.length}`; };
    if (list.status !== "all") conditions.push(`status = ${bind(list.status)}`);
    // Search metadata saved with the request. Current inventory can differ; the
    // public lookup remains separate and never exposes these private fields.
    if (list.q) conditions.push(`concat_ws(' ', asset_number, model, receiver_type, serial_number, rid,
      access_card, account_number, account_name, recorded_location, office, action, status, error_code,
      requester_name, requester_phone, operator_name, rig_frac, lease, notes) ILIKE ${bind(literalSearch(list.q))} ESCAPE '\\'`);
    if (list.after) conditions.push(`(requested_at, id) < (${bind(list.after.time)}, ${bind(list.after.id)})`);
    // An extra row detects another page without a total-count scan. Timestamp/ID
    // navigation tolerates newer arrivals and deletion of the previous anchor.
    const rows = await database().prepare(`SELECT * FROM service_requests WHERE ${conditions.join(" AND ")}
      ORDER BY requested_at DESC, id DESC LIMIT ${bind(list.limit + 1)}`).bind(...values).all<RequestRow>();
    const { records, page } = recordPage(rows.results, list, (row) => row.requested_at);
    return json({ requests: records.map(mapRow), page });
  } catch (error) {
    if (error instanceof ListingInputError) return json({ error: error.message }, 400);
    return failure(error, "Unable to load requests.");
  }
}

const validId = (value: unknown) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value))
    throw new InputError("A valid request ID is required.");
  return value;
};

export async function PATCH(request: Request) {
  if (!authorized(request)) return json({ error: "Unauthorized" }, 401);
  try {
    const body = await readBody(request);
    fields(body, ["id", "status", "notes"]);
    const id = validId(body.id), status = body.status;
    if (typeof status !== "string" || !["Pending", "Completed", "Cancelled"].includes(status))
      throw new InputError("A valid status is required.");
    const notes = text(body.notes === undefined ? "" : body.notes, "Notes", 2048, false, true);
    const completedAt = status === "Completed" ? new Date().toISOString() : null;
    const result = await database().prepare(
      "UPDATE service_requests SET status = $1, completed_at = $2, notes = $3 WHERE id = $4 AND deleted_at IS NULL",
    ).bind(status, completedAt, notes, id).run();
    if (!result.meta.changes) return json({ error: "Request not found." }, 404);
    return json({ id, status, completedAt });
  } catch (error) {
    // A concurrent new request/reopen wins the unique pending slot. Preserve the
    // losing row's prior status and return a useful, non-private conflict.
    if ((error as { code?: string })?.code === "23505")
      return json({ error: "A pending request already exists for this receiver." }, 409);
    return failure(error, "Unable to update request.");
  }
}

// Deletion remains a tombstone; retention and backups require a separate policy.
export async function DELETE(request: Request) {
  if (!authorized(request)) return json({ error: "Unauthorized" }, 401);
  try {
    const params = new URL(request.url).searchParams;
    if (params.size !== 1) throw new InputError("A valid request ID is required.");
    const id = validId(params.get("id"));
    const result = await database().prepare(
      "UPDATE service_requests SET deleted_at = $1 WHERE id = $2 AND deleted_at IS NULL",
    ).bind(new Date().toISOString(), id).run();
    if (!result.meta.changes) return json({ error: "Request not found." }, 404);
    return json({ id, deleted: true });
  } catch (error) { return failure(error, "Unable to delete request."); }
}
