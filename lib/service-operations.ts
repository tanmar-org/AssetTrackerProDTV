import type { Database } from "@tanmar/database";
import { AccessInputError } from "./access-input.ts";
import { requireUser, type SessionUser } from "./pin-auth.ts";
import { canonicalJson, validateInventory } from "./inventory-state.ts";
import { authorizeEveryday } from "./inventory-permissions.ts";
import { readInventory, commitInventory } from "./inventory-store.ts";
import { rentBaseline, serviceHistory } from "./service-history.ts";
import { serviceEndpoint, serviceFetch } from "./service-remote.ts";
import { serviceFingerprint, serviceSnapshot, type ServiceCommand, type ServiceReceipt, type ServiceSnapshot } from "./service-protocol.ts";

export type ServiceOperation = {
  id:string;request_id:string;kind:ServiceCommand["kind"];target_status:ServiceCommand["status"];notes:string;
  expected_version:number;fingerprint:string;actor_id:string;actor_name:string;approver_id:string;approver_name:string;
  receiver_id:string|null;receiver_baseline:Record<string,unknown>|null;snapshot:ServiceSnapshot;receipt:ServiceReceipt|null;
  phase:"pending"|"blocked"|"needs_review"|"done"|"failed";error_code:string;attempts:number;
  history_scope:"receiver"|"operation"|null;created_at:string;updated_at:string;next_attempt_at:Date;
};
const messages: Record<string,string> = {
  remote_unavailable:"Waiting for QR confirmation. Retry when the service is available.",
  history_unavailable:"QR confirmation/history is not complete. The saved operation can be retried safely.",
  authorization:"Approving account is inactive or lacks access. An administrator can review and retry.",
  rent_changed:"QR change is saved. Receiver rent status changed while waiting; review before recording history.",
  restore_review:"Restored operation is paused for administrator review.",
  version_conflict:"Request changed before this action. Refresh and review its current status.",
  not_found:"Request was deleted or no longer exists. No QR change was applied.",
  pending_conflict:"Another pending request already exists for this receiver. No QR change was applied.",
};
export function operationSummary(op: ServiceOperation, viewer?: SessionUser) {
  return {id:op.id,requestId:op.request_id,assetNumber:op.snapshot.assetNumber,receiverId:op.receiver_id,
    kind:op.kind,status:op.target_status,phase:op.phase,message:messages[op.error_code] ?? "",
    actorName:op.actor_name,approvedBy:op.approver_name,createdAt:op.created_at,updatedAt:op.updated_at,historyScope:op.history_scope,
    canRetry:Boolean(viewer && (viewer.role === "admin" || viewer.id === op.actor_id) &&
      (op.kind !== "delete" || viewer.role === "admin") && (op.error_code !== "restore_review" || viewer.role === "admin")),
    canReview:Boolean(viewer && (viewer.role === "admin" || viewer.id === op.actor_id) && op.phase === "needs_review")};
}
export function operationCommand(op: ServiceOperation): ServiceCommand {
  return {operationId:op.id,id:op.request_id,kind:op.kind,status:op.target_status,notes:op.notes,expectedVersion:op.expected_version};
}
const lockedOperation = (tx: Database,id: string) => tx.prepare("SELECT * FROM app_service_operations WHERE id=$1 FOR UPDATE").bind(id).first<ServiceOperation>();

// The accepted intent commits BEFORE any remote mutation. An HTTP/process crash
// thereafter cannot lose the operation or its original actor/receiver association.
export async function stageServiceOperation(request: Request, store: Database, command: ServiceCommand, baseRevision: number) {
  return store.transaction(async tx => {
    await tx.prepare("SELECT pg_advisory_xact_lock(728303)").run();
    const auth = await requireUser(request,command.kind === "delete" ? "admin" : undefined,tx);
    if(auth.response)return {response:auth.response,operation:null};
    const fingerprint = serviceFingerprint(command), old = await lockedOperation(tx,command.operationId);
    if(old){
      if(old.actor_id !== auth.user!.id || old.fingerprint !== fingerprint)
        throw new AccessInputError("Operation ID already belongs to another change.",409);
      return {response:null,operation:old};
    }
    const open = await tx.prepare("SELECT id FROM app_service_operations WHERE request_id=$1 AND phase IN ('pending','blocked','needs_review')")
      .bind(command.id).first<{id:string}>();
    if(open)throw new AccessInputError("This request has unfinished synchronization. Review it below before another action.",409);
    // Include configuration in preflight: missing credentials must not create a
    // misleading accepted queue entry that cannot contact its intended service.
    const target = serviceEndpoint("item");target.searchParams.set("id",command.id);
    await tx.prepare("SELECT pg_advisory_xact_lock(728302)").run();
    const current = await readInventory(tx);
    if((current?.revision ?? 0) !== baseRevision)throw new AccessInputError("Shared inventory changed. Refresh before changing QR status.",409);
    const loaded = await serviceFetch(target) as {request?:unknown}|null;
    if(!loaded)throw new AccessInputError("Request no longer exists. Refresh the list.",404);
    const snapshot = serviceSnapshot(loaded.request);
    if(snapshot.id !== command.id || snapshot.version !== command.expectedVersion)
      throw new AccessInputError("Request changed. Refresh and review its current status.",409);
    const state = current ? validateInventory(JSON.parse(current.payload)) : null;
    const receiver = snapshot.assetId ? state?.master.find(row => row.id === snapshot.assetId) :
      state?.master.find(row => String(row.assetNumber).toUpperCase() === snapshot.assetNumber.toUpperCase());
    const now = new Date().toISOString();
    if(state){
      const anticipated = {...snapshot,notes:command.kind === "status" ? command.notes : snapshot.notes,
        status:command.status ?? snapshot.status,completedAt:command.status === "Completed" ? now : snapshot.completedAt};
      const preview = serviceHistory(state,anticipated,command.operationId,receiver?.id ?? null,auth.user!.name,now,command.kind === "delete");
      if(Buffer.byteLength(JSON.stringify(preview.state)) > 8*1024*1024)throw new AccessInputError("Inventory is too large for this history entry.",413);
      if(preview.scope === "receiver")authorizeEveryday(state,preview.state,auth.user!.name);
    }
    await tx.prepare(`INSERT INTO app_service_operations(id,request_id,kind,target_status,notes,expected_version,fingerprint,
      actor_id,actor_name,approver_id,approver_name,receiver_id,receiver_baseline,snapshot,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$13)`)
      .bind(command.operationId,command.id,command.kind,command.status,command.notes,command.expectedVersion,fingerprint,
        auth.user!.id,auth.user!.name,receiver?.id ?? null,receiver ? JSON.stringify(rentBaseline(receiver)) : null,JSON.stringify(snapshot),now).run();
    return {response:null,operation:(await lockedOperation(tx,command.operationId))!};
  });
}

async function setPhase(tx: Database,op: ServiceOperation,phase: ServiceOperation["phase"],code = "") {
  const attempts = Math.min(op.attempts+1,1000000),delay = Math.min(300,Math.pow(2,Math.min(attempts,8)));
  await tx.prepare("UPDATE app_service_operations SET phase=$1,error_code=$2,attempts=$3,updated_at=$4,next_attempt_at=now()+$5*interval '1 second' WHERE id=$6")
    .bind(phase,code,attempts,new Date().toISOString(),delay,op.id).run();
  return (await lockedOperation(tx,op.id))!;
}
function checkedReceipt(value: unknown,op: ServiceOperation): ServiceReceipt {
  if(!value || typeof value !== "object")throw new Error("Invalid receipt.");
  const receipt = value as ServiceReceipt;
  if(receipt.operationId !== op.id || receipt.requestId !== op.request_id || receipt.fingerprint !== op.fingerprint ||
    !["applied","rejected"].includes(receipt.outcome) || !["","version_conflict","not_found","pending_conflict"].includes(receipt.reason) ||
    typeof receipt.appliedAt !== "string" || !Number.isFinite(Date.parse(receipt.appliedAt)))throw new Error("Invalid receipt.");
  if(receipt.outcome === "applied"){
    const snapshot = serviceSnapshot(receipt.request);
    if(snapshot.id !== op.request_id || snapshot.version !== op.expected_version+1 ||
      receipt.deleted !== (op.kind === "delete") || op.kind === "status" && (snapshot.status !== op.target_status || snapshot.notes !== op.notes))
      throw new Error("Receipt does not match accepted intent.");
  }else if(!receipt.reason)throw new Error("Rejected receipt needs a reason.");
  return receipt;
}

// Caller holds account lock, then the operation row. QR proof records an already
// accepted action: finishing its history does not initiate another QR mutation.
async function finishHistory(tx: Database,op: ServiceOperation,historyOnly = false,expectedRevision?: number) {
  const receipt = op.receipt!;
  if(receipt.outcome === "rejected"){
    await tx.prepare("INSERT INTO app_change_log(id,user_id,user_name,action,created_at) VALUES($1,$2,$3,$4,$5)")
      .bind(crypto.randomUUID(),op.actor_id,op.actor_name,`QR operation rejected: ${receipt.reason}`,new Date().toISOString()).run();
    return setPhase(tx,op,"failed",receipt.reason);
  }
  await tx.prepare("SELECT pg_advisory_xact_lock(728302)").run();
  const current = await readInventory(tx),before = current ? validateInventory(JSON.parse(current.payload)) : null;
  if(expectedRevision !== undefined && (current?.revision ?? 0) !== expectedRevision)
    throw new AccessInputError("Shared inventory changed. Review again before recording history.",409);
  const receiver = before?.master.find(row => row.id === op.receiver_id);
  if(!historyOnly && receiver && op.kind === "status" && op.target_status === "Completed" &&
    canonicalJson(rentBaseline(receiver)) !== canonicalJson(op.receiver_baseline))return setPhase(tx,op,"needs_review","rent_changed");
  const actor: SessionUser = {id:op.approver_id,name:op.approver_name,role:"user"};
  let scope: "receiver"|"operation" = "operation";
  if(before){
    const result = serviceHistory(before,serviceSnapshot(receipt.request),op.id,op.receiver_id,actor.name,receipt.appliedAt,receipt.deleted,historyOnly);
    scope = result.scope;
    if(scope === "receiver"){
      authorizeEveryday(before,result.state,actor.name);validateInventory(result.state);
      await commitInventory(tx,current,result.state,actor,`QR ${op.kind === "delete" ? "request archived" : `status ${op.target_status}`}${historyOnly ? "; kept current rent status" : ""}`);
    }
  }
  if(scope === "operation"){
    // Deleted/missing receivers retain the full authoritative record in this
    // ledger, without attaching old work to a reused number or inventing a row.
    await tx.prepare("INSERT INTO app_change_log(id,user_id,user_name,action,created_at) VALUES($1,$2,$3,$4,$5)")
      .bind(crypto.randomUUID(),actor.id,actor.name,"QR operation recorded; receiver absent, history retained in operation ledger",new Date().toISOString()).run();
  }
  await tx.prepare("UPDATE app_service_operations SET history_scope=$1 WHERE id=$2").bind(scope,op.id).run();
  return setPhase(tx,op,"done");
}

export async function processServiceOperation(store: Database,id: string) {
  try {
    return await store.transaction(async tx => {
      // Same order as inventory/account mutations; keep approval serialized
      // through the bounded remote attempt and the local history/audit commit.
      await tx.prepare("SELECT pg_advisory_xact_lock(728303)").run();
      const op = await lockedOperation(tx,id);
      if(!op || ["done","failed","needs_review"].includes(op.phase) || op.error_code === "restore_review")return op;
      if(!op.receipt){
        const target = serviceEndpoint("operations"),signal = AbortSignal.timeout(5000);
        target.searchParams.set("id",op.id);
        let result: unknown;
        try {
          result = await serviceFetch(target,"GET",undefined,signal);
          if(!result){
            const actor = await tx.prepare("SELECT id,name,role,active FROM app_users WHERE id=$1")
              .bind(op.approver_id).first<SessionUser & {active:number}>();
            if(!actor?.active || op.kind === "delete" && actor.role !== "admin")return setPhase(tx,op,"blocked","authorization");
            target.search = "";
            result = await serviceFetch(target,"PATCH",operationCommand(op),signal);
          }
          op.receipt = checkedReceipt(result,op);
        } catch { return setPhase(tx,op,"pending","remote_unavailable"); }
        await tx.prepare("UPDATE app_service_operations SET receipt=$1::jsonb WHERE id=$2").bind(JSON.stringify(op.receipt),op.id).run();
      }
      return finishHistory(tx,op);
    });
  } catch {
    // A history/audit failure rolls back the local attempt, including its receipt.
    // The durable QR receipt remains. A later process can fetch it and finish once.
    return store.transaction(async tx => {
      await tx.prepare("SELECT pg_advisory_xact_lock(728303)").run();
      const op = await lockedOperation(tx,id);
      if(!op || ["done","failed","needs_review"].includes(op.phase))return op;
      return setPhase(tx,op,"pending","history_unavailable");
    });
  }
}

export async function retryServiceOperation(request: Request,store: Database,id: string,historyOnly: boolean,baseRevision?: number) {
  const authorized = await store.transaction(async tx => {
    await tx.prepare("SELECT pg_advisory_xact_lock(728303)").run();
    const auth = await requireUser(request,undefined,tx);if(auth.response)return {response:auth.response,operation:null};
    let op = await lockedOperation(tx,id);
    if(!op)throw new AccessInputError("Operation not found.",404);
    if(auth.user!.role !== "admin" && (op.actor_id !== auth.user!.id || op.kind === "delete" || op.error_code === "restore_review"))
      throw new AccessInputError("Only its owner or an administrator may retry this operation.",403);
    if(["done","failed"].includes(op.phase))return {response:null,operation:op};
    await tx.prepare("UPDATE app_service_operations SET approver_id=$1,approver_name=$2 WHERE id=$3").bind(auth.user!.id,auth.user!.name,id).run();
    op = (await lockedOperation(tx,id))!;
    if(historyOnly){
      if(op.phase !== "needs_review" || !op.receipt || op.receipt.outcome !== "applied")
        throw new AccessInputError("This operation has no inventory conflict to review.",409);
      return {response:null,operation:await finishHistory(tx,op,true,baseRevision)};
    }
    if(op.phase === "needs_review")throw new AccessInputError("Review the rent-status conflict explicitly.",409);
    op = await setPhase(tx,op,"pending");
    return {response:null,operation:op};
  });
  if(authorized.response || historyOnly || !authorized.operation || ["done","failed"].includes(authorized.operation.phase))return authorized;
  return {response:null,operation:await processServiceOperation(store,id)};
}

// A separate VM process uses this bounded due queue; neither a browser nor GET
// requests drive automatic mutations. Review conflicts stay paused for staff.
export async function reconcileServiceOperations(store: Database,limit = 10,shouldStop = () => false) {
  if(!Number.isInteger(limit) || limit < 1 || limit > 10)throw new Error("Invalid reconciliation batch.");
  const rows = await store.prepare("SELECT id FROM app_service_operations WHERE phase IN ('pending','blocked') AND error_code <> 'restore_review' AND next_attempt_at <= now() ORDER BY next_attempt_at,id LIMIT $1")
    .bind(limit).all<{id:string}>();
  const result = {processed:0,pending:0,done:0,review:0,failed:0};
  for(const row of rows.results){
    if(shouldStop())break;
    const op = await processServiceOperation(store,row.id);if(!op)continue;
    result.processed++;
    if(op.phase === "done")result.done++;else if(op.phase === "failed")result.failed++;
    else if(op.phase === "needs_review")result.review++;else result.pending++;
  }
  return result;
}
