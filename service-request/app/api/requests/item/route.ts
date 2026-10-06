import { database } from "../../../../lib/database";
import { authorized, json, failure } from "../../../../lib/input";
import { mapRow, type RequestRow } from "../../../../lib/request-record";
import { validServiceId } from "../../../../../lib/service-protocol";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Single authoritative snapshot for staging, with exactly one caller selector.
export async function GET(request: Request) {
  if (!authorized(request)) return json({ error: "Unauthorized" },401);
  const params = new URL(request.url).searchParams;
  if (params.size !== 1 || !validServiceId(params.get("id"))) return json({error:"A valid request ID is required."},400);
  try {
    const row = await database().prepare("SELECT * FROM service_requests WHERE id=$1 AND deleted_at IS NULL").bind(params.get("id")).first<RequestRow>();
    return row ? json({ request: mapRow(row) }) : json({error:"Request not found."},404);
  } catch(error) { return failure(error,"Unable to load request."); }
}
