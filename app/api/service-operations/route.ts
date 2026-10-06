import { db, requireUser } from "../../../lib/pin-auth";
import { AccessInputError, accessError, readAccessBody } from "../../../lib/access-input";
import { ListingInputError, readRecordList, literalSearch, recordPage } from "../../../lib/record-list";
import { validOperationId } from "../../../lib/service-protocol";
import { operationSummary, retryServiceOperation, type ServiceOperation } from "../../../lib/service-operations";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (value:unknown,status=200) => Response.json(value,{status,headers:{"cache-control":"no-store"}});

// Staff can inspect the same private request history already available in the
// tracker. Only the initiating account or an admin may approve a retry/review.
export async function GET(request: Request) {
  try {
    const auth = await requireUser(request);if(auth.response)return auth.response;
    const url = new URL(request.url);
    if(url.searchParams.has("id")){
      if(url.searchParams.size !== 1 || !validOperationId(url.searchParams.get("id")))throw new AccessInputError("Use a valid operation ID.");
      const op = await db().prepare("SELECT * FROM app_service_operations WHERE id=$1").bind(url.searchParams.get("id")).first<ServiceOperation>();
      return op ? json({operation:operationSummary(op,auth.user!),request:op.receipt?.request ?? op.snapshot}) : json({error:"Operation not found."},404);
    }
    const list = readRecordList(url,"operations"),values: unknown[] = [],where: string[] = [];
    const bind = (value:unknown) => {values.push(value);return `$${values.length}`;};
    if(list.status === "active")where.push("phase IN ('pending','blocked','needs_review')");
    else if(list.status !== "all")where.push(`phase=${bind(list.status)}`);
    if(list.q)where.push(`concat_ws(' ',request_id,snapshot->>'assetNumber',actor_name,approver_name,notes) ILIKE ${bind(literalSearch(list.q))} ESCAPE '\\'`);
    if(list.after && !validOperationId(list.after.id))throw new AccessInputError("Use a valid operation cursor.");
    if(list.after)where.push(`(updated_at,id)<(${bind(list.after.time)},${bind(list.after.id)}::uuid)`);
    const rows = await db().prepare(`SELECT * FROM app_service_operations ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY updated_at DESC,id DESC LIMIT ${bind(list.limit+1)}`).bind(...values).all<ServiceOperation>();
    const {records,page} = recordPage(rows.results,list,row => row.updated_at);
    return json({operations:records.map(op => operationSummary(op,auth.user!)),page});
  } catch(error) {
    return accessError(error instanceof ListingInputError ? new AccessInputError(error.message) : error,"Service operation history unavailable.");
  }
}
export async function POST(request: Request) {
  try {
    const auth = await requireUser(request);if(auth.response)return auth.response;
    const body = await readAccessBody(request);
    if(Object.keys(body).some(key => !["id","mode","baseRevision"].includes(key)) || !validOperationId(body.id) || !["retry","history-only"].includes(body.mode as string))
      throw new AccessInputError("Use a valid operation and explicit retry/review choice.");
    if(body.mode === "history-only" && (typeof body.baseRevision !== "number" || !Number.isSafeInteger(body.baseRevision) || body.baseRevision < 0))
      throw new AccessInputError("Refresh inventory before reviewing service history.");
    const result = await retryServiceOperation(request,db(),body.id,body.mode === "history-only",body.baseRevision as number|undefined);
    if(result.response)return result.response;
    const operation = result.operation!;
    return json({operation:operationSummary(operation,auth.user!)},operation.phase === "done" ? 200 : operation.phase === "failed" ? 409 : 202);
  } catch(error) { return accessError(error,"Service operation retry failed."); }
}
