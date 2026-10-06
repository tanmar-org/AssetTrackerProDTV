import { database } from "../../../lib/database";

// Readiness is deliberately small and reports no database or credential details.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    // Readiness includes the new schema/runtime grant so an unmigrated app does
    // not appear ready while every public submission is failing closed.
    await database().prepare("SELECT asset_id FROM service_requests LIMIT 1").first();
    await database().prepare("SELECT 1 FROM request_rate_limits LIMIT 1").first();
    if (!process.env.ADMIN_SHARED_SECRET || !process.env.TRACKER_ASSET_API_URL) throw new Error("Missing lookup configuration.");
    await database().prepare("SELECT 1 FROM service_request_operations LIMIT 1").first();
    return Response.json({ status: "ok" }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
