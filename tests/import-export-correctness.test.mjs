import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { inventory, history, when } from "./helpers/inventory-fixture.mjs";
import { validateInventory } from "../lib/inventory-state.ts";
import { authorizeEveryday } from "../lib/inventory-permissions.ts";

const source=await readFile(new URL("../public/asset-tracker/app.js",import.meta.url),"utf8");
const parsed=ts.createSourceFile("app.js",source,ts.ScriptTarget.Latest,true);
const copy=value=>JSON.parse(JSON.stringify(value));
function functions(names){
  const nodes=parsed.statements.filter(node=>ts.isFunctionDeclaration(node)&&names.includes(node.name?.text));
  assert.equal(nodes.length,names.length,"Exercise the actual browser functions, never replacement implementations.");
  return nodes.map(node=>node.getText(parsed)).join("\n");
}
function app(state=inventory(),role="admin"){
  let serial=0;
  const elements=new Map(),messages=[],saves=[];
  const context=vm.createContext({...copy(state),currentUser:{name:"testadmin",role},cloudReady:true,cloudWriteBlocked:false,
    currentAccountId:"account-0",pendingDataImport:null,pendingAccountImport:null,sessionEpoch:0,
    sessionActive:()=>true,makeId:()=>`synthetic-${++serial}`,
    $:id=>{if(!elements.has(id))elements.set(id,{});return elements.get(id);},
    toast:message=>messages.push(message),save:label=>saves.push({label,state:copy(contextState())}),
    closeModal(){},renderDashboard(){},renderAccounts(){},renderMaster(){},renderRentalStock(){},renderAccountDetail(){},
    reconcileRentalStock:()=>false,
  });
  const contextState=()=>Object.fromEntries(Object.keys(state).map(key=>[key,context[key]]));
  vm.runInContext(functions(["receiverImportProblem","updateImportedReceiver","updateImportedAccount","newImportedReceiver",
    "planReceiverImport","applyDataImport","showDataImportPreview","resetDataImport","cleanExcelValue","prepareWtxImport",
    "masterImportRecord","importValue","normalizeImportKey","prepareMasterImport","assignedFor","assignmentForAsset","assetById","accountById",
    "logReceiverEvent","setReceiverRentState","esc","applyAccountImport","prepareAccountImport","accountImportRecord","csvValue","normalizeCsvHeader","resetAccountImportModal"]),context);
  return {context,elements,messages,saves,state:()=>copy(contextState())};
}
function assignments(state,count,accountId="account-0",offset=0){
  for(let i=offset;i<offset+count;i++)state.assignments.push({id:`assignment-${i}`,assetId:`receiver-${i}`,accountId,assignedAt:when});
}
function record(assetNumber,accountNumber="000001",extra={}){
  return {assetNumber,accountNumber,accountName:"",accessCard:"",serial:"",rid:"",type:"",model:"",office:"",notes:"",...extra};
}
function preview(app,type,records){
  const plan=app.context.planReceiverImport(records,type==="West Texas XLSX");
  app.context.showDataImportPreview({type,fileName:"synthetic.xlsx",rows:records.length,...plan,preview:plan.entries,message:"Synthetic preview"});
  return copy(plan);
}

// Counts and state are verified together, including schema/ordinary permissions:
// a rejected row must not quietly add data to an otherwise valid saved payload.
test("West Texas preview and apply skip full accounts before registry/account/history side effects",()=>{
  const state=inventory(22);assignments(state,20);assignments(state,1,"account-1",20);
  state.receiverEvents=[history("keep-event","receiver-20")];
  const instance=app(state);
  const plan=preview(instance,"West Texas XLSX",[record("NEW-BLOCKED"),record("TEST-20","000001",{model:"Do not change"}),record("TEST-0")]);
  assert.equal(plan.warningCount,2);assert.equal(plan.data.length,1);assert.equal(plan.unchangedCount,1);
  assert.match(plan.entries[0].detail,/20-receiver/);
  instance.context.applyDataImport();
  assert.deepEqual(instance.state(),state);assert.equal(instance.saves.length,0);
  assert.match(instance.messages.at(-1),/0 assigned, 0 moved, 1 already.*2 skipped.*0 added/);
});

test("West Texas moves reserve capacity in file order and retain metadata, leading zeroes and history",()=>{
  const state=inventory(22);assignments(state,19);assignments(state,2,"account-1",19);
  state.accounts[0].location="Keep location";
  state.master[19]={...state.master[19],model:"Keep model",condition:"Bad",rentState:"On Rent",notes:"Keep notes"};
  state.receiverEvents=[history("keep-event","receiver-19")];
  const instance=app(state);
  const plan=preview(instance,"West Texas XLSX",[
    record("TEST-19","000001",{accessCard:"000009",rid:"000010",serial:"000011",office:"Field office"}),
    record("TEST-20"),record("NEW-OK","000004",{accountName:"New account",model:"HR54",notes:"Imported notes",office:"West"})]);
  assert.equal(plan.data.length,2);assert.equal(plan.warningCount,1);
  instance.context.applyDataImport();
  const after=instance.state();validateInventory(after);
  assert.equal(after.assignments.find(row=>row.assetId==="receiver-19").id,"assignment-19");
  assert.notEqual(after.assignments.find(row=>row.assetId==="receiver-19").assignedAt,when);
  assert.equal(after.assignments.filter(row=>row.accountId==="account-0").length,20);
  assert.equal(after.assignments.find(row=>row.assetId==="receiver-20").accountId,"account-1");
  assert.equal(after.accounts[0].name,state.accounts[0].name);assert.equal(after.accounts[0].location,"Keep location");
  assert.equal(after.accounts[0].office,"Field office");
  const receiver=after.master[19];assert.equal(receiver.accessCard,"000009");assert.equal(receiver.rid,"000010");assert.equal(receiver.serial,"000011");
  assert.equal(receiver.model,"Keep model");assert.equal(receiver.notes,"Keep notes");assert.equal(receiver.condition,"Bad");assert.equal(receiver.rentState,"On Rent");
  assert.ok(after.receiverEvents.some(row=>row.id==="keep-event"));
  assert.ok(after.receiverEvents.some(row=>row.receiverId==="receiver-19"&&row.title==="Moved to Account 000001"&&row.changedBy==="testadmin"));
  assert.equal(after.accounts.find(row=>row.number==="000004").office,"West");
  assert.equal(after.master.find(row=>row.assetNumber==="NEW-OK").notes,"Imported notes");
  assert.match(instance.messages.at(-1),/1 assigned, 1 moved, 0 already.*1 skipped.*1 added.*Awaiting sync/);
  assert.equal(instance.saves.length,1);
});

test("Apply rechecks capacity and keeps preview-skipped rows skipped even if room later opens",()=>{
  const state=inventory(22);assignments(state,19);
  const instance=app(state);
  preview(instance,"West Texas XLSX",[record("NEW-FIRST"),record("NEW-SKIPPED")]);
  instance.context.assignments.push({id:"later-assignment",assetId:"receiver-21",accountId:"account-0",assignedAt:when});
  const before=instance.state();instance.context.applyDataImport();
  assert.deepEqual(instance.state(),before);assert.equal(instance.saves.length,0);assert.match(instance.messages.at(-1),/2 skipped/);
  const other=app(state);preview(other,"West Texas XLSX",[record("NEW-FIRST"),record("NEW-SKIPPED")]);
  other.context.assignments.pop();other.context.applyDataImport();
  assert.ok(other.state().master.some(row=>row.assetNumber==="NEW-FIRST"));
  assert.equal(other.state().master.some(row=>row.assetNumber==="NEW-SKIPPED"),false);
});

test("new accounts respect the same capacity and earlier moves can free later slots without reordering",()=>{
  const created=app();preview(created,"West Texas XLSX",Array.from({length:21},(_,i)=>record(`NEW-${i}`,"000004")));
  created.context.applyDataImport();validateInventory(created.state());
  assert.equal(created.state().accounts.filter(row=>row.number==="000004").length,1);
  assert.equal(created.state().assignments.length,20);assert.equal(created.state().master.length,23);
  assert.match(created.messages.at(-1),/20 assigned.*1 skipped.*20 added/);
  const state=inventory(20);assignments(state,20);const moved=app(state);
  preview(moved,"West Texas XLSX",[record("TEST-0","000002"),record("NEW-LATER","000001")]);
  moved.context.applyDataImport();validateInventory(moved.state());
  assert.equal(moved.state().assignments.filter(row=>row.accountId==="account-0").length,20);
  assert.match(moved.messages.at(-1),/1 assigned, 1 moved.*0 skipped/);
  const canonical=app();canonical.context.accounts[0].number="AbC001";
  preview(canonical,"West Texas XLSX",[record("TEST-0","ABC001")]);canonical.context.applyDataImport();
  assert.equal(canonical.state().accounts.length,2);assert.equal(canonical.state().accounts[0].number,"AbC001");
});

test("Master previews reject duplicates/invalid fields and apply counts changed and unchanged records",async()=>{
  const instance=app();
  instance.context.readExcelBook=async()=>({});
  instance.context.readNamedSheet=()=>[
    {"Asset Number":"TEST-0","Access Card":"000008"},{"Asset Number":"NEW-001","Receiver ID":"000002"},
    {"Asset Number":"new-001","Receiver ID":"999"},{"Asset Number":"TEST-1"},
    {"Asset Number":"BAD=ID"},{"Asset Number":"TOO-LONG","Model":"x".repeat(129)},
  ];
  await instance.context.prepareMasterImport({name:"synthetic.xlsx"});
  assert.equal(instance.elements.get("dataNewCount").textContent,1);assert.equal(instance.elements.get("dataUpdateCount").textContent,1);
  assert.equal(instance.elements.get("dataWarningCount").textContent,3);
  instance.context.applyDataImport();validateInventory(instance.state());
  assert.equal(instance.state().master[0].accessCard,"000008");
  assert.equal(instance.state().master.find(row=>row.assetNumber==="NEW-001").rid,"000002");
  assert.match(instance.messages.at(-1),/1 new, 1 updated, 1 unchanged, 3 skipped/);
});

test("West Texas grouped names reset on a new account and apply preserves source office/notes",async()=>{
  const instance=app();
  instance.context.readExcelBook=async()=>({});
  const row=(asset,number,name)=>{const cells=Array(14).fill("");cells[1]=asset;cells[7]=number;cells[8]=name;cells[2]="000001";cells[12]="Office";cells[13]="Notes";return cells;};
  instance.context.readWestTexasRows=()=>[row("NEW-1","000004","First customer"),row("NEW-2","",""),row("NEW-3","000005","")];
  await instance.context.prepareWtxImport({name:"synthetic.xlsx"});
  assert.equal(instance.context.pendingDataImport.data[1].accountName,"First customer");
  assert.equal(instance.context.pendingDataImport.data[2].accountName,"");
  instance.context.applyDataImport();validateInventory(instance.state());
  assert.equal(instance.state().accounts.find(row=>row.number==="000005").name,"Account 000005");
  assert.ok(instance.state().master.filter(row=>row.assetNumber.startsWith("NEW-")).every(row=>row.accessCard==="000001"&&row.notes==="Notes"));
});

test("Account import rechecks capacity/assignment/target and regular imports match server one-receiver permissions",async()=>{
  const state=inventory(21);assignments(state,19);
  const instance=app(state);instance.context.readAccountImportRows=async()=>[{assetnumber:"NEW-1"},{assetnumber:"NEW-2"}];
  await instance.context.prepareAccountImport({name:"synthetic.csv"});
  instance.context.assignments.push({id:"later",assetId:"receiver-20",accountId:"account-0",assignedAt:when});
  const before=instance.state();instance.context.applyAccountImport();assert.deepEqual(instance.state(),before);assert.equal(instance.saves.length,0);
  assert.match(instance.messages.at(-1),/0 assigned.*2 skipped/);
  const staff=app(inventory(),"user");
  staff.context.readAccountImportRows=async()=>[{assetnumber:"NEW-1",accesscard:"000001"},{assetnumber:"NEW-2"}];
  await staff.context.prepareAccountImport({name:"synthetic.csv"});
  assert.equal(staff.elements.get("accountImportReady").textContent,1);
  staff.context.applyAccountImport();const next=staff.state();validateInventory(next);
  assert.equal(next.master.at(-1).accessCard,"000001");assert.equal(next.assignments.length,1);
  authorizeEveryday(inventory(),next,"testadmin");assert.equal(next.receiverEvents.length,1);
  const assigned=app();assigned.context.readAccountImportRows=async()=>[{assetnumber:"TEST-0",model:"Do not change"}];
  await assigned.context.prepareAccountImport({name:"synthetic.csv"});
  assigned.context.assignments.push({id:"later",assetId:"receiver-0",accountId:"account-1",assignedAt:when});
  const assignedBefore=assigned.state();assigned.context.applyAccountImport();assert.deepEqual(assigned.state(),assignedBefore);
  const switched=app();switched.context.readAccountImportRows=async()=>[{assetnumber:"TEST-0"}];
  await switched.context.prepareAccountImport({name:"synthetic.csv"});switched.context.currentAccountId="account-1";
  switched.context.applyAccountImport();assert.equal(switched.state().assignments.length,0);assert.match(switched.messages.at(-1),/target account changed/);
});

test("stale account reads and blocked/nonadmin Import Center applications do not mutate inventory",async()=>{
  const instance=app();let finish;
  instance.context.readAccountImportRows=()=>new Promise(resolve=>{finish=resolve;});
  const loading=instance.context.prepareAccountImport({name:"synthetic.csv"});instance.context.currentAccountId="account-1";
  finish([{assetnumber:"TEST-0"}]);await loading;assert.equal(instance.context.pendingAccountImport,null);
  for(const [role,blocked] of [["user",false],["admin",true]]){
    const checked=app(inventory(),role);preview(checked,"West Texas XLSX",[record("NEW-1")]);checked.context.cloudWriteBlocked=blocked;
    checked.context.applyDataImport();assert.deepEqual(checked.state(),inventory());assert.equal(checked.saves.length,0);
  }
});

test("TQ reports count unchanged and disappeared rows without inventing inventory saves",()=>{
  const instance=app();instance.context.pendingDataImport={type:"TQ Report CSV",data:[{id:"receiver-0",rentState:"Off Rent"},{id:"gone",rentState:"On Rent"}],skippedCount:2,ignoredCount:3};
  instance.context.applyDataImport();assert.equal(instance.saves.length,0);assert.match(instance.messages.at(-1),/0 updated, 1 unchanged, 3 skipped, 3 company-wide/);
  const legacy=app();legacy.context.master[0].offRentSince="";
  legacy.context.pendingDataImport={type:"TQ Report CSV",data:[{id:"receiver-0",rentState:"Off Rent"}]};
  legacy.context.applyDataImport();assert.ok(legacy.state().master[0].offRentSince);assert.equal(legacy.saves.length,1);
  assert.equal(legacy.state().receiverEvents.length,0);assert.match(legacy.messages.at(-1),/1 updated, 0 unchanged/);
});

const library=vm.createContext({});vm.runInContext(await readFile(new URL("../public/asset-tracker/vendor/xlsx-0.20.3.full.min.js",import.meta.url),"utf8"),library);
const XLSX=library.XLSX;
function cells(csv){const book=XLSX.read(csv,{type:"string",raw:true});return XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]],{header:1,raw:true,defval:""});}

test("CSV exports quote every field and protect formula/control/full-width prefixes and numeric identifiers",()=>{
  const context=vm.createContext({});vm.runInContext(functions(["csvCell"]),context);
  const dangerous=["=1+1","+SUM(1,2)","-1+2","@SUM(A1)"," \t=1+1","\r\n=1+1","\0=1+1","＝1+1"," ＋1","－1","＠SUM(A1)"];
  for(const text of dangerous){
    const csv=context.csvCell(text);assert.ok(csv.startsWith('"\t'));
    assert.equal(cells(csv)[0][0],`\t${text}`);
  }
  for(const text of ["000001","12345678901234567890"])assert.equal(cells(context.csvCell(text))[0][0],`\t${text}`);
  for(const text of ['comma, quote " and\nnewline',';=1+1','https://example.invalid/','ordinary text'])assert.equal(cells(context.csvCell(text))[0][0],text);
  assert.equal(context.csvCell(20),'"20"');assert.equal(context.csvCell(null),'""');
});

test("account, audit and activity CSV downloads share protection and retain exact originals in inventory",()=>{
  const downloads=[];
  const context=vm.createContext({toast(){},downloadFile:(name,text,type)=>downloads.push({name,text,type}),
    auditState:{results:[{}]},auditIssues:()=>[{result:{accountNumber:"000001",accountName:"=1+1"},issue:{assetNumber:"000002",accessCard:"000003",rid:"000004",notes:'=SUM(1,2)"\n@SUM(A1)',status:"needs-research"},source:"app"}],
    auditStatusLabel:()=>"Needs Research",reportRows:()=>[{account:{number:"000001",name:"+Name",office:"＠Office"},assigned:2,onRent:1,offRent:1,available:18,audit:"Not Audited"}],
    filteredActivity:()=>[{user_name:"=Name",action:"@Action",revision:2,created_at:when}],activityType:()=>"Data change"});
  vm.runInContext(functions(["csvCell","exportAuditCsv","exportReportCsv","exportActivityCsv"]),context);
  context.exportAuditCsv();context.exportReportCsv();context.exportActivityCsv();assert.equal(downloads.length,3);
  const audit=cells(downloads[0].text);assert.equal(audit[1][0],"\t000001");assert.equal(audit[1][1],"\t=1+1");assert.equal(audit[1][7],'\t=SUM(1,2)"\n@SUM(A1)');
  const report=cells(downloads[1].text);assert.equal(report[1][0],"\t000001");assert.equal(report[1][1],"\t+Name");assert.equal(report[1][2],"\t＠Office");assert.equal(report[1][3],"2");
  const activity=cells(downloads[2].text);assert.equal(activity[1][0],"\t=Name");assert.equal(activity[1][2],"\t@Action");
  assert.ok(downloads.every(file=>file.type==="text/csv;charset=utf-8"));
});
