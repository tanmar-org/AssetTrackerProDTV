import { adConfiguration, authenticationMode, canonicalAdUsername, lookupAdUsername } from "../../../../lib/ad-auth";
import { issueAdConfirmation } from "../../../../lib/ad-enrollment";
import { AccessInputError, accessError, readAccessBody } from "../../../../lib/access-input";
import { db, requireUser } from "../../../../lib/pin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const initial = await requireUser(request, "admin");
    if (initial.response) return initial.response;
    if (authenticationMode() !== "ad") throw new AccessInputError("AD account lookup is not enabled.", 409);
    const body = await readAccessBody(request), name = canonicalAdUsername(body.name);
    if (!name) throw new AccessInputError("Enter an AD username such as j.doe.");
    if (Object.keys(body).some(key => !["name", "userId"].includes(key))) throw new AccessInputError("Send only the AD username and optional application user.");
    const targetUserId = body.userId === undefined ? null : body.userId;
    if (targetUserId !== null && (typeof targetUserId !== "string" || !targetUserId || targetUserId.length > 128))
      throw new AccessInputError("Choose the application user to link.");
    const config = adConfiguration(), identity = await lookupAdUsername(config, name);
    if (!identity) throw new AccessInputError("No eligible AD user was found. Check the username and directory account status.", 404);
    return await db().transaction(async tx => {
      // Lookup is outside SQL locks. A logout/demotion during directory I/O must
      // prevent disclosure/approval; hold the account lock through this response.
      await tx.prepare("SELECT pg_advisory_xact_lock(728303)").run();
      const auth = await requireUser(request, "admin", tx);
      if (auth.response) return auth.response;
      if (targetUserId !== null) {
        const target = await tx.prepare("SELECT ad_guid,ad_directory FROM app_users WHERE id=$1").bind(targetUserId).first();
        if (!target) throw new AccessInputError("Application user not found.", 404);
        if (target.ad_guid || target.ad_directory) throw new AccessInputError("This application user is already linked. Existing links require operator review.", 409);
      }
      const linked = await tx.prepare("SELECT id FROM app_users WHERE ad_directory=$1 AND ad_guid=$2").bind(config.id, identity.guid).first();
      if (linked) throw new AccessInputError("This AD account already has an application account. Manage that account instead.", 409);
      const confirmation = issueAdConfirmation(identity, { id: auth.user!.id, context: request.headers.get("x-tracker-session-context")! }, config, targetUserId);
      // Return only review fields. Directory DNs, flags/password metadata and
      // reader credentials stay server-side; the signed proof is tab-memory-only.
      return Response.json({ username: identity.username, displayName: identity.displayName, confirmation },
        { headers: { "cache-control": "no-store" } });
    });
  } catch (error) { return accessError(error, "AD account lookup unavailable."); }
}
