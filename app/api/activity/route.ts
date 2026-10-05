import { db, requireUser } from "../../../lib/pin-auth";

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
