import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { serviceCommand, serviceFingerprint, serviceSnapshot } from "../lib/service-protocol.ts";
import { serviceHistory } from "../lib/service-history.ts";
import { validateInventory } from "../lib/inventory-state.ts";
import { authorizeEveryday } from "../lib/inventory-permissions.ts";
import { inventory, batch, history, when } from "./helpers/inventory-fixture.mjs";

import { snapshot } from "./helpers/service-fixture.mjs";
const command=()=>({operationId:randomUUID(),id:"request-1",kind:"status",expectedVersion:1,status:"Completed",notes:"Synthetic notes"});

test("service command is bounded, versioned, immutable and rejects client metadata",()=>{
  const base=command();assert.deepEqual(serviceCommand(base),base);
  for(const change of [{operationId:"bad"},{expectedVersion:0},{expectedVersion:1.1},{expectedVersion:2147483647},
    {id:"<img>"},{status:"forged"},{kind:"forged"},{notes:null},{notes:"a".repeat(2049)},{notes:"bad\0text"},{assetNumber:"forged"}])
    assert.throws(()=>serviceCommand({...base,...change}));
  assert.equal(serviceCommand({...base,kind:"delete",status:null}).status,null);
  assert.throws(()=>serviceCommand({...base,kind:"delete"}));
  assert.equal(serviceFingerprint(base),serviceFingerprint({...base,operationId:randomUUID()}));
  for(const change of [{expectedVersion:2},{status:"Cancelled"},{notes:"Other"},{kind:"delete",status:null}])
    assert.notEqual(serviceFingerprint(base),serviceFingerprint({...base,...change}));
});
test("private service snapshot validates preserved identifiers, dates, text and maps",()=>{
  const base=snapshot();assert.deepEqual(serviceSnapshot(base),base);
  assert.equal(serviceSnapshot({...base,completedAt:null}).completedAt,null);
  for(const change of [{assetNumber:"<img>"},{assetId:"<img>"},{accountNumber:"=formula"},{requestedAt:"invalid"},
    {completedAt:"invalid"},{requesterPhone:"x".repeat(41)},{notes:"x".repeat(2049)},{mapUrl:"javascript:alert(1)"},{mapUrl:"https://maps.google.com.evil.test"},{gpsAccuracy:null}])
    assert.throws(()=>serviceSnapshot({...base,...change}));
});
test("QR completion uses stable identity, preserves fields and releases rental stock under ordinary permissions",()=>{
  const state=inventory();state.master[0].notes="Keep this note";state.master[0].assetNumber="RENAMED";
  state.master[1].assetNumber="TEST-0";state.rentalStock.batches=[batch(state)];
  const op=randomUUID(),result=serviceHistory(state,snapshot(),op,"receiver-0","testuser",when,false);
  assert.equal(result.scope,"receiver");assert.equal(result.state.master[0].rentState,"On Rent");
  assert.equal(result.state.master[0].offRentSince,"");assert.equal(result.state.master[0].notes,"Keep this note");
  assert.equal(result.state.master[1].rentState,"Off Rent");assert.equal(state.master[0].rentState,"Off Rent");
  assert.equal(result.state.rentalStock.batches[0].items[0].releasedAt,when);
  assert.equal(result.state.rentalStock.batches[0].items[1].releasedAt,"");
  assert.equal(result.state.receiverEvents.length,2);
  assert.equal(result.state.receiverEvents.find(row=>row.id===`qr:${op}`).gpsAccuracy,0);
  assert.match(authorizeEveryday(state,result.state,"testuser"),/receiver/);validateInventory(result.state);
});
test("derived stock completion releases all current On Rent members without rewriting membership",()=>{
  const state=inventory();state.rentalStock.batches=[batch(state)];state.master.slice(1).forEach(row=>{row.rentState="On Rent";row.offRentSince="";});
  const result=serviceHistory(state,snapshot(),randomUUID(),"receiver-0","testuser",when,false);
  assert.equal(result.state.rentalStock.batches[0].status,"Completed");
  assert.ok(result.state.rentalStock.batches[0].items.every(row=>row.releasedAt===when));
  assert.deepEqual(result.state.rentalStock.batches[0].receiverIds,state.rentalStock.batches[0].receiverIds);
  authorizeEveryday(state,result.state,"testuser");validateInventory(result.state);
});
test("reopen, cancellation, archival and explicit history-only review preserve current rent state",()=>{
  for(const [status,deleted,historyOnly] of [["Pending",false,false],["Cancelled",false,false],["Completed",true,false],["Completed",false,true]]){
    const state=inventory();const result=serviceHistory(state,{...snapshot(),status,completedAt:status==="Completed"?when:null},randomUUID(),"receiver-0","testuser",when,deleted,historyOnly);
    assert.deepEqual(result.state.master,state.master);assert.equal(result.state.receiverEvents.length,1);
    assert.equal(result.state.receiverEvents[0].status,status);
    authorizeEveryday(state,result.state,"testuser");
  }
});
test("receiver event limits preserve unaffected subjects and long notes do not overflow detail",()=>{
  const state=inventory();state.receiverEvents=Array.from({length:20},(_,i)=>history(`prior-${i}`));state.receiverEvents.push(history("unrelated","receiver-1"));
  const result=serviceHistory(state,{...snapshot(),notes:"中".repeat(2048)},randomUUID(),"receiver-0","testuser",when,false);
  assert.equal(result.state.receiverEvents.filter(row=>row.receiverId==="receiver-0").length,20);
  assert.ok(result.state.receiverEvents.some(row=>row.id==="unrelated"));
  assert.equal(result.state.receiverEvents[0].notes.length,2048);assert.ok(result.state.receiverEvents[0].detail.length<2048);
  authorizeEveryday(state,result.state,"testuser");
});
test("absent receiver archives only in the operation ledger and never falls back to a reused number",()=>{
  const state=inventory();const result=serviceHistory(state,snapshot(),randomUUID(),"deleted-receiver","testuser",when,false);
  assert.equal(result.scope,"operation");assert.deepEqual(result.state,state);
});
