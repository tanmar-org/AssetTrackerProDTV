import { db, requireUser } from "../../../lib/pin-auth";
import { AccessInputError, accessError, readAccessBody } from "../../../lib/access-input";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Staff may read/update request status; deletion is administrator-only. Keep the
// shared credential server-side and bound upstream calls to the configured URL.
// The separate QR database still cannot commit atomically with tracker inventory.
async function forward(request: Request, method: "GET" | "PATCH" | "DELETE") {
  try {
    const role = method === "DELETE" ? "admin" : undefined;
    const initial = await requireUser(request, role);
    if (initial.response) return initial.response;
    const secret = process.env.ADMIN_SHARED_SECRET;
    const endpoint = process.env.SERVICE_REQUEST_API_URL;
    if (!secret || !endpoint) return Response.json({ error: "Service request synchronization is not configured." }, { status: 503 });
    const target = new URL(endpoint);
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password)
      return Response.json({ error: "Service request synchronization is not configured." }, { status: 503 });
    target.search = "";
    let payload: Record<string, unknown> | undefined;
    if (method === "PATCH") {
      const body = await readAccessBody(request);
      if (typeof body.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(body.id) ||
          !["Pending", "Completed", "Cancelled"].includes(body.status as string) ||
          body.notes !== undefined && (typeof body.notes !== "string" || body.notes.length > 2048))
        throw new AccessInputError("A valid request, status, and notes of at most 2048 characters are required.");
      payload = { id: body.id, status: body.status, notes: body.notes ?? "" };
    } else if (method === "DELETE") {
      const id = new URL(request.url).searchParams.get("id");
      if (!id || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw new AccessInputError("A valid request id is required.");
      target.searchParams.set("id", id);
    }
    return await db().transaction(async (tx) => {
      // Account edits share this lock. Revalidate after waiting and hold it until
      // the bounded upstream operation completes, including an admin deletion.
      await tx.prepare("SELECT pg_advisory_xact_lock(728303)").run();
      const auth = await requireUser(request, role, tx);
      if (auth.response) return auth.response;
      const response = await fetch(target, {
        method, signal: AbortSignal.timeout(5000),
        headers: { authorization: `Bearer ${secret}`, ...(payload ? { "content-type": "application/json" } : {}) },
        body: payload ? JSON.stringify(payload) : undefined,
      });
      // Consume the bounded upstream response before releasing authorization.
      const body = await response.text();
      return new Response(body, { status: response.status, headers: {
        "content-type": response.headers.get("content-type") || "application/json; charset=utf-8", "cache-control": "no-store",
      } });
    });
  } catch (error) { return accessError(error, "Service request synchronization failed."); }
}
export function GET(request: Request) { return forward(request, "GET"); }
export function PATCH(request: Request) { return forward(request, "PATCH"); }
export function DELETE(request: Request) { return forward(request, "DELETE"); }
