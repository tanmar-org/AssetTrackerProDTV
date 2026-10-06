import { database } from "../../../lib/database";

// Readiness is deliberately small and reports no database or credential details.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    await database().prepare("SELECT 1 FROM app_users LIMIT 1").first();
    await database().prepare("SELECT 1 FROM app_inventory_drafts LIMIT 1").first();
    await database().prepare("SELECT 1 FROM app_service_operations LIMIT 1").first();
    return Response.json({ status: "ok" }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
