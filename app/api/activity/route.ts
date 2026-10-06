import { db, requireUser } from "../../../lib/pin-auth";
import { accessError } from "../../../lib/access-input";
import { ListingInputError, literalSearch, readRecordList, recordPage } from "../../../lib/record-list";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const auth = await requireUser(request, "admin");
    if (auth.response) return auth.response;
    const list = readRecordList(new URL(request.url), "activity");
    const values: unknown[] = [], conditions: string[] = [];
    const bind = (value: unknown) => { values.push(value); return `$${values.length}`; };
    if (list.q) conditions.push(`concat_ws(' ', user_name, action) ILIKE ${bind(literalSearch(list.q))} ESCAPE '\\'`);
    // Keep categories identical to the staff display, including Denied: casing.
    if (list.type !== "all") conditions.push(`(CASE WHEN left(action, 7) = 'Denied:' THEN 'denied'
      WHEN action ~* '(user|administrator|pin|access)' THEN 'user' ELSE 'data' END) = ${bind(list.type)}`);
    // Inclusive from / exclusive through are real instants. Date casts support
    // historical ISO strings with/without milliseconds without rewriting them.
    if (list.from) conditions.push(`created_at::timestamptz >= ${bind(list.from)}::timestamptz`);
    if (list.through) conditions.push(`created_at::timestamptz < ${bind(list.through)}::timestamptz`);
    if (list.after) conditions.push(`(created_at, id) < (${bind(list.after.time)}, ${bind(list.after.id)})`);
    const rows = await db().prepare(`SELECT id, user_name, action, revision, created_at FROM app_change_log
      ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY created_at DESC, id DESC LIMIT ${bind(list.limit + 1)}`)
      .bind(...values).all<{ id: string; user_name: string; action: string; revision: number | null; created_at: string }>();
    const { records, page } = recordPage(rows.results, list, (row) => row.created_at);
    return Response.json({ activity: records, page }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof ListingInputError) return Response.json({ error: error.message }, { status: 400, headers: { "cache-control": "no-store" } });
    return accessError(error, "Unable to load activity.");
  }
}
