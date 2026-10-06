import { database } from "../../../lib/database";
import { adConfiguration, authenticationMode } from "../../../lib/ad-auth";

// Readiness is deliberately small and reports no database or credential details.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    if (authenticationMode() === "ad") adConfiguration(); // Local settings; no live-directory health probe.
    await database().prepare("SELECT ad_guid, ad_directory FROM app_users LIMIT 1").first();
    await database().prepare("SELECT auth_method, auth_binding, ad_password_stamp, directory_checked_at FROM app_sessions LIMIT 1").first();
    await database().prepare("SELECT 1 FROM app_inventory_drafts LIMIT 1").first();
    await database().prepare("SELECT 1 FROM app_service_operations LIMIT 1").first();
    // The login gate must have its operator-created table and runtime read grant.
    await database().prepare("SELECT 1 FROM app_login_rate_limits LIMIT 1").first();
    return Response.json({ status: "ok" }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
