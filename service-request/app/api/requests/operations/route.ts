import { database } from "../../../../lib/database";
import { authorized, json, failure, readBody } from "../../../../lib/input";
import { mapRow, type RequestRow } from "../../../../lib/request-record";
import { AccessInputError } from "../../../../../lib/access-input";
import { serviceCommand, serviceFingerprint, validOperationId, type ServiceReceipt } from "../../../../../lib/service-protocol";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Reading a receipt is not a public lookup. Its ID contains no authorization.
export async function GET(request: Request) {
  if (!authorized(request)) return json({error:"Unauthorized"},401);
  const params = new URL(request.url).searchParams;
  if (params.size !== 1 || !validOperationId(params.get("id"))) return json({error:"A valid operation ID is required."},400);
  try {
    const row = await database().prepare("SELECT result FROM service_request_operations WHERE id=$1").bind(params.get("id")).first<{result:ServiceReceipt}>();
    return row ? json(row.result) : json({error:"Operation not found."},404);
  } catch(error) { return failure(error,"Unable to load operation receipt."); }
}

// A receipt and transition commit together. Successful retries return the first
// receipt, including its original completion time, rather than applying again.
export async function PATCH(request: Request) {
  if (!authorized(request)) return json({error:"Unauthorized"},401);
  try {
    const command = serviceCommand(await readBody(request)), fingerprint = serviceFingerprint(command);
    const receipt = await database().transaction(async tx => {
      // Same UUID across independent QR processes serializes before its row lock.
      // Hash collisions only cause extra serialization; they cannot share receipts.
      await tx.prepare("SELECT pg_advisory_xact_lock(728305,hashtext($1))").bind(command.operationId).run();
      const old = await tx.prepare("SELECT fingerprint,result FROM service_request_operations WHERE id=$1")
        .bind(command.operationId).first<{fingerprint:string;result:ServiceReceipt}>();
      if (old) {
        if (old.fingerprint !== fingerprint) throw new AccessInputError("Operation ID already belongs to another change.",409);
        return old.result;
      }
      let row = await tx.prepare("SELECT * FROM service_requests WHERE id=$1 FOR UPDATE").bind(command.id).first<RequestRow>();
      let reason: ServiceReceipt["reason"] = !row || row.deleted_at ? "not_found" : row.version !== command.expectedVersion ? "version_conflict" : "";
      const appliedAt = new Date().toISOString();
      if (!reason) {
        // Preserve the receipt transaction when Pending uniqueness rejects a
        // reopen; the original row remains unchanged and rejection is durable.
        await tx.prepare("SAVEPOINT request_change").run();
        try {
          row = command.kind === "delete"
            ? await tx.prepare("UPDATE service_requests SET deleted_at=$1,version=version+1 WHERE id=$2 RETURNING *").bind(appliedAt,command.id).first<RequestRow>()
            : await tx.prepare("UPDATE service_requests SET status=$1,notes=$2,completed_at=$3,version=version+1 WHERE id=$4 RETURNING *")
              .bind(command.status,command.notes,command.status === "Completed" ? appliedAt : null,command.id).first<RequestRow>();
          if (!row) throw new Error("Missing locked request.");
        } catch(error) {
          if ((error as {code?:string})?.code !== "23505") throw error;
          await tx.prepare("ROLLBACK TO SAVEPOINT request_change").run();reason = "pending_conflict";
        }
        await tx.prepare("RELEASE SAVEPOINT request_change").run();
      }
      const result: ServiceReceipt = {operationId:command.operationId,requestId:command.id,fingerprint,
        outcome:reason ? "rejected" : "applied",reason,appliedAt,deleted:command.kind === "delete" && !reason,
        request:row ? mapRow(row) : null};
      await tx.prepare("INSERT INTO service_request_operations(id,request_id,fingerprint,result,created_at) VALUES($1,$2,$3,$4::jsonb,$5)")
        .bind(command.operationId,command.id,fingerprint,JSON.stringify(result),appliedAt).run();
      return result;
    });
    return json(receipt);
  } catch(error) {
    if (error instanceof AccessInputError) return json({error:error.message},error.status);
    return failure(error,"Unable to apply service operation.");
  }
}
