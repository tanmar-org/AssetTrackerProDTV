import { canonicalGuid, directoryId } from "../lib/ad-auth.ts";
import { AccessInputError } from "../lib/access-input.ts";

// Operator-only explicit mapping, with compare-and-set when replacing an existing
// link. It never infers account ownership from a matching username/email.
export async function linkAdIdentity(database, { userId, guid, directory, expectedBinding }) {
  if (typeof userId !== "string" || !userId || userId.length > 128)
    throw new AccessInputError("Specify the existing application user ID.");
  const identity = canonicalGuid(guid), namespace = directoryId(directory);
  return database.transaction(async tx => {
    await tx.prepare("SELECT pg_advisory_xact_lock(728303)").run();
    const user = await tx.prepare("SELECT id, name, ad_directory, ad_guid FROM app_users WHERE id = $1 FOR UPDATE")
      .bind(userId).first();
    if (!user) throw new AccessInputError("Application user not found.");
    const current = user.ad_guid ? `${user.ad_directory}:${user.ad_guid}` : null;
    if (current === `${namespace}:${identity}`) return { changed: false };
    if ((current ?? undefined) !== expectedBinding)
      throw new AccessInputError("Identity link changed or already exists. Review it and supply its exact expected binding.");
    const now = new Date().toISOString();
    await tx.prepare("UPDATE app_users SET ad_directory = $1, ad_guid = $2, updated_at = $3 WHERE id = $4")
      .bind(namespace, identity, now, userId).run();
    await tx.prepare("DELETE FROM app_sessions WHERE user_id = $1").bind(userId).run();
    await tx.prepare("INSERT INTO app_change_log (id,user_id,user_name,action,created_at) VALUES ($1,$2,$3,$4,$5)")
      .bind(crypto.randomUUID(), user.id, user.name, "Operator linked AD identity; existing sessions revoked", now).run();
    return { changed: true };
  });
}
