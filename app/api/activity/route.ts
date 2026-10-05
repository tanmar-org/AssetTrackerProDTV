import { db, requireUser } from "../../../lib/pin-auth";

// Server-only PostgreSQL connections require the Node runtime and fresh responses.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireUser(request, "admin");
  if (auth.response) return auth.response;

  const rows = await db().prepare(
    `SELECT id, user_name, action, revision, created_at
     FROM app_change_log
     ORDER BY created_at DESC
     LIMIT 500`,
  ).all();

  return Response.json(
    { activity: rows.results },
    { headers: { "cache-control": "no-store" } },
  );
}
