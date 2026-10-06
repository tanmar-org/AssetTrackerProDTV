import { mapRow, type RequestRow } from "../../../lib/request-record";
import { ListingInputError, literalSearch, readRecordList, recordPage } from "../../../../lib/record-list";
import { database } from "../../../lib/database";
import { authorized, failure, json, readBody, submission } from "../../../lib/input";
import { lookupAsset } from "../../../lib/asset-lookup";
import { guardAsset, guardPublic } from "../../../lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Private bearer methods never grant browser CORS.
export function OPTIONS() { return new Response(null, { status: 403 }); }

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

// Unversioned writes cannot safely participate in durable cross-database work.
// Fail closed for older integrations; current staff uses the operation endpoint.
export async function PATCH(request: Request) {
  if (!authorized(request)) return json({ error: "Unauthorized" }, 401);
  return json({ error: "Reload the tracker and use coordinated service operations." }, 410);
}
export const DELETE = PATCH;
