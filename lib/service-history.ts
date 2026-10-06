import { createHash } from "node:crypto";
import { validateInventory, type InventoryState, type InventoryRecord } from "./inventory-state.ts";
import type { ServiceSnapshot } from "./service-protocol.ts";

export function rentBaseline(receiver: InventoryRecord) {
  return {rentState:receiver.rentState,offRentSince:receiver.offRentSince ?? ""};
}
// The coordinator edits one associated receiver from current server inventory,
// never a browser snapshot. Stable identity is resolved once when intent is saved.
export function serviceHistory(state: InventoryState, snapshot: ServiceSnapshot, operationId: string,
  receiverId: string | null, actor: string, time: string, deleted: boolean, historyOnly = false) {
  const next = structuredClone(state), receiver = next.master.find(row => row.id === receiverId);
  if(!receiver)return {state:next,scope:"operation" as const};
  if(!deleted && snapshot.status === "Completed" && !historyOnly){
    const desired = snapshot.action === "Deactivate" ? "Off Rent" : "On Rent";
    const previous = receiver.rentState;receiver.rentState = desired;
    if(desired === "On Rent")receiver.offRentSince = "";
    else if(previous !== "Off Rent" || !receiver.offRentSince)receiver.offRentSince = time;
  }
  const added: InventoryRecord[] = [{id:`qr:${operationId}`,receiverId:receiver.id,activationId:snapshot.id,
    title:`${snapshot.action || "Service"} request ${deleted ? "archived" : snapshot.status.toLowerCase()}`,
    detail:[snapshot.status,snapshot.accountNumber ? `Account ${snapshot.accountNumber}` : "",snapshot.errorCode ? `Error ${snapshot.errorCode}` : ""].filter(Boolean).join(" · "),
    kind:"service",date:time,changedBy:actor,status:snapshot.status,action:snapshot.action,
    requestedAt:snapshot.requestedAt,completedAt:snapshot.completedAt ?? "",accountNumber:snapshot.accountNumber,
    accountName:snapshot.accountName,notes:snapshot.notes,errorCode:snapshot.errorCode,operatorName:snapshot.operatorName,
    requesterName:snapshot.requesterName,requesterPhone:snapshot.requesterPhone,rigFrac:snapshot.rigFrac,lease:snapshot.lease,
    mapUrl:snapshot.mapUrl,gpsAccuracy:snapshot.gpsAccuracy,source:"QR"}];
  // Match the normal save's derived stock release, including already On Rent
  // members. Do not rewrite manager names, membership or removed-item history.
  const batch = next.rentalStock.batches.find(row => row.status === "Active");
  if(batch){
    const rent = new Map(next.master.map(row => [row.id,row.rentState]));
    for(const item of batch.items as Record<string,unknown>[]){
      if(item.removedAt || item.releasedAt || rent.get(item.receiverId as string) !== "On Rent")continue;
      item.releasedAt = time;
      const id = createHash("sha256").update(`${operationId}:${item.receiverId}`).digest("hex").slice(0,40);
      added.unshift({id:`qrs:${id}`,receiverId:item.receiverId as string,title:"Released from rental manager stock",
        detail:`Batch ${batch.batchNumber} · Receiver On Rent`,kind:"rent",date:time,changedBy:actor});
    }
    if((batch.receiverIds as string[]).every(id => rent.get(id) === "On Rent")){batch.status = "Completed";batch.completedAt = time;}
  }
  const counts = new Map<string,number>();
  next.receiverEvents = [...added,...next.receiverEvents].filter(row => {
    counts.set(row.receiverId as string,(counts.get(row.receiverId as string) ?? 0) + 1);
    return counts.get(row.receiverId as string)! <= 20;
  }).slice(0,20000);
  return {state:validateInventory(next),scope:"receiver" as const};
}
