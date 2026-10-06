import { db, requireUser } from "../../../lib/pin-auth";
import { AccessInputError, accessError, readAccessBody } from "../../../lib/access-input";
import { ListingInputError, readRecordList } from "../../../lib/record-list";
import { serviceCommand } from "../../../lib/service-protocol";
import { serviceEndpoint, readServiceBody } from "../../../lib/service-remote";
import { stageServiceOperation, processServiceOperation, operationSummary, type ServiceOperation } from "../../../lib/service-operations";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const initial = await requireUser(request);if(initial.response)return initial.response;
    const target = serviceEndpoint(),list = readRecordList(new URL(request.url),"requests");target.search = new URL(request.url).search;
    return await db().transaction(async tx => {
      // Recheck after the account lock and consume the bounded response before
      // releasing authorization, exactly as account edits/revocation require.
      await tx.prepare("SELECT pg_advisory_xact_lock(728303)").run();
      const auth = await requireUser(request,undefined,tx);if(auth.response)return auth.response;
      const response = await fetch(target,{signal:AbortSignal.timeout(5000),redirect:"error",
        headers:{authorization:`Bearer ${process.env.ADMIN_SHARED_SECRET}`}});
      const body = await readServiceBody(response);
      if(!response.ok)return new Response(body,{status:response.status,headers:{"content-type":"application/json","cache-control":"no-store"}});
      const result = JSON.parse(body);
      if(!Array.isArray(result.requests) || result.requests.length > list.limit)throw new Error("Invalid internal list.");
      const ids = result.requests.map((row: {id:string}) => row.id);
      const active = await tx.prepare("SELECT * FROM app_service_operations WHERE request_id=ANY($1::text[]) AND phase IN ('pending','blocked','needs_review')")
        .bind(ids).all<ServiceOperation>();
      const byRequest = new Map(active.results.map(op => [op.request_id,operationSummary(op,auth.user!)]));
      result.requests = result.requests.map((row: {id:string}) => ({...row,synchronization:byRequest.get(row.id) ?? null}));
      return Response.json(result,{headers:{"cache-control":"no-store"}});
    });
  } catch(error) {
    return accessError(error instanceof ListingInputError ? new AccessInputError(error.message) : error,"Service request synchronization failed.");
  }
}

// Acceptance is a durable intent commit, not a promise that both databases have
// already changed. Every browser retry supplies the SAME UUID and request version.
async function mutate(request: Request,kind: "status"|"delete") {
  try {
    const initial = await requireUser(request,kind === "delete" ? "admin" : undefined);if(initial.response)return initial.response;
    const body = await readAccessBody(request,{limit:8192,label:"Service operation"}),allowed = kind === "status" ?
      ["operationId","id","status","notes","expectedVersion","baseRevision"] : ["operationId","expectedVersion","baseRevision"];
    if(Object.keys(body).some(key => !allowed.includes(key)))throw new AccessInputError("Unsupported service operation fields.");
    const params = new URL(request.url).searchParams;
    if(kind === "delete" && (params.size !== 1 || !params.has("id")) || kind === "status" && params.size)
      throw new AccessInputError("Use a valid service operation selector.");
    const baseRevision = body.baseRevision;
    if(typeof baseRevision !== "number" || !Number.isSafeInteger(baseRevision) || baseRevision < 0)
      throw new AccessInputError("Refresh inventory before changing QR status.");
    const command = serviceCommand({operationId:body.operationId,id:kind === "delete" ? params.get("id") : body.id,
      kind,expectedVersion:body.expectedVersion,status:kind === "status" ? body.status : null,notes:body.notes === undefined ? "" : body.notes});
    const staged = await stageServiceOperation(request,db(),command,baseRevision);
    if(staged.response)return staged.response;
    let operation = staged.operation!;
    try { operation = await processServiceOperation(db(),operation.id) ?? operation; } catch { /* Committed intent survives a database outage. */ }
    const status = operation.phase === "done" ? 200 : operation.phase === "failed" ? 409 : 202;
    return Response.json({accepted:true,operation:operationSummary(operation,initial.user!)},
      {status,headers:{"cache-control":"no-store"}});
  } catch(error) { return accessError(error,"Service request synchronization failed."); }
}
export function PATCH(request: Request) { return mutate(request,"status"); }
export function DELETE(request: Request) { return mutate(request,"delete"); }
