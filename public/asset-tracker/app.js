// Browser caches bootstrap the UI before the authenticated shared-state read.
// They are device-wide and currently survive sign-out (DATA-04), not full backups.
const KEYS={
  master:"atp.master.v5",
  accounts:"atp.accounts.v5",
  assignments:"atp.assignments.v5",
  activations:"atp.activations.v1",
  receiverHistory:"atp.receiver-history.v1",
  rentalStock:"atp.rental-stock.v1",
  undo:"atp.undo.v1"
};
const makeId=()=>globalThis.crypto?.randomUUID?.()||`atp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`;
const PUBLIC_SERVICE_REQUEST_URL=window.TANMAR_CONFIG?.serviceRequestUrl||"http://localhost:5174/";
const SERVICE_REQUEST_API="/api/service-requests";
const serviceRequestHeaders=()=>({});
const CLOUD_STATE_API="/api/app-state";
const CLOUD_POLL_MS=12000;
const DIRECTV_RECIPIENT_KEY="tanmar.directv-recipient.v1";
const DEACTIVATION_BATCH_SIZE=10;
let selectedOverdueIds=new Set();
let deactivationBatches=[];

// Demonstration records only; source checkout does not contain production data.
// Live migration must use separately authorized exports (MIG-01).
const seedMaster=[
{id:makeId(),assetNumber:"43MTX5033HD",model:"HR54-700",accessCard:"001234567890",rid:"0349583945",serial:"A1B2C3D4",type:"Genie",rentState:"On Rent"},
{id:makeId(),assetNumber:"43MTX1168HD",model:"H25-500",accessCard:"001234567893",rid:"0391172840",serial:"MTX11680",type:"HD",rentState:"Off Rent"},
{id:makeId(),assetNumber:"43HOB2147HD",model:"H24-700",accessCard:"001234567891",rid:"0384412098",serial:"HOB77211",type:"HD",rentState:"On Rent"},
{id:makeId(),assetNumber:"43CAR8812HD",model:"HR24-500",accessCard:"001234567892",rid:"0357718204",serial:"CAR88291",type:"DVR",rentState:"Off Rent"}
];
const seedAccounts=[
{id:makeId(),number:"10024587",name:"Tanmar Rentals - Midland",location:"Midland",office:"Midland Yard"},
{id:makeId(),number:"10039812",name:"Tanmar Rentals - Hobbs",location:"Hobbs",office:"Hobbs Office"},
{id:makeId(),number:"10077421",name:"Carlsbad Operations",location:"Carlsbad",office:"Carlsbad Yard"}
];

let master=load(KEYS.master,seedMaster);
let accounts=load(KEYS.accounts,seedAccounts);

const seedAssignments=(master.length>=4 && accounts.length>=3) ? [
{id:makeId(),assetId:master[0].id,accountId:accounts[0].id,assignedAt:new Date().toISOString()},
{id:makeId(),assetId:master[1].id,accountId:accounts[0].id,assignedAt:new Date().toISOString()},
{id:makeId(),assetId:master[2].id,accountId:accounts[1].id,assignedAt:new Date().toISOString()},
{id:makeId(),assetId:master[3].id,accountId:accounts[2].id,assignedAt:new Date().toISOString()}
] : [];

let assignments=load(KEYS.assignments,seedAssignments);
let activations=load(KEYS.activations,[]);
let receiverEvents=load(KEYS.receiverHistory,[]);
let rentalStock=load(KEYS.rentalStock,{batches:[]});
let remoteActivations=[];
let remoteActivationLoading=false;
let undoHistory=load(KEYS.undo,[]);
let currentAccountId=null;
let currentReceiverInfoId=null;
let receiverHistoryExpanded=false;
let pendingAuditIssueId=null;
let currentUser=null;
let authNeedsSetup=false;
let currentCloudAction="Data change";
let activityRecords=[];
let cloudRevision=0;
let cloudReady=false;
let cloudSaving=false;
let cloudQueued=false;
let cloudSaveTimer=null;
let cloudPollTimer=null;
const expandedAccountIds=new Set();
const selectedLabelIds=new Set();

function load(key,fallback){
  try{
    const stored=localStorage.getItem(key);
    return stored===null ? fallback : JSON.parse(stored);
  }catch{
    return fallback;
  }
}
// Undo snapshots read the last cached version rather than current in-memory edits.
// auditState is absent here, and restoreUndoEntry omits rentalStock (DATA-03).
function persistedState(){
  return {
    master:load(KEYS.master,[]),
    accounts:load(KEYS.accounts,[]),
    assignments:load(KEYS.assignments,[]),
    activations:load(KEYS.activations,[]),
    receiverEvents:load(KEYS.receiverHistory,[]),
    rentalStock:load(KEYS.rentalStock,{batches:[]})
  };
}

function liveState(){return {master,accounts,assignments,activations,receiverEvents,rentalStock}}

function persistUndoHistory(){
  while(undoHistory.length){
    try{localStorage.setItem(KEYS.undo,JSON.stringify(undoHistory));return true}catch{undoHistory.pop()}
  }
  try{localStorage.removeItem(KEYS.undo)}catch{}
  return false;
}

function recordUndo(label="Data change",force=false){
  const previous=persistedState();
  const current=liveState();
  const comparableCurrent={master,accounts,assignments,activations,receiverEvents,rentalStock};
  if(!force&&JSON.stringify(previous)===JSON.stringify(comparableCurrent))return;
  undoHistory.unshift({id:makeId(),label,createdAt:new Date().toISOString(),changedBy:currentUser?.name||"Unknown",state:previous});
  undoHistory=undoHistory.slice(0,30);
  persistUndoHistory();
}

// Cache first, then enqueue the shared save. Storage quota errors currently stop
// execution before scheduling persistence; preserve edits when fixing DATA-01.
function save(label="Data change",{skipUndo=false}={}){
  if(!skipUndo)recordUndo(label);
  localStorage.setItem(KEYS.master,JSON.stringify(master));
  localStorage.setItem(KEYS.accounts,JSON.stringify(accounts));
  localStorage.setItem(KEYS.assignments,JSON.stringify(assignments));
  localStorage.setItem(KEYS.activations,JSON.stringify(activations));
  localStorage.setItem(KEYS.receiverHistory,JSON.stringify(receiverEvents));
  localStorage.setItem(KEYS.rentalStock,JSON.stringify(rentalStock));
  updateUndoControls();
  scheduleCloudSave(label);
}

// This is the full operational payload sent to the tracker API; users, sessions,
// server logs/history, and QR service requests live outside this browser object.
function cloudState(){
  return {
    master,
    accounts,
    assignments,
    activations,
    receiverEvents,
    auditState,rentalStock
  };
}

function isUntouchedStarterData(){
  const starterAssets=["43CAR8812HD","43HOB2147HD","43MTX1168HD","43MTX5033HD"];
  const currentAssets=master.map(item=>item.assetNumber).sort();
  return (
    JSON.stringify(currentAssets)===JSON.stringify(starterAssets) &&
    accounts.length===3 &&
    assignments.length===4 &&
    activations.length===0 &&
    receiverEvents.length===0 &&
    !load("atp.audit.v8",null)
  );
}

function setCloudStatus(state,detail=""){
  const chip=$("cloudSyncButton");
  const footer=document.querySelector(".sidebar-footer");
  const badge=$("cloudStorageBadge");
  if(!chip||!footer)return;
  chip.classList.remove("synced","saving","error");
  footer.classList.remove("cloud-saving","cloud-error");
  badge?.classList.remove("error");
  if(state==="synced")chip.classList.add("synced");
  if(state==="saving"){chip.classList.add("saving");footer.classList.add("cloud-saving")}
  if(state==="error"){chip.classList.add("error");footer.classList.add("cloud-error");badge?.classList.add("error")}
  const labels={connecting:"Connecting",saving:"Saving",synced:"Cloud synced",error:"Sync offline"};
  const titles={connecting:"Connecting to cloud",saving:"Saving to cloud",synced:"Cloud Sync Ready",error:"Cloud sync offline"};
  $("cloudSyncLabel").textContent=labels[state]||labels.connecting;
  $("cloudStatusTitle").textContent=titles[state]||titles.connecting;
  $("cloudStatusDetail").textContent=detail||({
    connecting:"Checking shared data…",
    saving:"Uploading latest changes…",
    synced:"Shared records are current",
    error:"Changes remain on this browser"
  }[state]);
  if(badge)badge.textContent=state==="synced"?"Connected":state==="saving"?"Saving":state==="error"?"Offline":"Connecting";
  if($("cloudStorageDescription")&&detail)$("cloudStorageDescription").textContent=detail;
}

function persistCloudState(state){
  master=Array.isArray(state.master)?state.master:[];
  accounts=Array.isArray(state.accounts)?state.accounts:[];
  assignments=Array.isArray(state.assignments)?state.assignments:[];
  activations=Array.isArray(state.activations)?state.activations:[];
  receiverEvents=Array.isArray(state.receiverEvents)?state.receiverEvents:[];
  rentalStock=state.rentalStock&&Array.isArray(state.rentalStock.batches)?state.rentalStock:{batches:[]};
  rentalStock=state.rentalStock&&Array.isArray(state.rentalStock.batches)?state.rentalStock:{batches:[]};
  if(Object.prototype.hasOwnProperty.call(state,"auditState"))auditState=state.auditState&&typeof state.auditState==="object"?state.auditState:null;
  localStorage.setItem(KEYS.master,JSON.stringify(master));
  localStorage.setItem(KEYS.accounts,JSON.stringify(accounts));
  localStorage.setItem(KEYS.assignments,JSON.stringify(assignments));
  localStorage.setItem(KEYS.activations,JSON.stringify(activations));
  localStorage.setItem(KEYS.receiverHistory,JSON.stringify(receiverEvents));
  localStorage.setItem(KEYS.rentalStock,JSON.stringify(rentalStock));
  persistAuditCache(auditState);
}

function renderCloudState(){
  currentAccountId=currentAccountId&&accountById(currentAccountId)?currentAccountId:null;
  selectedLabelIds.forEach(id=>{if(!assetById(id))selectedLabelIds.delete(id)});
  renderDashboard();
  renderAccounts();
  renderMaster();
  renderActivations();
  renderAuditResults();
  renderLabels();
  renderReports();
  renderRentalStock();
  renderRentalStock();
  if(currentAccountId)renderAccountDetail();
}

async function readCloudState({quiet=false}={}){
  const response=await fetch(CLOUD_STATE_API,{cache:"no-store"});
  if(response.status===401){showAuthGate(false,"Your session expired. Sign in again.");throw new Error("Sign in required.")}
  if(!response.ok)throw new Error("Cloud storage could not be reached.");
  const result=await response.json();
  if(result.state&&Number(result.revision)>cloudRevision){
    persistCloudState(result.state);
    cloudRevision=Number(result.revision)||0;
    renderCloudState();
    if(!quiet)toast("Shared cloud data loaded.");
  }else if(!result.state){
    cloudRevision=0;
  }
  return result;
}

function scheduleCloudSave(action="Data change"){
  currentCloudAction=action||currentCloudAction;
  cloudQueued=true;
  if(!cloudReady)return;
  clearTimeout(cloudSaveTimer);
  cloudSaveTimer=setTimeout(()=>flushCloudSave(),450);
}

// Debounce/coalesce local edits and send the last known server revision. Current
// conflict handling replaces unsaved edits with the server copy (DATA-01).
async function flushCloudSave(){
  if(!cloudReady||cloudSaving||!cloudQueued)return;
  cloudQueued=false;
  cloudSaving=true;
  setCloudStatus("saving");
  try{
    const response=await fetch(CLOUD_STATE_API,{
      method:"PUT",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({state:cloudState(),baseRevision:cloudRevision,action:currentCloudAction})
    });
    if(response.status===401){showAuthGate(false,"Your session expired. Sign in again.");throw new Error("Sign in required.")}
    if(response.status===409){
      await readCloudState({quiet:true});
      toast("Cloud had a newer change. The shared copy was loaded.");
      return;
    }
    if(!response.ok)throw new Error("Cloud save failed.");
    const result=await response.json();
    cloudRevision=Number(result.revision)||cloudRevision;
    setCloudStatus("synced",`Shared records saved ${new Date(result.updatedAt).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})}.`);
  }catch{
    cloudQueued=true;
    setCloudStatus("error","Cloud is unavailable. This browser is holding the latest changes and will retry.");
  }finally{
    cloudSaving=false;
    if(cloudQueued&&navigator.onLine)setTimeout(()=>flushCloudSave(),2500);
  }
}

async function initializeCloudSync(){
  setCloudStatus("connecting");
  try{
    const result=await readCloudState({quiet:true});
    cloudReady=true;
    if(result.state){
      setCloudStatus("synced","This browser is using the shared TanMar receiver records.");
    }else if(isUntouchedStarterData()){
      cloudReady=true;
      setCloudStatus("error","Cloud is empty. Open the app first on the browser that holds your real TanMar data.");
      return;
    }else{
      cloudQueued=true;
      await flushCloudSave();
      toast("Existing receiver data moved to TanMar Cloud Sync.");
    }
  }catch{
    cloudReady=true;
    setCloudStatus("error","Cloud is unavailable. Existing browser data is safe and sync will retry.");
  }
  clearInterval(cloudPollTimer);
  cloudPollTimer=setInterval(async()=>{
    if(cloudSaving||cloudQueued)return;
    try{
      await readCloudState({quiet:true});
      setCloudStatus("synced","Shared records are current across connected devices.");
    }catch{
      setCloudStatus("error","Cloud is unavailable. Existing browser data is safe and sync will retry.");
    }
  },CLOUD_POLL_MS);
}
const $=id=>document.getElementById(id);
const views={dashboard:$("dashboardView"),accounts:$("accountsView"),accountDetail:$("accountDetailView"),master:$("masterView"),activations:$("activationsView"),rentalStock:$("rentalStockView"),audit:$("auditView"),labels:$("labelsView"),reports:$("reportsView"),settings:$("settingsView"),placeholder:$("placeholderView")};
const titles={dashboard:"Dashboard",accounts:"Accounts",master:"Master Registry",activations:"Activations",rentalStock:"Rental Manager Stock",audit:"Audit Center",labels:"Labels",reports:"Reports",settings:"Settings"};

function showView(name){
Object.values(views).forEach(v=>v.classList.remove("active"));
if(name==="dashboard")views.dashboard.classList.add("active");
else if(name==="accounts")views.accounts.classList.add("active");
else if(name==="master")views.master.classList.add("active");
else if(name==="activations")views.activations.classList.add("active");
else if(name==="rentalStock")views.rentalStock.classList.add("active");
else if(name==="audit")views.audit.classList.add("active");
else if(name==="labels")views.labels.classList.add("active");
else if(name==="reports")views.reports.classList.add("active");
else if(name==="settings")views.settings.classList.add("active");
else views.placeholder.classList.add("active");
$("pageTitle").textContent=titles[name]||"Accounts";
$("placeholderTitle").textContent=titles[name]||"Coming Soon";
document.querySelectorAll(".nav-item").forEach(b=>b.classList.toggle("active",b.dataset.view===name));
closeSidebar();
if(name==="dashboard")renderDashboard();
if(name==="accounts")renderAccounts();
if(name==="master")renderMaster();
if(name==="activations"){renderActivations();loadRemoteActivations();}
if(name==="rentalStock")renderRentalStock();
if(name==="audit")renderAuditResults();
if(name==="labels")renderLabels();
if(name==="reports")renderReports();
if(name==="settings"&&currentUser?.role==="admin"){loadUsers();loadActivity();loadRecovery();}
}

function assignedFor(accountId){return assignments.filter(a=>a.accountId===accountId)}
function assignmentForAsset(assetId){return assignments.find(a=>a.assetId===assetId)}
function assetById(id){return master.find(a=>a.id===id)}
function accountById(id){return accounts.find(a=>a.id===id)}
function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]))}
function highlightMatch(value,query=""){
  const text=String(value??"");
  const needle=String(query||"").trim();
  if(!needle)return esc(text);
  const lowerText=text.toLowerCase();
  const lowerNeedle=needle.toLowerCase();
  let result="",start=0,index=lowerText.indexOf(lowerNeedle);
  while(index!==-1){
    result+=esc(text.slice(start,index));
    result+=`<mark class="search-highlight">${esc(text.slice(index,index+needle.length))}</mark>`;
    start=index+needle.length;
    index=lowerText.indexOf(lowerNeedle,start);
  }
  return result+esc(text.slice(start));
}
function receiverInfoButton(receiver,query=""){
  if(!receiver)return "<strong>Missing receiver</strong>";
  const condition=String(receiver.condition||"Good").toLowerCase();
  return `<button class="receiver-asset-link receiver-asset-with-condition" type="button" data-receiver-info="${esc(receiver.id)}"><i class="receiver-condition-light ${esc(condition)}" title="${esc(receiver.condition||"Good")}"></i>${highlightMatch(receiver.assetNumber,query)}</button>`;
}
function logReceiverEvent(receiverId,title,detail="",kind="assignment",date=new Date().toISOString()){
  if(!receiverId)return;
  receiverEvents.unshift({id:makeId(),receiverId,title,detail,kind,date,changedBy:currentUser?.name||"Unknown"});
  const counts=new Map();
  receiverEvents=receiverEvents.filter(entry=>{
    const count=counts.get(entry.receiverId)||0;
    counts.set(entry.receiverId,count+1);
    return count<20;
  }).slice(0,20000);
}
function archiveActivationEvent(request,receiver,account,reason="completed"){
  if(!receiver?.id||!request)return;
  const alreadyArchived=receiverEvents.some(entry=>entry.receiverId===receiver.id&&entry.activationId===request.id&&entry.status===request.status);
  if(alreadyArchived)return;
  const date=request.completedAt||new Date().toISOString();
  const title=`${request.action||"Service"} request ${reason}`;
  const snapshot={
    id:makeId(),receiverId:receiver.id,activationId:request.id,title,kind:"service",date,
    detail:[request.status,account?.number?`Account ${account.number}`:"",request.errorCode?`Error ${request.errorCode}`:"",request.notes||""].filter(Boolean).join(" · ")||"Receiver service activity",
    changedBy:currentUser?.name||"Unknown",status:request.status||"",action:request.action||"Service",
    requestedAt:request.requestedAt||"",completedAt:request.completedAt||"",accountNumber:account?.number||request.accountNumber||"",
    accountName:account?.name||request.accountName||"",notes:request.notes||"",errorCode:request.errorCode||"",
    operatorName:request.operatorName||"",requesterName:request.requesterName||"",requesterPhone:request.requesterPhone||"",rigFrac:request.rigFrac||"",lease:request.lease||"",
    mapUrl:request.mapUrl||"",gpsAccuracy:request.gpsAccuracy||"",source:request.source||"Manual"
  };
  receiverEvents.unshift(snapshot);
  const counts=new Map();
  receiverEvents=receiverEvents.filter(entry=>{const count=counts.get(entry.receiverId)||0;counts.set(entry.receiverId,count+1);return count<20}).slice(0,20000);
}
function toast(msg){$("toast").textContent=msg;$("toast").hidden=false;clearTimeout(toast.t);toast.t=setTimeout(()=>$("toast").hidden=true,2800)}
function openModal(id){$(id).hidden=false}
function closeModal(id){$(id).hidden=true}
function setReceiverRentState(receiver,nextState,changedAt=new Date().toISOString()){
  if(!receiver)return;
  const previous=receiver.rentState;
  receiver.rentState=nextState;
  if(nextState==="Off Rent"){
    if(previous!=="Off Rent"||!receiver.offRentSince)receiver.offRentSince=changedAt;
  }else{
    receiver.offRentSince="";
  }
}
function offRentDays(receiver,now=Date.now()){
  const started=new Date(receiver?.offRentSince||"").getTime();
  return Number.isFinite(started)?Math.max(0,Math.floor((now-started)/86400000)):0;
}
function overdueOffRentRows(){
  return assignments
    .map(assignment=>({receiver:assetById(assignment.assetId),account:accountById(assignment.accountId)}))
    .filter(item=>item.receiver&&item.account&&item.receiver.rentState==="Off Rent"&&offRentDays(item.receiver)>10)
    .map(item=>({...item,days:offRentDays(item.receiver)}))
    .sort((a,b)=>b.days-a.days||String(a.receiver.assetNumber).localeCompare(String(b.receiver.assetNumber)));
}

function formatUndoTime(value){
  const date=new Date(value);
  return Number.isNaN(date.getTime())?"":date.toLocaleString([],{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
}

function updateUndoControls(){
  if(!$("undoButton"))return;
  const available=undoHistory.length>0;
  $("undoButton").disabled=!available;
  $("undoHistoryButton").disabled=!available;
  $("undoButton").title=available?`Undo: ${undoHistory[0].label}`:"Nothing to undo";
  $("undoHistoryList").innerHTML=undoHistory.map((entry,index)=>`
    <button class="undo-history-entry" data-undo-index="${index}">
      <span class="undo-history-icon">↶</span>
      <span class="undo-history-copy"><strong>${esc(entry.label)}</strong><span>${esc(formatUndoTime(entry.createdAt))}</span></span>
      <span class="undo-history-step">${index===0?"Undo":"Undo to here"}</span>
    </button>`).join("");
  $("undoHistoryEmpty").hidden=available;
}

// Local Undo becomes another shared save; it is not a database point-in-time
// restore. Its incomplete audit/stock coverage is tracked in DATA-03.
function restoreUndoEntry(index=0){
  const entry=undoHistory[index];
  if(!entry)return;
  const steps=index+1;
  if(steps>1&&!confirm(`Undo ${steps} changes and return to “${entry.label}”?`))return;
  const state=entry.state||{};
  master=Array.isArray(state.master)?state.master:[];
  accounts=Array.isArray(state.accounts)?state.accounts:[];
  assignments=Array.isArray(state.assignments)?state.assignments:[];
  activations=Array.isArray(state.activations)?state.activations:[];
  receiverEvents=Array.isArray(state.receiverEvents)?state.receiverEvents:[];
  auditState=state.auditState&&typeof state.auditState==="object"?state.auditState:null;
  undoHistory=undoHistory.slice(index+1);
  persistUndoHistory();
  save("Undo",{skipUndo:true});
  persistAuditCache(auditState);
  currentAccountId=currentAccountId&&accountById(currentAccountId)?currentAccountId:null;
  selectedLabelIds.forEach(id=>{if(!assetById(id))selectedLabelIds.delete(id)});
  renderDashboard();
  renderAccounts();
  renderMaster();
  renderActivations();
  renderAuditResults();
  renderLabels();
  renderReports();
  if(currentAccountId)renderAccountDetail();
  $("undoHistoryPanel").hidden=true;
  toast(`${steps===1?"Last change":`${steps} changes`} undone.`);
}

function renderDashboard(){
$("accountStat").textContent=accounts.length;
$("assignedStat").textContent=assignments.length;
$("offRentStat").textContent=assignments.filter(a=>assetById(a.assetId)?.rentState==="Off Rent").length;
$("capacityStat").textContent=accounts.filter(a=>assignedFor(a.id).length>=20).length;
const dashboardAudit=load("atp.audit.v8",null);
$("auditResearchStat").textContent=(dashboardAudit?.results||[]).reduce((sum,result)=>sum+
  [...(result.missingFromAudit||[]),...(result.missingFromApp||[])].filter(issue=>!["corrected","ignored"].includes(issue.status||"needs-research")).length,0);
$("dashboardAccounts").innerHTML=accounts.slice(0,6).map(a=>{
const count=assignedFor(a.id).length;
return `<button class="dashboard-account-row" data-open-account="${a.id}">
<div><strong>${esc(a.number)}</strong><span>${esc(a.name)}</span></div>
<div><strong>${count}/20</strong><span>Receivers</span></div>
<div class="capacity-mini"><i style="width:${Math.min(count/20*100,100)}%"></i></div>
</button>`}).join("");
const overdue=overdueOffRentRows();
const availableIds=new Set(overdue.map(item=>item.receiver.id));
selectedOverdueIds.forEach(id=>{if(!availableIds.has(id))selectedOverdueIds.delete(id)});
$("overdueOffRentCount").textContent=`${overdue.length} receiver${overdue.length===1?"":"s"}`;
$("overdueOffRentRows").innerHTML=overdue.map(({receiver,account,days})=>`
<tr>
  <td class="select-column"><input type="checkbox" data-overdue-select="${esc(receiver.id)}" aria-label="Select ${esc(receiver.assetNumber)}" ${selectedOverdueIds.has(receiver.id)?"checked":""}></td>
  <td>${receiverInfoButton(receiver)}</td>
  <td>${esc(receiver.model||"—")}</td>
  <td><strong>${esc(account.number)}</strong><span>${esc(account.name)}</span></td>
  <td>${esc(account.office||account.location||"—")}</td>
  <td>${esc(new Date(receiver.offRentSince).toLocaleDateString())}</td>
  <td><span class="overdue-days">${days} days</span></td>
</tr>`).join("");
$("overdueOffRentEmpty").hidden=overdue.length!==0;
updateOverdueSelectionControls(overdue);
renderRentalStockAlert();
}

function activeRentalStockBatch(){return rentalStock.batches.find(batch=>batch.status==="Active")||null}
function rentalStockRemaining(batch=activeRentalStockBatch()){
  if(!batch)return [];
  return batch.receiverIds.map(assetById).filter(receiver=>receiver&&receiver.rentState!=="On Rent");
}
function reconcileRentalStock(){
  const batch=activeRentalStockBatch();
  if(!batch)return false;
  const now=new Date().toISOString();let changed=false;
  batch.items=batch.items||[];
  batch.receiverIds.forEach(receiverId=>{
    const receiver=assetById(receiverId);if(!receiver)return;
    let item=batch.items.find(entry=>entry.receiverId===receiverId);
    if(!item){item={receiverId,issuedAt:batch.issuedAt,releasedAt:""};batch.items.push(item);changed=true}
    if(receiver.rentState==="On Rent"&&!item.releasedAt){item.releasedAt=now;changed=true;logReceiverEvent(receiver.id,"Released from rental manager stock",`Batch ${batch.batchNumber} · Marked On Rent by TQ report`,"rent",now)}
  });
  if(rentalStockRemaining(batch).length===0&&batch.status==="Active"){
    batch.status="Completed";batch.completedAt=now;changed=true;
  }
  return changed;
}
function renderRentalStockAlert(){
  const batch=activeRentalStockBatch();const remaining=rentalStockRemaining(batch);const alert=$("rentalStockAlert");const badge=$("rentalStockNavBadge");
  const low=batch&&remaining.length<=Number(batch.lowThreshold||5);
  alert.hidden=!low;badge.hidden=!low;
  if(!low)return;
  badge.textContent=remaining.length;
  $("rentalStockAlertTitle").textContent=remaining.length===0?"Rental Manager Needs More Receivers":"Rental Manager Stock Running Low";
  $("rentalStockAlertDetail").textContent=remaining.length===0?`${batch.managerName}'s batch is exhausted. Issue a new receiver batch.`:`${batch.managerName} has reached the ${batch.lowThreshold}-receiver warning level.`;
  $("rentalStockAlertCount").textContent=`${remaining.length} remaining`;
}
function renderRentalStock(){
  reconcileRentalStock();
  const batch=activeRentalStockBatch();const remaining=rentalStockRemaining(batch);
  const issued=batch?(batch.originalCount||batch.receiverIds.length+(batch.removedItems?.length||0)):0;
  const removed=batch?.removedItems?.length||0;const released=Math.max(0,issued-remaining.length-removed);
  $("rentalStockAvailable").textContent=remaining.length;$("rentalStockIssued").textContent=issued;$("rentalStockReleased").textContent=released;
  $("rentalStockStatus").textContent=!batch?"No Batch":remaining.length<=Number(batch.lowThreshold||5)?remaining.length===0?"Restock Now":"Low Stock":"Stocked";
  $("rentalStockCurrentTitle").textContent=batch?`${batch.managerName} — Batch ${batch.batchNumber}`:"No Active Batch";
  $("rentalStockIssuedDate").textContent=batch?`Issued ${new Date(batch.issuedAt).toLocaleDateString()} · Warning at ${batch.lowThreshold}`:"";
  $("rentalStockRows").innerHTML=batch?batch.receiverIds.map(id=>{
    const receiver=assetById(id);if(!receiver)return "";const available=receiver.rentState!=="On Rent";
    return `<tr><td>${receiverInfoButton(receiver)}</td><td>${esc(receiver.model||"—")}</td><td>${esc(receiver.accessCard||"—")}</td><td>${esc(receiver.rid||"—")}</td><td><span class="rent-badge ${receiver.rentState==="On Rent"?"rent-on":"rent-off"}">${esc(receiver.rentState||"Off Rent")}</span></td><td><span class="rental-stock-state ${available?"available":"released"}">${available?"In Manager Stock":"Issued to Field"}</span></td><td data-admin-only>${available?`<button class="small-button danger" data-rental-stock-remove="${esc(receiver.id)}">Remove</button>`:"—"}</td></tr>`
  }).join(""):"";
  $("rentalStockEmpty").hidden=Boolean(batch);
  const history=rentalStock.batches.filter(item=>item.status==="Completed").sort((a,b)=>String(b.completedAt).localeCompare(String(a.completedAt)));
  $("rentalStockHistory").innerHTML=history.length?history.map(item=>`<article><div><strong>Batch ${esc(item.batchNumber)} — ${esc(item.managerName)}</strong><span>Issued ${new Date(item.issuedAt).toLocaleDateString()} · ${item.receiverIds.length} receivers</span></div><span>Completed ${new Date(item.completedAt).toLocaleDateString()}</span></article>`).join(""):`<div class="empty-state"><strong>No completed batches</strong><span>Finished receiver checkouts will remain here.</span></div>`;
  if(currentUser)document.querySelectorAll("[data-admin-only]").forEach(element=>element.hidden=currentUser.role!=="admin");
  renderRentalStockAlert();
}

function updateOverdueSelectionControls(overdue=overdueOffRentRows()){
  const ids=overdue.map(item=>item.receiver.id);
  const selectedCount=ids.filter(id=>selectedOverdueIds.has(id)).length;
  $("generateDeactivationList").disabled=selectedCount===0;
  $("generateDeactivationList").textContent=selectedCount?`Generate List (${selectedCount})`:"Generate List";
  $("selectAllOverdue").disabled=ids.length===0;
  $("selectAllOverdue").checked=ids.length>0&&selectedCount===ids.length;
  $("selectAllOverdue").indeterminate=selectedCount>0&&selectedCount<ids.length;
}

function deactivationEmailBody(rows){
  const receiverText=rows.map(({receiver,account})=>[
    "Asset#",
    receiver.assetNumber||"",
    "Card",
    receiver.accessCard||"",
    "SN",
    receiver.serial||"",
    "RID",
    receiver.rid||"",
    "Acct #",
    account.number||""
  ].join("\n")).join("\n\n");
  return `Good Morning,

I am writing to request the deactivation of the following receivers associated with my account. Kindly inform me once the deactivation process is complete so that I can update our records accordingly. If any of the receivers listed is a primary receiver, please replace it with a new primary and let me know the last 4 digits of the access card for the new primary for the account adjusted. Some may have already been deactivated, just want to double check.

Here is the account information for your reference:

Address:

Tanmar Rentals
4318 S Eunice Hwy
Hobbs, NM, 88240

Account Password: Compass

Thank you in advance for your prompt assistance in this matter.

${receiverText}`;
}

function renderDeactivationBatch(index=0){
  const batch=deactivationBatches[index]||[];
  $("deactivationBatchPicker").value=String(index);
  $("deactivationBatchTitle").textContent=`Batch ${index+1} of ${deactivationBatches.length}`;
  $("deactivationBatchSummary").textContent=`${batch.length} receiver${batch.length===1?"":"s"} · maximum 10 per DirecTV request`;
  $("deactivationEmailText").value=deactivationEmailBody(batch);
}

function openDeactivationList(){
  const selected=overdueOffRentRows().filter(item=>selectedOverdueIds.has(item.receiver.id));
  if(!selected.length){toast("Select at least one receiver.");return;}
  deactivationBatches=[];
  for(let index=0;index<selected.length;index+=DEACTIVATION_BATCH_SIZE){
    deactivationBatches.push(selected.slice(index,index+DEACTIVATION_BATCH_SIZE));
  }
  $("deactivationBatchPicker").innerHTML=deactivationBatches.map((batch,index)=>`<option value="${index}">Batch ${index+1} · ${batch.length} receiver${batch.length===1?"":"s"}</option>`).join("");
  $("deactivationBatchPickerWrap").hidden=deactivationBatches.length===1;
  $("directvRecipientEmail").value=localStorage.getItem(DIRECTV_RECIPIENT_KEY)||"";
  renderDeactivationBatch(0);
  openModal("deactivationListModal");
}

function accountCapacitySummary(accountList,receiverList,assignmentList){
  const receiverMap=new Map(receiverList.map(receiver=>[receiver.id,receiver]));
  const rows=new Map(accountList.map(account=>[account.id,{active:0,onRent:0,offRent:0,unknown:0,empty:20}]));
  const seen=new Set();
  let invalid=0;
  for(const assignment of assignmentList){
    const row=rows.get(assignment.accountId),receiver=receiverMap.get(assignment.assetId);
    if(!row||!receiver||seen.has(assignment.assetId)){invalid++;continue}
    seen.add(assignment.assetId);row.active++;
    if(receiver.rentState==="On Rent")row.onRent++;
    else if(receiver.rentState==="Off Rent")row.offRent++;
    else row.unknown++;
  }
  const total={accounts:rows.size,spaces:rows.size*20,active:0,onRent:0,offRent:0,empty:0,unknown:0,overCapacity:0,invalid,rows};
  for(const row of rows.values()){
    row.empty=Math.max(0,20-row.active);
    for(const key of ["active","onRent","offRent","empty","unknown"])total[key]+=row[key];
    if(row.active>20)total.overCapacity++;
  }
  total.canEstimate=!(total.invalid||total.unknown||total.overCapacity);
  total.accountsNeeded=total.canEstimate?Math.ceil(total.onRent/20):null;
  total.accountsToClose=total.canEstimate?Math.max(0,total.accounts-total.accountsNeeded):null;
  total.emptyAfterDeactivation=total.canEstimate?total.spaces-total.onRent:null;
  return total;
}

function renderAccountCapacity(){
  const totals=accountCapacitySummary(accounts,master,assignments);
  $("accountPaidSpaces").textContent=totals.spaces;
  $("accountPaidCount").textContent=`${totals.accounts} account${totals.accounts===1?"":"s"} × 20`;
  $("accountActiveReceivers").textContent=totals.active;
  $("accountOnRentReceivers").textContent=totals.onRent;
  $("accountOffRentReceivers").textContent=totals.offRent;
  $("accountEmptySpaces").textContent=totals.empty;
  const warnings=[];
  if(totals.invalid)warnings.push(`${totals.invalid} missing or duplicate assignment${totals.invalid===1?"":"s"}`);
  if(totals.unknown)warnings.push(`${totals.unknown} receiver${totals.unknown===1?"":"s"} with an unknown rent status`);
  if(totals.overCapacity)warnings.push(`${totals.overCapacity} account${totals.overCapacity===1?"":"s"} above 20 receivers`);
  $("accountCapacityWarning").hidden=!warnings.length;
  $("accountCapacityWarning").textContent=warnings.length?`Review ${warnings.join("; ")} before using the consolidation estimate.`:"";
  $("accountConsolidationTitle").textContent=!totals.canEstimate?"Review records to estimate account savings":!totals.accounts?"Add accounts to track available spaces":totals.accountsToClose?`${totals.accountsToClose} account${totals.accountsToClose===1?"":"s"} could be closed after consolidation`:"No whole account can be freed at current on-rent demand";
  $("accountConsolidationDetail").textContent=totals.canEstimate&&totals.accounts?`${totals.onRent} on-rent receiver${totals.onRent===1?"":"s"} need at least ${totals.accountsNeeded} account${totals.accountsNeeded===1?"":"s"} (${totals.accountsNeeded*20} spaces). Deactivating the ${totals.offRent} active Off Rent receiver${totals.offRent===1?"":"s"} would leave ${totals.emptyAfterDeactivation} empty spaces across your current accounts, before consolidation.`:"Active means assigned to an account. Unassigned receivers do not occupy account spaces.";
}

function renderAccounts(){
renderAccountCapacity();
const q=$("accountSearch").value.trim().toLowerCase();

const filtered=accounts.filter(a=>{
  const accountText=[a.number,a.name,a.location,a.office].join(" ").toLowerCase();
  const receiverText=assignedFor(a.id)
    .map(assignment=>assetById(assignment.assetId))
    .filter(Boolean)
    .map(asset=>[
      asset.assetNumber,
      asset.serial,
      asset.accessCard,
      asset.rid,
      asset.model
    ].join(" "))
    .join(" ")
    .toLowerCase();

  return `${accountText} ${receiverText}`.includes(q);
});

$("accountCardGrid").innerHTML=filtered.map(account=>{
  const assignmentList=assignedFor(account.id);
  const receivers=assignmentList.map(item=>assetById(item.assetId)).filter(Boolean);
  const onRent=receivers.filter(receiver=>receiver.rentState==="On Rent").length;
  const offRent=receivers.length-onRent;
  const isExpanded=q!=="" || expandedAccountIds.has(account.id);
  const accountMatch=Boolean(q)&&[account.number,account.name,account.location,account.office].join(" ").toLowerCase().includes(q);

  const receiverRows=receivers.map(receiver=>{
    const receiverMatch=Boolean(q)&&[receiver.assetNumber,receiver.model,receiver.accessCard,receiver.rid,receiver.serial].join(" ").toLowerCase().includes(q);
    return `
    <tr class="${receiverMatch?"search-return":""}">
      <td>${receiverInfoButton(receiver,q)}</td>
      <td>${highlightMatch(receiver.model||"—",q)}</td>
      <td>${highlightMatch(receiver.accessCard||"—",q)}</td>
      <td>${highlightMatch(receiver.rid||"—",q)}</td>
      <td>${highlightMatch(receiver.serial||"—",q)}</td>
      <td><span class="rent-badge ${receiver.rentState==="On Rent"?"rent-on":"rent-off"}">${esc(receiver.rentState)}</span></td>
      <td>
        <div class="row-actions">
          <button class="small-button" data-inline-move="${receiver.id}" data-account-id="${account.id}">Move</button>
          <button class="small-button danger" data-inline-remove="${receiver.id}" data-account-id="${account.id}">Remove</button>
        </div>
      </td>
    </tr>`}).join("");

  return `<section class="account-sheet-row ${isExpanded?"expanded":""} ${receivers.length>=20?"full":""} ${accountMatch?"search-return-card":""}" data-account-row="${account.id}">
    <button class="account-sheet-header" type="button" data-toggle-account="${account.id}">
      <span class="account-chevron">›</span>
      <span class="account-main">
        <strong>${highlightMatch(account.number,q)}</strong>
        <span>Account Number</span>
      </span>
      <span class="account-main">
        <strong>${highlightMatch(account.name,q)}</strong>
        <span>Account Name</span>
      </span>
      <span class="account-location-cell">
        <strong>${highlightMatch(account.office||account.location||"—",q)}</strong>
        <span>Office / Location</span>
      </span>
      <span class="account-sheet-metric">
        <strong>${receivers.length}/20</strong>
        <span>Assigned</span>
      </span>
      <span class="account-sheet-metric on-rent">
        <strong>${onRent}</strong>
        <span>On Rent</span>
      </span>
      <span class="account-sheet-metric off-rent">
        <strong>${offRent}</strong>
        <span>Off Rent</span>
      </span>
      <span class="account-sheet-metric empty-spaces">
        <strong>${Math.max(0,20-receivers.length)}</strong>
        <span>Empty Spaces</span>
      </span>
    </button>

    <div class="account-sheet-body">
      <div class="account-inline-tools">
        <div class="account-inline-summary">
          ${receivers.length>=20
            ? "Account is at the 20-receiver limit."
            : `${20-receivers.length} receiver slot${20-receivers.length===1?"":"s"} available.`}
        </div>
        <div class="account-inline-buttons">
          <button class="small-button" data-inline-edit-account="${account.id}">Edit Account</button>
          ${currentUser?.role==="admin"?`<button class="small-button" data-inline-import="${account.id}">Import Receivers</button>`:""}
          <button class="small-button" data-inline-add="${account.id}" ${receivers.length>=20?"disabled":""}>+ Add Receiver</button>
          <button class="small-button" data-open-account="${account.id}">Full Account View</button>
        </div>
      </div>

      ${receivers.length
        ? `<div class="table-wrap">
            <table class="account-inline-table">
              <thead>
                <tr><th>Asset</th><th>Model</th><th>Access Card</th><th>RID</th><th>Serial</th><th>Rent</th><th></th></tr>
              </thead>
              <tbody>${receiverRows}</tbody>
            </table>
          </div>`
        : `<div class="account-inline-empty">No receivers are currently assigned to this account.</div>`}
    </div>
  </section>`;
}).join("");

$("accountEmpty").hidden=filtered.length!==0;
}
function openAccount(id){
currentAccountId=id;
const a=accountById(id);if(!a)return;
Object.values(views).forEach(v=>v.classList.remove("active"));views.accountDetail.classList.add("active");
$("pageTitle").textContent="Account "+a.number;
$("detailAccountNumber").textContent="Account "+a.number;
$("detailAccountName").textContent=`${a.name} · ${a.location||"No location"} · ${a.office||"No office"}`;
$("receiverSearch").value="";
renderAccountDetail();
}

function renderAccountDetail(){
const a=accountById(currentAccountId);if(!a)return;
const list=assignedFor(a.id),assets=list.map(x=>assetById(x.assetId)).filter(Boolean);
const q=$("receiverSearch").value.trim().toLowerCase();
const filtered=assets.filter(x=>[x.assetNumber,x.model,x.accessCard,x.rid,x.serial].join(" ").toLowerCase().includes(q));
const on=assets.filter(x=>x.rentState==="On Rent").length,off=assets.length-on;
$("detailAssigned").textContent=assets.length;$("detailAvailable").textContent=Math.max(0,20-assets.length);$("detailOnRent").textContent=on;$("detailOffRent").textContent=off;
$("capacityCopy").textContent=`${assets.length} of 20`;
$("capacityFill").style.width=`${Math.min(assets.length/20*100,100)}%`;
$("capacityFill").classList.toggle("full",assets.length>=20);
$("capacityWarning").hidden=assets.length<20;
$("addReceiverButton").disabled=assets.length>=20;
$("receiverRows").innerHTML=filtered.map(x=>`<tr class="${q?"search-return":""}">
<td>${receiverInfoButton(x,q)}</td><td>${highlightMatch(x.model||"—",q)}</td><td>${highlightMatch(x.accessCard||"—",q)}</td><td>${highlightMatch(x.rid||"—",q)}</td><td>${highlightMatch(x.serial||"—",q)}</td>
<td><span class="rent-badge ${x.rentState==="On Rent"?"rent-on":"rent-off"}">${esc(x.rentState)}</span></td>
<td><div class="row-actions"><button class="small-button" data-move="${x.id}">Move</button><button class="small-button danger" data-remove="${x.id}">Remove</button></div></td>
</tr>`).join("");
$("receiverEmpty").hidden=filtered.length!==0;
}

function renderMaster(){
const q=$("masterSearch").value.trim().toLowerCase();
const filtered=master.filter(x=>[x.assetNumber,x.model,x.accessCard,x.rid,x.serial,x.type,x.condition,x.notes].join(" ").toLowerCase().includes(q));
$("masterRows").innerHTML=filtered.map(x=>{
const asn=assignmentForAsset(x.id),acct=asn?accountById(asn.accountId):null;
return `<tr class="${q?"search-return":""}"><td>${receiverInfoButton(x,q)}</td><td>${highlightMatch(x.model||"—",q)}</td><td>${highlightMatch(x.accessCard||"—",q)}</td><td>${highlightMatch(x.rid||"—",q)}</td><td>${highlightMatch(x.serial||"—",q)}</td><td>${acct?highlightMatch(acct.number,q):"Unassigned"}</td><td><button class="small-button" data-edit-master="${x.id}">Edit</button></td></tr>`}).join("");
}

function activationAccount(request,receiver){
  return accountById(request?.accountId)||accountById(assignmentForAsset(receiver?.id)?.accountId)||null;
}

function remoteReceiver(request){
  return master.find(receiver=>String(receiver.assetNumber).toUpperCase()===String(request.assetNumber||"").toUpperCase())||{
    assetNumber:request.assetNumber,
    model:request.model||request.receiverType,
    serial:request.serialNumber,
    rid:request.rid,
    accessCard:request.accessCard
  };
}

function allActivationRows(){
  const localRows=activations.map(request=>{
    const receiver=assetById(request.assetId);
    const account=activationAccount(request,receiver);
    return {request:{...request,source:"Manual",remote:false},receiver,account};
  });
  const remoteRows=remoteActivations.map(item=>({
    request:{...item,remote:true,source:item.source||"QR"},
    receiver:remoteReceiver(item),
    account:item.accountNumber||item.accountName?{number:item.accountNumber,name:item.accountName}:null
  }));
  return [...remoteRows,...localRows];
}

async function loadRemoteActivations(showSuccess=false){
  if(remoteActivationLoading)return;
  remoteActivationLoading=true;
  if($("refreshActivationsButton"))$("refreshActivationsButton").disabled=true;
  try{
    const response=await fetch(SERVICE_REQUEST_API,{cache:"no-store",headers:serviceRequestHeaders()});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.error||"Unable to load requests.");
    remoteActivations=Array.isArray(data.requests)?data.requests:[];
    renderActivations();
    if(showSuccess)toast("Service requests refreshed.");
  }catch(error){
    console.error(error);
    toast("Unable to sync QR service requests.");
  }finally{
    remoteActivationLoading=false;
    if($("refreshActivationsButton"))$("refreshActivationsButton").disabled=false;
  }
}

async function updateRemoteActivation(request,status){
  const response=await fetch(SERVICE_REQUEST_API,{
    method:"PATCH",
    headers:{...serviceRequestHeaders(),"content-type":"application/json"},
    body:JSON.stringify({id:request.id,status,notes:request.notes||""})
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error||"Unable to update request.");
  await loadRemoteActivations();
}

async function deleteRemoteActivation(request){
  const response=await fetch(`${SERVICE_REQUEST_API}?id=${encodeURIComponent(request.id)}`,{
    method:"DELETE",
    headers:serviceRequestHeaders()
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error||"Unable to delete request.");
  await loadRemoteActivations();
}

function renderActivations(){
  const q=$("activationSearch").value.trim().toLowerCase();
  const status=$("activationStatusFilter").value;
  const rows=allActivationRows();
  const pending=rows.map(row=>row.request).filter(item=>item.status==="Pending");
  $("activationPendingCount").textContent=pending.length;
  $("activationCompletedCount").textContent=rows.filter(row=>row.request.status==="Completed").length;
  $("activationOnCount").textContent=pending.filter(item=>item.action==="Activate"||item.action==="Reactivate / Refresh").length;
  $("activationOffCount").textContent=pending.filter(item=>item.action==="Deactivate").length;
  const filtered=rows.filter(({request,receiver,account})=>{
    if(status!=="all"&&request.status!==status)return false;
    return !q||[receiver?.assetNumber,receiver?.serial,receiver?.rid,account?.number,account?.name,request.action,request.status,request.errorCode,request.requesterName,request.requesterPhone,request.operatorName,request.rigFrac,request.lease,request.notes].join(" ").toLowerCase().includes(q);
  }).sort((a,b)=>String(b.request.requestedAt).localeCompare(String(a.request.requestedAt)));
  $("activationRows").innerHTML=filtered.map(({request,receiver,account})=>`
    <tr class="${q?"search-return":""}">
      <td><span class="activation-source ${request.remote?"":"manual"}">${request.remote?"QR Scan":"Manual"}</span></td>
      <td>${receiver?.id?receiverInfoButton(receiver,q):`<strong>${highlightMatch(receiver?.assetNumber||"Missing receiver",q)}</strong>`}<span>${highlightMatch(receiver?.model||"",q)}</span></td>
      <td><strong>${highlightMatch(account?.number||"Unassigned",q)}</strong><span>${highlightMatch(account?.name||"",q)}</span></td>
      <td><span class="activation-action ${request.action.toLowerCase().replace(/[^a-z]+/g,"-").replace(/^-|-$/g,"")}">${esc(request.action)}</span></td>
      <td>${esc(formatUndoTime(request.requestedAt)||request.requestedAt||"—")}</td>
      <td><span class="activation-status ${request.status.toLowerCase()}">${esc(request.status)}</span></td>
      <td><div class="activation-location"><strong>${esc(request.errorCode?`Error ${request.errorCode}`:"—")}</strong>${request.mapUrl?`<a href="${esc(request.mapUrl)}" target="_blank" rel="noopener">Open GPS map ↗</a><span>±${esc(Math.round(Number(request.gpsAccuracy)||0))} m</span>`:""}</div></td>
      <td>${esc(request.completedAt?new Date(request.completedAt).toLocaleDateString():"—")}</td>
      <td class="activation-notes"><div class="activation-notes-stack" title="${esc(request.notes||"")}">${request.requesterName?`<span><b>Requested by:</b> ${esc(request.requesterName)}</span>`:""}${request.requesterPhone?`<span><b>Callback:</b> ${esc(request.requesterPhone)}</span>`:""}${request.operatorName?`<span><b>Operator:</b> ${esc(request.operatorName)}</span>`:""}${request.rigFrac?`<span><b>Rig/Frac:</b> ${esc(request.rigFrac)}</span>`:""}${request.lease?`<span><b>Lease:</b> ${esc(request.lease)}</span>`:""}${request.notes?`<span class="activation-request-note">${esc(request.notes)}</span>`:""}${!request.requesterName&&!request.requesterPhone&&!request.operatorName&&!request.rigFrac&&!request.lease&&!request.notes?"—":""}</div></td>
      <td><div class="row-actions">
        ${request.status==="Pending"?`<button class="small-button" data-activation-complete="${request.id}">Complete</button>${request.remote?"":`<button class="small-button" data-activation-edit="${request.id}">Edit</button>`}<button class="small-button" data-activation-cancel="${request.id}">Cancel</button>`:`<button class="small-button" data-activation-reopen="${request.id}">Reopen</button>`}
        <button class="small-button danger" data-activation-delete="${request.id}">Delete</button>
      </div></td>
    </tr>`).join("");
  $("activationEmpty").hidden=filtered.length!==0;
}

function updateActivationAccountDisplay(){
  const asset=master.find(item=>item.assetNumber.toUpperCase()===$("activationAssetInput").value.trim().toUpperCase());
  const account=asset?accountById(assignmentForAsset(asset.id)?.accountId):null;
  $("activationAccountDisplay").value=account?`${account.number} — ${account.name}`:asset?"Unassigned":"";
}

function receiverHistory(receiver){
  if(!receiver)return [];
  const assignment=assignmentForAsset(receiver.id);
  const currentAccount=accountById(assignment?.accountId);
  const entries=[];

  receiverEvents
    .filter(entry=>entry.receiverId===receiver.id)
    .forEach(entry=>entries.push({...entry,kind:entry.kind||"assignment"}));

  const hasCurrentAssignmentEvent=receiverEvents.some(entry=>entry.receiverId===receiver.id&&entry.date===assignment?.assignedAt);
  if(assignment&&!hasCurrentAssignmentEvent){
    entries.push({
      date:assignment.assignedAt||"",
      title:`Assigned to Account ${currentAccount?.number||"Unknown"}`,
      detail:currentAccount?.name||"Current account assignment",
      kind:"assignment"
    });
  }

  const hasCurrentRentEvent=receiverEvents.some(entry=>entry.receiverId===receiver.id&&entry.date===receiver.offRentSince);
  if(receiver.offRentSince&&!hasCurrentRentEvent){
    entries.push({
      date:receiver.offRentSince,
      title:"Marked Off Rent",
      detail:"Rent status updated from the TQ report.",
      kind:"rent"
    });
  }

  allActivationRows().forEach(({request,receiver:requestReceiver,account})=>{
    const sameId=request.assetId&&request.assetId===receiver.id;
    const sameAsset=String(requestReceiver?.assetNumber||request.assetNumber||"").toUpperCase()===String(receiver.assetNumber||"").toUpperCase();
    if(!sameId&&!sameAsset)return;
    if(receiverEvents.some(entry=>entry.receiverId===receiver.id&&entry.activationId===request.id))return;
    const details=[
      request.status,
      account?.number?`Account ${account.number}`:"",
      request.errorCode?`Error ${request.errorCode}`:"",
      request.notes||""
    ].filter(Boolean).join(" · ");
    entries.push({
      date:request.completedAt||request.requestedAt||"",
      title:`${request.action||"Service"} request`,
      detail:details||"Receiver service activity",
      kind:"service"
    });
  });

  return entries.sort((a,b)=>{
    const aTime=new Date(a.date||0).getTime()||0;
    const bTime=new Date(b.date||0).getTime()||0;
    return bTime-aTime;
  });
}

function renderReceiverInfo(){
  const receiver=assetById(currentReceiverInfoId);
  if(!receiver)return;
  const assignment=assignmentForAsset(receiver.id);
  const account=accountById(assignment?.accountId);
  const status=!assignment
    ?{key:"inactive",label:"Not Active"}
    :receiver.rentState==="On Rent"
      ?{key:"on",label:"On Rent"}
      :{key:"off",label:"Off Rent"};

  $("receiverInfoAsset").textContent=receiver.assetNumber;
  $("receiverInfoStatus").className=`receiver-status-indicator ${status.key}`;
  $("receiverInfoStatus").querySelector("span").textContent=status.label;
  $("receiverInfoGrid").innerHTML=`
    <div><span>Model</span><strong>${esc(receiver.model||receiver.type||"—")}</strong></div>
    <div><span>Current Account</span><strong>${account?`${esc(account.number)} — ${esc(account.name)}`:"Not assigned"}</strong></div>
    <div><span>Access Card</span><strong>${esc(receiver.accessCard||"—")}</strong></div>
    <div><span>RID</span><strong>${esc(receiver.rid||"—")}</strong></div>
    <div><span>Serial Number</span><strong>${esc(receiver.serial||"—")}</strong></div>
    <div><span>Receiver Type</span><strong>${esc(receiver.type||"—")}</strong></div>
    <div><span>Condition</span><strong class="receiver-asset-with-condition"><i class="receiver-condition-light ${esc(String(receiver.condition||"Good").toLowerCase())}"></i>${esc(receiver.condition||"Good")}</strong></div>
    <div class="receiver-note-detail"><span>Receiver Notes</span><strong>${esc(receiver.notes||"No receiver notes")}</strong></div>`;

  const history=receiverHistory(receiver);
  const visible=receiverHistoryExpanded?history:history.slice(0,3);
  $("receiverHistoryList").innerHTML=visible.map(entry=>`
    <button type="button" class="receiver-history-entry ${entry.kind}" data-receiver-event="${esc(entry.id||"")}">
      <i></i>
      <div><strong>${esc(entry.title)}</strong><span>${esc(entry.detail)}</span>${entry.changedBy?`<span class="changed-by">Changed by ${esc(entry.changedBy)}</span>`:""}</div>
      <time>${esc(formatUndoTime(entry.date)||"Current")}</time>
    </button>`).join("");
  $("receiverHistoryEmpty").hidden=history.length!==0;
  $("receiverHistoryToggle").hidden=history.length<=3;
  $("receiverHistoryToggle").textContent=receiverHistoryExpanded?"Show Recent":"Full History";
}

function openReceiverInfo(receiverId){
  const receiver=assetById(receiverId);
  if(!receiver)return;
  currentReceiverInfoId=receiver.id;
  receiverHistoryExpanded=false;
  renderReceiverInfo();
  openModal("receiverInfoModal");
}

$("receiverHistoryToggle").addEventListener("click",()=>{
  receiverHistoryExpanded=!receiverHistoryExpanded;
  renderReceiverInfo();
});

function openReceiverEvent(eventId){
  const entry=receiverEvents.find(item=>item.id===eventId);
  if(!entry)return;
  $("receiverEventTitle").textContent=entry.title||"Event Details";
  const rows=[
    ["Event Date",formatUndoTime(entry.date)||entry.date],["Action",entry.action],["Status",entry.status],["Requested By",entry.requesterName],["Callback Phone",entry.requesterPhone],
    ["Requested",entry.requestedAt?formatUndoTime(entry.requestedAt):""],["Completed",entry.completedAt?formatUndoTime(entry.completedAt):""],
    ["Account",[entry.accountNumber,entry.accountName].filter(Boolean).join(" — ")],["Source",entry.source],
    ["Error Code",entry.errorCode],["Operator",entry.operatorName],["Rig / Frac",entry.rigFrac],["Lease",entry.lease],
    ["GPS Accuracy",entry.gpsAccuracy?`±${Math.round(Number(entry.gpsAccuracy)||0)} m`:""],["Notes",entry.notes],
    ["Recorded By",entry.changedBy]
  ].filter(([,value])=>value);
  $("receiverEventBody").innerHTML=`<div class="receiver-event-grid">${rows.map(([label,value])=>`<div><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join("")}</div>${entry.mapUrl?`<a class="primary-button receiver-event-map" href="${esc(entry.mapUrl)}" target="_blank" rel="noopener">Open GPS Map ↗</a>`:""}`;
  openModal("receiverEventModal");
}

$("receiverHistoryList").addEventListener("click",event=>{
  const row=event.target.closest("[data-receiver-event]");
  if(row?.dataset.receiverEvent)openReceiverEvent(row.dataset.receiverEvent);
});

document.addEventListener("click",event=>{
  const assetButton=event.target.closest("[data-receiver-info]");
  if(assetButton)openReceiverInfo(assetButton.dataset.receiverInfo);
});

function openActivationForm(request=null){
  const receiver=request?assetById(request.assetId):null;
  $("activationForm").reset();
  $("activationEditId").value=request?.id||"";
  $("activationModalTitle").textContent=request?"Edit Activation Request":"New Activation Request";
  $("activationAssetInput").value=receiver?.assetNumber||"";
  $("activationAssetInput").readOnly=Boolean(request);
  $("activationActionInput").value=request?.action||"Activate";
  $("activationRequesterInput").value=request?.requesterName||currentUser?.name||"";
  $("activationDateInput").value=request?.requestedAt||new Date().toISOString().slice(0,10);
  $("activationNotesInput").value=request?.notes||"";
  $("activationAssetOptions").innerHTML=master.map(item=>`<option value="${esc(item.assetNumber)}">${esc(item.model||item.type||"Receiver")}</option>`).join("");
  updateActivationAccountDisplay();
  openModal("activationModal");
}

function labelReceiverContext(receiver){
  const assignment=assignmentForAsset(receiver.id);
  return {receiver,account:accountById(assignment?.accountId)};
}

function serviceQrMarkup(value,assetNumber){
  try{
    const qr=qrcode(0,"H");
    qr.addData(value);
    qr.make();
    const count=qr.getModuleCount(),quiet=4,size=count+quiet*2;
    let path="";
    for(let row=0;row<count;row++)for(let col=0;col<count;col++){
      if(qr.isDark(row,col))path+=`M${col+quiet},${row+quiet}h1v1h-1z`;
    }
    // A four-module quiet zone and high error correction protect the small TM inset.
    const logoSize=Math.floor(count*.14),logoStart=(size-logoSize)/2;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="Service QR code for ${esc(assetNumber)}">
      <rect width="${size}" height="${size}" fill="#fff"/>
      <path d="${path}" fill="#000" shape-rendering="crispEdges"/>
      <rect x="${logoStart-1}" y="${logoStart-1}" width="${logoSize+2}" height="${logoSize+2}" fill="#fff"/>
      <svg x="${logoStart}" y="${logoStart}" width="${logoSize}" height="${logoSize}" viewBox="303 895 51 48"><image href="label-brand-reference.png" width="1500" height="1500"/></svg>
    </svg>`;
  }catch{return ""}
}

// Printed links freeze private receiver/account metadata in a public URL. QR-01
// replaces this with a stable identifier and server lookup of current details.
function serviceRequestLink(receiver,account=null){
  const requestUrl=new URL(PUBLIC_SERVICE_REQUEST_URL);
  const requestData={
    a:receiver.assetNumber,
    m:receiver.model,
    t:receiver.type,
    s:receiver.serial,
    r:receiver.rid,
    c:receiver.accessCard,
    rs:receiver.rentState,
    an:account?.number||"",
    ac:account?.name||"",
    al:account?.location||"",
    ao:account?.office||""
  };
  Object.entries(requestData).forEach(([key,value])=>{
    if(value)requestUrl.searchParams.set(key,value);
  });
  return requestUrl.href;
}

function receiverLabelMarkup(receiver){
  return `<article class="dk-label receiver-id-label">
    <svg class="dk-barcode" data-barcode="${esc(receiver.assetNumber)}" aria-label="Barcode for ${esc(receiver.assetNumber)}"></svg>
    <strong class="dk-barcode-asset">${esc(receiver.assetNumber)}</strong>
  </article>`;
}

function serviceLabelMarkup(receiver,account=null){
  const link=String(receiver.assetNumber||"").trim()?serviceRequestLink(receiver,account):"";
  const qr=link?serviceQrMarkup(link,receiver.assetNumber):"";
  return `<article class="dk-label service-qr-label" ${qr?'':'data-code-error="true"'}>
    <div class="dk-service-brand">
      <svg class="dk-company-logo" xmlns="http://www.w3.org/2000/svg" viewBox="222 713 207 70" role="img" aria-label="TanMar Companies"><image href="label-brand-reference.png" width="1500" height="1500"/></svg>
      <div class="dk-service-qr">${qr||'<span class="dk-label-error">QR could not be generated. Check this receiver’s details.</span>'}</div>
    </div>
    <div class="dk-service-copy">
      <div class="dk-field" data-fit-label>Asset # ${esc(receiver.assetNumber||"—")}</div>
      <div class="dk-field" data-fit-label>Card # ${esc(receiver.accessCard||"—")}</div>
      <div class="dk-field" data-fit-label>RID # ${esc(receiver.rid||"—")}</div>
      <div class="dk-field" data-fit-label>Serial # ${esc(receiver.serial||"—")}</div>
      <div class="dk-scan-instruction" data-fit-label>Scan QR Code for activation / service</div>
    </div>
  </article>`;
}

function renderBarcodes(){
  document.querySelectorAll(".dk-barcode").forEach(svg=>{
    try{
      JsBarcode(svg,svg.dataset.barcode,{format:"CODE128",displayValue:false,height:64,width:2,margin:0,marginLeft:20,marginRight:20});
      svg.setAttribute("preserveAspectRatio","none");
    }catch{
      svg.closest(".dk-label").dataset.codeError="true";
      svg.outerHTML='<span class="dk-label-error">Barcode could not be generated. Check the asset number.</span>';
    }
  });
}

function fitLabelText(root=document){
  root.querySelectorAll("[data-fit-label]").forEach(line=>{
    line.style.fontSize="";
    if(!line.clientWidth)return;
    let size=parseFloat(getComputedStyle(line).fontSize);
    while(line.scrollWidth>line.clientWidth&&size>7){size-=.25;line.style.fontSize=`${size}px`;}
  });
}

function sizeLabelPreviews(){
  document.querySelectorAll(".label-preview-viewport").forEach(viewport=>{
    const label=viewport.querySelector(".dk-label");
    if(!label||!viewport.clientWidth)return;
    viewport.style.width=`${label.offsetWidth}px`;
    const scale=Math.min(1,viewport.clientWidth/label.offsetWidth);
    viewport.style.setProperty("--label-scale",scale);
    viewport.style.height=`${label.offsetHeight*scale}px`;
  });
  fitLabelText();
}
const labelPreviewObserver=new ResizeObserver(sizeLabelPreviews);
labelPreviewObserver.observe($("labelPreviewGrid"));

function visibleLabelReceivers(){
  const q=$("labelSearch").value.trim().toLowerCase();
  const accountFilter=$("labelAccountFilter").value;
  return master.map(labelReceiverContext).filter(({receiver,account})=>{
    if(accountFilter!=="all"&&(account?.id||"unassigned")!==accountFilter)return false;
    return !q||[receiver.assetNumber,receiver.serial,receiver.rid,receiver.accessCard,receiver.model,account?.number,account?.name].join(" ").toLowerCase().includes(q);
  }).sort((a,b)=>a.receiver.assetNumber.localeCompare(b.receiver.assetNumber,undefined,{numeric:true}));
}

function renderLabels(){
  const currentFilter=$("labelAccountFilter").value||"all";
  $("labelAccountFilter").innerHTML=`<option value="all">All Accounts</option><option value="unassigned">Unassigned</option>${accounts.map(account=>`<option value="${account.id}">${esc(account.number)} — ${esc(account.name)}</option>`).join("")}`;
  $("labelAccountFilter").value=[...$("labelAccountFilter").options].some(option=>option.value===currentFilter)?currentFilter:"all";
  const visible=visibleLabelReceivers();
  const visibleSelected=visible.filter(({receiver})=>selectedLabelIds.has(receiver.id)).length;
  $("selectVisibleLabels").checked=visible.length>0&&visibleSelected===visible.length;
  $("selectVisibleLabels").indeterminate=visibleSelected>0&&visibleSelected<visible.length;
  $("selectVisibleLabels").disabled=visible.length===0;
  $("labelReceiverList").innerHTML=visible.map(({receiver,account})=>`
    <label class="label-receiver-row ${selectedLabelIds.has(receiver.id)?"selected":""}">
      <input type="checkbox" data-label-id="${receiver.id}" ${selectedLabelIds.has(receiver.id)?"checked":""}>
      <span><strong>${esc(receiver.assetNumber)}</strong><span>${esc(receiver.model||receiver.type||"Receiver")}</span></span>
      <span><strong>${esc(account?.number||"Unassigned")}</strong><span>${esc(account?.name||"No current account")}</span></span>
      <span><strong>${esc(receiver.serial||"No serial")}</strong><span>RID ${esc(receiver.rid||"—")}</span></span>
    </label>`).join("");
  $("labelReceiverEmpty").hidden=visible.length!==0;
  $("labelVisibleCount").textContent=`${visible.length} receiver${visible.length===1?"":"s"} shown`;
  const selected=master.filter(receiver=>selectedLabelIds.has(receiver.id)).map(labelReceiverContext);
  $("labelSelectedCount").textContent=`${selected.length} selected`;
  $("printLabelsButton").disabled=selected.length===0;
  $("printServiceLabelsButton").disabled=selected.length===0;
  $("clearLabelSelection").disabled=selected.length===0;
  $("labelPreviewGrid").innerHTML=selected.map(({receiver,account})=>`
    <section class="label-preview-item"><p class="label-preview-caption">${esc(receiver.assetNumber)} · Receiver / service · DK-2212 · 150 × 62 mm</p><div class="label-preview-viewport">${serviceLabelMarkup(receiver,account)}</div></section>
    <section class="label-preview-item"><p class="label-preview-caption">${esc(receiver.assetNumber)} · Barcode · DK-2211 · 90 × 29 mm</p><div class="label-preview-viewport">${receiverLabelMarkup(receiver)}</div></section>`).join("");
  $("labelPreviewEmpty").hidden=selected.length!==0;
  renderBarcodes();
  sizeLabelPreviews();
}

function openAccountForm(account=null){
$("accountForm").reset();$("accountEditId").value=account?.id||"";$("accountModalTitle").textContent=account?"Edit Account":"Add Account";
$("accountNumberInput").value=account?.number||"";$("accountNameInput").value=account?.name||"";$("accountLocationInput").value=account?.location||"";$("accountOfficeInput").value=account?.office||"";
openModal("accountModal");
}

$("accountForm").addEventListener("submit",e=>{
e.preventDefault();const id=$("accountEditId").value,number=$("accountNumberInput").value.trim(),name=$("accountNameInput").value.trim();
if(accounts.some(a=>a.number===number&&a.id!==id)){toast("That Account Number already exists.");return}
const rec={id:id||makeId(),number,name,location:$("accountLocationInput").value.trim(),office:$("accountOfficeInput").value.trim()};
accounts=id?accounts.map(a=>a.id===id?rec:a):[...accounts,rec];save(id?"Edit account":"Add account");closeModal("accountModal");renderAccounts();renderDashboard();if(id)openAccount(id);else openAccount(rec.id);
});

function openAssign(){
if(assignedFor(currentAccountId).length>=20){toast("This account already has 20 receivers.");return}
$("assignForm").reset();$("lookupResult").hidden=true;openModal("assignModal");setTimeout(()=>$("assignAssetInput").focus(),0);
}
$("assignAssetInput").addEventListener("input",()=>{
const value=$("assignAssetInput").value.trim().toUpperCase(),asset=master.find(x=>x.assetNumber.toUpperCase()===value);
if(!value){$("lookupResult").hidden=true;return}
$("lookupResult").hidden=false;
if(asset){const existing=assignmentForAsset(asset.id);$("lookupResult").className="lookup-result";$("lookupResult").innerHTML=`<strong>${esc(asset.assetNumber)} · ${esc(asset.model||"No model")}</strong><span>Card: ${esc(asset.accessCard||"—")} · RID: ${esc(asset.rid||"—")}${existing?` · Currently in Account ${esc(accountById(existing.accountId)?.number||"")}`:""}</span>`}
else{$("lookupResult").className="lookup-result lookup-missing";$("lookupResult").innerHTML="<strong>Receiver not found in Master Registry</strong><span>Submitting will open a new Master Receiver form and then assign it to this account.</span>"}
});

$("assignForm").addEventListener("submit",e=>{
e.preventDefault();const value=$("assignAssetInput").value.trim().toUpperCase();let asset=master.find(x=>x.assetNumber.toUpperCase()===value);
if(!asset){closeModal("assignModal");openMasterForm(null,value,true);return}
const existing=assignmentForAsset(asset.id);
if(existing){const acct=accountById(existing.accountId);toast(`Receiver is already assigned to Account ${acct?.number||""}. Use Move instead.`);return}
const assignedAt=new Date().toISOString();
assignments.push({id:makeId(),assetId:asset.id,accountId:currentAccountId,assignedAt});
const account=accountById(currentAccountId);
logReceiverEvent(asset.id,`Assigned to Account ${account?.number||"Unknown"}`,account?.name||"Account assignment","assignment",assignedAt);
save("Assign receiver to account");closeModal("assignModal");renderAccountDetail();renderDashboard();toast("Receiver added to account.");
});

function openMasterForm(asset=null,prefill="",assignAfter=false){
$("masterForm").reset();$("masterEditId").value=asset?.id||"";$("assignAfterMaster").value=assignAfter?"yes":"no";$("masterModalTitle").textContent=asset?"Edit Master Receiver":"Add Receiver to Master";
$("masterAssetInput").value=asset?.assetNumber||prefill;$("masterModelInput").value=asset?.model||"";$("masterCardInput").value=asset?.accessCard||"";$("masterRidInput").value=asset?.rid||"";$("masterSerialInput").value=asset?.serial||"";$("masterTypeInput").value=asset?.type||"";openModal("masterModal");
$("masterConditionInput").value=asset?.condition||"Good";$("masterNotesInput").value=asset?.notes||"";
setTimeout(()=>$(asset?"masterModelInput":"masterAssetInput").focus(),0);
}

const masterScanFields=["masterAssetInput","masterModelInput","masterCardInput","masterRidInput","masterSerialInput","masterTypeInput"];
$("masterForm").addEventListener("keydown",event=>{
  if(event.key!=="Enter"||event.ctrlKey||event.metaKey)return;
  const index=masterScanFields.indexOf(event.target.id);
  if(index===-1)return;
  event.preventDefault();
  event.stopPropagation();
  const nextId=masterScanFields[index+1];
  if(nextId){$(nextId).focus();$(nextId).select()}
  else $("masterSaveButton").focus();
});

function saveMasterReceiver(){
const form=$("masterForm");
if(!form.reportValidity())return false;
const id=$("masterEditId").value,assetNumber=$("masterAssetInput").value.trim().toUpperCase();
if(master.some(x=>x.assetNumber.toUpperCase()===assetNumber&&x.id!==id)){toast("That Asset Number already exists in the Master Registry.");return false}
const existing=master.find(x=>x.id===id);
const rec={id:id||makeId(),assetNumber,model:$("masterModelInput").value.trim(),accessCard:$("masterCardInput").value.trim(),rid:$("masterRidInput").value.trim(),serial:$("masterSerialInput").value.trim(),type:$("masterTypeInput").value.trim(),condition:$("masterConditionInput").value||"Good",notes:$("masterNotesInput").value.trim(),rentState:existing?.rentState||"Off Rent",offRentSince:existing?.offRentSince||(existing?"":new Date().toISOString())};
master=id?master.map(x=>x.id===id?rec:x):[...master,rec];
if(existing&&(existing.condition||"Good")!==rec.condition)logReceiverEvent(rec.id,`Condition changed to ${rec.condition}`,rec.notes||`Previously ${existing.condition||"Good"}`,"condition");
if(existing&&(existing.notes||"")!==rec.notes)logReceiverEvent(rec.id,"Receiver notes updated",rec.notes||"Notes cleared","condition");
if($("assignAfterMaster").value==="yes"&&!assignmentForAsset(rec.id)){
  const assignedAt=new Date().toISOString();
  assignments.push({id:makeId(),assetId:rec.id,accountId:currentAccountId,assignedAt});
  const account=accountById(currentAccountId);
  logReceiverEvent(rec.id,`Assigned to Account ${account?.number||"Unknown"}`,account?.name||"Account assignment","assignment",assignedAt);
}
save(id?"Edit Master receiver":"Add Master receiver");closeModal("masterModal");renderMaster();renderDashboard();if(currentAccountId)renderAccountDetail();
if(pendingAuditIssueId)completePendingAuditAction(rec.id,id?"Receiver record corrected from Audit Center":"Receiver added from Audit Center");
toast(id?"Master receiver updated.":"Receiver added to Master Registry.");
return true;
}

$("masterForm").addEventListener("submit",e=>{
e.preventDefault();e.stopPropagation();saveMasterReceiver();
});

function openMove(assetId){
$("moveAssetId").value=assetId;
const current=assignmentForAsset(assetId);
$("moveAccountSelect").innerHTML=accounts.filter(a=>a.id!==current?.accountId).map(a=>`<option value="${a.id}" ${assignedFor(a.id).length>=20?"disabled":""}>${esc(a.number)} — ${esc(a.name)} (${assignedFor(a.id).length}/20)</option>`).join("");
if(!$("moveAccountSelect").options.length){toast("No other account is available.");return}
openModal("moveModal");
}
$("moveForm").addEventListener("submit",e=>{
e.preventDefault();const assetId=$("moveAssetId").value,target=$("moveAccountSelect").value;
if(assignedFor(target).length>=20){toast("The destination account already has 20 receivers.");return}
const asn=assignmentForAsset(assetId);
if(asn){
  const from=accountById(asn.accountId),to=accountById(target);
  asn.accountId=target;
  asn.assignedAt=new Date().toISOString();
  logReceiverEvent(assetId,`Moved to Account ${to?.number||"Unknown"}`,`From Account ${from?.number||"Unknown"}${to?.name?` · ${to.name}`:""}`,"assignment",asn.assignedAt);
}
save("Move receiver between accounts");closeModal("moveModal");renderAccountDetail();renderDashboard();
if(pendingAuditIssueId)completePendingAuditAction(assetId,"Receiver moved from Audit Center");
toast("Receiver moved to the selected account.");
});

document.querySelectorAll(".nav-item").forEach(b=>b.addEventListener("click",()=>showView(b.dataset.view)));
document.querySelectorAll("[data-open-view]").forEach(b=>b.addEventListener("click",()=>showView(b.dataset.openView)));
document.querySelectorAll("[data-close]").forEach(b=>b.addEventListener("click",()=>{
  if(["masterModal","moveModal"].includes(b.dataset.close))pendingAuditIssueId=null;
  closeModal(b.dataset.close);
}));
document.querySelectorAll(".modal-backdrop").forEach(m=>m.addEventListener("click",e=>{
  if(e.target===m){
    if(["masterModal","moveModal"].includes(m.id))pendingAuditIssueId=null;
    m.hidden=true;
  }
}));
$("globalNewAccount").onclick=$("accountsNewButton").onclick=$("quickNewAccount").onclick=()=>openAccountForm();
$("backToAccounts").onclick=()=>showView("accounts");
$("editAccountButton").onclick=()=>openAccountForm(accountById(currentAccountId));
$("addReceiverButton").onclick=openAssign;
$("masterAddButton").onclick=()=>openMasterForm();

$("undoButton").onclick=()=>restoreUndoEntry(0);
$("undoHistoryButton").onclick=()=>{
  updateUndoControls();
  $("undoHistoryPanel").hidden=!$("undoHistoryPanel").hidden;
};
$("closeUndoHistory").onclick=()=>{$("undoHistoryPanel").hidden=true};
$("undoHistoryList").addEventListener("click",event=>{
  const entry=event.target.closest("[data-undo-index]");
  if(entry)restoreUndoEntry(Number(entry.dataset.undoIndex));
});

$("newActivationButton").onclick=()=>openActivationForm();
$("newRentalStockBatch").onclick=()=>{
  if(activeRentalStockBatch()){toast("Complete the current batch before issuing another.");return}
  $("rentalStockForm").reset();$("rentalStockThreshold").value="5";$("rentalStockFormNote").textContent="0 valid receivers entered";openModal("rentalStockModal");
};
$("rentalStockAssets").addEventListener("input",()=>{
  const assets=[...new Set($("rentalStockAssets").value.split(/[\s,;]+/).map(value=>value.trim().toUpperCase()).filter(Boolean))];
  const valid=assets.filter(value=>master.some(receiver=>receiver.assetNumber.toUpperCase()===value));
  $("rentalStockFormNote").textContent=`${valid.length} valid receiver${valid.length===1?"":"s"} entered${assets.length!==valid.length?` · ${assets.length-valid.length} not found in Master Registry`:""}`;
});
$("rentalStockForm").addEventListener("submit",event=>{
  event.preventDefault();if(activeRentalStockBatch()){toast("Complete the current batch before issuing another.");return}
  const values=[...new Set($("rentalStockAssets").value.split(/[\s,;]+/).map(value=>value.trim().toUpperCase()).filter(Boolean))];
  const receivers=values.map(value=>master.find(receiver=>receiver.assetNumber.toUpperCase()===value)).filter(Boolean);
  if(receivers.length!==values.length){toast("Every asset must exist in the Master Registry.");return}
  if(!receivers.length){toast("Enter at least one receiver.");return}
  const now=new Date().toISOString();const batchNumber=(Math.max(0,...rentalStock.batches.map(batch=>Number(batch.batchNumber)||0))+1);
  const batch={id:makeId(),batchNumber,managerName:$("rentalManagerName").value.trim(),lowThreshold:Number($("rentalStockThreshold").value)||5,issuedAt:now,completedAt:"",status:"Active",originalCount:receivers.length,receiverIds:receivers.map(receiver=>receiver.id),items:receivers.map(receiver=>({receiverId:receiver.id,issuedAt:now,releasedAt:""}))};
  rentalStock.batches.unshift(batch);
  receivers.forEach(receiver=>logReceiverEvent(receiver.id,"Issued to rental manager stock",`${batch.managerName} · Batch ${batch.batchNumber}`,"assignment",now));
  save("Issue rental manager receiver batch");closeModal("rentalStockModal");renderRentalStock();renderDashboard();toast(`${receivers.length} receivers issued to ${batch.managerName}.`);
});
$("rentalStockRows").addEventListener("click",event=>{
  const button=event.target.closest("[data-rental-stock-remove]");if(!button)return;
  if(currentUser?.role!=="admin"){toast("Only administrators can remove a receiver from a rental batch.");return}
  const batch=activeRentalStockBatch();const receiver=assetById(button.dataset.rentalStockRemove);
  if(!batch||!receiver||!batch.receiverIds.includes(receiver.id))return;
  const reason=prompt(`Reason for removing ${receiver.assetNumber} from Batch ${batch.batchNumber}:`,receiver.notes||"");
  if(reason===null)return;
  if(!confirm(`Remove ${receiver.assetNumber} from ${batch.managerName}'s active stock? Its receiver history will be preserved.`))return;
  const now=new Date().toISOString();
  batch.receiverIds=batch.receiverIds.filter(id=>id!==receiver.id);
  batch.removedItems=batch.removedItems||[];
  batch.removedItems.push({receiverId:receiver.id,removedAt:now,removedBy:currentUser.name,reason:reason.trim()||"Removed by administrator",condition:receiver.condition||"Good"});
  const item=(batch.items||[]).find(entry=>entry.receiverId===receiver.id);
  if(item)Object.assign(item,{removedAt:now,removedBy:currentUser.name,removalReason:reason.trim()||"Removed by administrator"});
  logReceiverEvent(receiver.id,"Removed from rental manager stock",`Batch ${batch.batchNumber} · ${reason.trim()||"Removed by administrator"}`,"assignment",now);
  if(batch.receiverIds.length===0){batch.status="Completed";batch.completedAt=now}
  save("Remove receiver from rental manager batch");renderRentalStock();renderDashboard();toast(`${receiver.assetNumber} removed from the active rental batch.`);
});
$("refreshActivationsButton").onclick=()=>loadRemoteActivations(true);
$("activationSearch").oninput=renderActivations;
$("activationStatusFilter").onchange=renderActivations;
$("activationAssetInput").oninput=updateActivationAccountDisplay;
$("activationForm").addEventListener("submit",event=>{
  event.preventDefault();
  const id=$("activationEditId").value;
  const receiver=master.find(item=>item.assetNumber.toUpperCase()===$("activationAssetInput").value.trim().toUpperCase());
  if(!receiver){toast("That receiver is not in the Master Registry.");return}
  const existing=activations.find(item=>item.id===id);
  const assignment=assignmentForAsset(receiver.id);
  const request={
    id:id||makeId(),
    assetId:receiver.id,
    accountId:assignment?.accountId||existing?.accountId||"",
    action:$("activationActionInput").value,
    requestedAt:$("activationDateInput").value,
    status:existing?.status||"Pending",
    completedAt:existing?.completedAt||null,
    requesterName:$("activationRequesterInput").value.trim(),
    notes:$("activationNotesInput").value.trim()
  };
  activations=id?activations.map(item=>item.id===id?request:item):[request,...activations];
  save(id?"Edit activation request":"Create activation request");
  closeModal("activationModal");
  renderActivations();
  toast(id?"Activation request updated.":"Activation request created.");
});
$("activationRows").addEventListener("click",async event=>{
  const complete=event.target.closest("[data-activation-complete]");
  const edit=event.target.closest("[data-activation-edit]");
  const cancel=event.target.closest("[data-activation-cancel]");
  const reopen=event.target.closest("[data-activation-reopen]");
  const remove=event.target.closest("[data-activation-delete]");
  if(edit){openActivationForm(activations.find(item=>item.id===edit.dataset.activationEdit));return}
  const id=complete?.dataset.activationComplete||cancel?.dataset.activationCancel||reopen?.dataset.activationReopen||remove?.dataset.activationDelete;
  const request=remoteActivations.find(item=>item.id===id)||activations.find(item=>item.id===id);
  if(!request)return;
  if(request.source==="QR"){
    try{
      if(remove){
        if(!confirm("Delete this QR service request?"))return;
        const receiver=master.find(item=>item.assetNumber===request.assetNumber);
        const account=activationAccount(request,receiver);
        if(receiver){archiveActivationEvent(request,receiver,account,"archived");save("Archive receiver service history")}
        await deleteRemoteActivation(request);
        toast("Service request deleted.");
      }else{
        const status=complete?"Completed":cancel?"Cancelled":"Pending";
        await updateRemoteActivation(request,status);
        if(complete){
          const receiver=master.find(item=>item.assetNumber===request.assetNumber);
          if(receiver){
            setReceiverRentState(receiver,"On Rent");
            const completedRequest={...request,status:"Completed",completedAt:new Date().toISOString()};
            archiveActivationEvent(completedRequest,receiver,activationAccount(request,receiver),"completed");
            save("Complete QR service request");
            renderDashboard();renderAccounts();renderMaster();
          }
        }
        toast(status==="Completed"?"Service request completed.":status==="Cancelled"?"Service request cancelled.":"Service request reopened.");
      }
    }catch(error){
      console.error(error);
      toast(error instanceof Error?error.message:"Unable to update service request.");
    }
    return;
  }
  if(complete){
    request.status="Completed";
    request.completedAt=new Date().toISOString();
    const receiver=assetById(request.assetId);
    if(receiver)setReceiverRentState(receiver,request.action==="Activate"?"On Rent":"Off Rent");
    if(receiver)archiveActivationEvent(request,receiver,activationAccount(request,receiver),"completed");
    save(`Complete ${request.action.toLowerCase()} request`);
    renderDashboard();renderAccounts();renderMaster();
    toast(`${request.action} request completed and rent status updated.`);
  }else if(cancel){
    request.status="Cancelled";request.completedAt=null;
    save("Cancel activation request");
    toast("Activation request cancelled.");
  }else if(reopen){
    request.status="Pending";request.completedAt=null;
    save("Reopen activation request");
    toast("Activation request reopened.");
  }else if(remove&&confirm("Delete this activation request?")){
    const receiver=assetById(request.assetId);
    if(receiver)archiveActivationEvent(request,receiver,activationAccount(request,receiver),"archived");
    activations=activations.filter(item=>item.id!==request.id);
    save("Delete activation request");
    toast("Activation request deleted.");
  }
  renderActivations();
});

$("labelSearch").oninput=renderLabels;
$("labelAccountFilter").onchange=renderLabels;
$("labelReceiverList").addEventListener("change",event=>{
  const checkbox=event.target.closest("[data-label-id]");
  if(!checkbox)return;
  checkbox.checked?selectedLabelIds.add(checkbox.dataset.labelId):selectedLabelIds.delete(checkbox.dataset.labelId);
  renderLabels();
});
$("selectVisibleLabels").onchange=event=>{
  const checked=event.target.checked;
  visibleLabelReceivers().forEach(({receiver})=>checked?selectedLabelIds.add(receiver.id):selectedLabelIds.delete(receiver.id));
  renderLabels();
};
$("clearLabelSelection").onclick=()=>{selectedLabelIds.clear();renderLabels()};
function printDkLabels(kind){
  if(!selectedLabelIds.size)return;
  // Refresh from current receiver records before cloning, including changes from cloud sync.
  renderLabels();
  const isService=kind==="service";
  const sourceLabels=[...$("labelPreviewGrid").querySelectorAll(isService?".service-qr-label":".receiver-id-label")];
  if(!sourceLabels.length)return;
  if(sourceLabels.some(label=>label.dataset.codeError)){
    toast("A selected label has an invalid code. Correct the receiver details before printing.");
    return;
  }
  const roll=isService?"DK-2212":"DK-2211",rollWidth=isService?62:29,cutLength=isService?150:90;
  const pageWidth=isService?rollWidth:cutLength,pageHeight=isService?cutLength:rollWidth;
  const imageSources=new Set();
  const labels=sourceLabels.map(label=>{
    const clone=label.cloneNode(true);
    if(!isService){
      // Match the working landscape driver page. Keep the barcode artwork
      // at its existing physical size, without a portrait wrapper overflowing it.
      const barcode=clone.querySelector(".dk-barcode");
      const asset=barcode.dataset.barcode;
      barcode.removeAttribute("class");
      barcode.removeAttribute("style");
      barcode.setAttribute("x","4");
      barcode.setAttribute("y","2.5");
      barcode.setAttribute("width","82");
      barcode.setAttribute("height","19");
      return `<div class="label-print-page"><svg class="barcode-print-page" xmlns="http://www.w3.org/2000/svg" width="90mm" height="29mm" viewBox="0 0 90 29" aria-label="Barcode label for ${esc(asset)}">
        <rect width="90" height="29" fill="#fff"/>
        <g>${barcode.outerHTML}<text x="45" y="26" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="3.88" font-weight="700" fill="#000">${esc(asset)}</text></g>
      </svg></div>`;
    }
    clone.querySelectorAll("img[src],image[href]").forEach(image=>{
      const attribute=image.localName==="image"?"href":"src";
      const source=new URL(image.getAttribute(attribute),document.baseURI).href;
      image.setAttribute(attribute,source);
      imageSources.add(source);
    });
    return `<div class="label-print-page">${clone.outerHTML}</div>`;
  }).join("");
  const frame=document.createElement("iframe");
  frame.title=`${roll} label print`;
  // A measurable offscreen frame lets text fitting run without showing the print sheet.
  frame.style.cssText=`position:fixed;width:${pageWidth}mm;height:${pageHeight}mm;border:0;left:-10000px;top:0`;
  document.body.appendChild(frame);
  const printDocument=frame.contentDocument;
  const stylesheet=new URL("labels.css?v=55",document.baseURI).href;
  let started=false;
  const printFrame=async()=>{
    if(started)return;
    started=true;
    try{
      await Promise.all([...imageSources].map(source=>new Promise((resolve,reject)=>{
        const image=new Image();image.onload=resolve;image.onerror=reject;image.src=source;
      })));
      await printDocument.fonts.ready;
      if(!printDocument.querySelector("link").sheet)throw new Error("Label stylesheet unavailable");
      fitLabelText(printDocument);
      frame.contentWindow.addEventListener("afterprint",()=>frame.remove(),{once:true});
      frame.contentWindow.focus();
      frame.contentWindow.print();
    }catch{
      frame.remove();
      toast("The label artwork did not finish loading. Please try printing again.");
    }
  };
  frame.onload=printFrame;
  printDocument.open();
  printDocument.write(`<!doctype html><html><head><meta charset="utf-8"><title>${roll} Labels</title>
    <link rel="stylesheet" href="${esc(stylesheet)}">
    <style>
      @page{size:${pageWidth}mm ${pageHeight}mm;margin:0}
      html,body{width:${pageWidth}mm!important;max-width:${pageWidth}mm!important;margin:0!important;padding:0!important;background:#fff;color:#000}
      .label-print-page{position:relative;box-sizing:border-box;width:${pageWidth}mm;height:${isService?pageHeight:27}mm;margin:0;padding:0;break-inside:avoid;overflow:hidden}
      .label-print-page+.label-print-page{break-before:page;page-break-before:always}
      .barcode-print-page{position:absolute;left:0;top:0;display:block;width:90mm;height:29mm;max-width:none;print-color-adjust:exact;-webkit-print-color-adjust:exact}
      .label-print-page>.dk-label{position:absolute;left:0;top:0;transform-origin:top left;transform:translateX(${rollWidth}mm) rotate(90deg)}
    </style></head><body>${labels}</body></html>`);
  printDocument.close();
}
$("printLabelsButton").onclick=()=>printDkLabels("receiver");
$("printServiceLabelsButton").onclick=()=>printDkLabels("service");

$("accountSearch").oninput=renderAccounts;
$("expandAllAccounts").onclick=()=>{
  accounts.forEach(account=>expandedAccountIds.add(account.id));
  renderAccounts();
};
$("collapseAllAccounts").onclick=()=>{
  expandedAccountIds.clear();
  renderAccounts();
};
$("receiverSearch").oninput=renderAccountDetail;
$("masterSearch").oninput=renderMaster;
$("accountCardGrid").addEventListener("click",event=>{
  const toggle=event.target.closest("[data-toggle-account]");
  if(toggle){
    const id=toggle.dataset.toggleAccount;
    if(expandedAccountIds.has(id))expandedAccountIds.delete(id);
    else expandedAccountIds.add(id);
    renderAccounts();
    return;
  }

  const open=event.target.closest("[data-open-account]");
  if(open){
    openAccount(open.dataset.openAccount);
    return;
  }

  const edit=event.target.closest("[data-inline-edit-account]");
  if(edit){
    openAccountForm(accountById(edit.dataset.inlineEditAccount));
    return;
  }

  const add=event.target.closest("[data-inline-add]");
  if(add){
    currentAccountId=add.dataset.inlineAdd;
    openAssign();
    return;
  }

  const importButton=event.target.closest("[data-inline-import]");
  if(importButton){
    currentAccountId=importButton.dataset.inlineImport;
    openAccountImportModal();
    return;
  }

  const move=event.target.closest("[data-inline-move]");
  if(move){
    currentAccountId=move.dataset.accountId;
    openMove(move.dataset.inlineMove);
    return;
  }

  const remove=event.target.closest("[data-inline-remove]");
  if(remove){
    const receiver=assetById(remove.dataset.inlineRemove);
    if(confirm(`Remove ${receiver?.assetNumber||"this receiver"} from the account? It will remain in the Master Registry.`)){
      const priorAssignment=assignmentForAsset(remove.dataset.inlineRemove);
      const priorAccount=accountById(priorAssignment?.accountId);
      logReceiverEvent(remove.dataset.inlineRemove,"Removed from active account",priorAccount?`Account ${priorAccount.number} · ${priorAccount.name}`:"Account assignment removed","inactive");
      assignments=assignments.filter(item=>item.assetId!==remove.dataset.inlineRemove);
      save("Remove receiver from account");
      renderAccounts();
      renderDashboard();
      toast("Receiver removed from account and kept in Master Registry.");
    }
  }
});
$("dashboardAccounts").addEventListener("click",e=>{const row=e.target.closest("[data-open-account]");if(row)openAccount(row.dataset.openAccount)});
$("receiverRows").addEventListener("click",e=>{
const move=e.target.closest("[data-move]"),remove=e.target.closest("[data-remove]");
if(move)openMove(move.dataset.move);
if(remove&&confirm("Remove this receiver from the account? It will remain in the Master Registry.")){
  const priorAssignment=assignmentForAsset(remove.dataset.remove);
  const priorAccount=accountById(priorAssignment?.accountId);
  logReceiverEvent(remove.dataset.remove,"Removed from active account",priorAccount?`Account ${priorAccount.number} · ${priorAccount.name}`:"Account assignment removed","inactive");
  assignments=assignments.filter(a=>a.assetId!==remove.dataset.remove);
  save("Remove receiver from account");renderAccountDetail();renderDashboard();toast("Receiver removed from account and kept in Master Registry.");
}
});
$("masterRows").addEventListener("click",e=>{const btn=e.target.closest("[data-edit-master]");if(btn)openMasterForm(assetById(btn.dataset.editMaster))});
$("menuButton").onclick=()=>{$("sidebar").classList.toggle("open");$("sidebarOverlay").classList.toggle("show")};
$("sidebarOverlay").onclick=closeSidebar;
function closeSidebar(){$("sidebar").classList.remove("open");$("sidebarOverlay").classList.remove("show")}
renderDashboard();renderAccounts();renderMaster();renderActivations();renderLabels();updateUndoControls();

let pendingAccountImport=null;

function normalizeCsvHeader(value){
  return String(value||"").trim().toLowerCase().replace(/[^a-z0-9]/g,"");
}

function parseCsvText(text){
  const rows=[];
  let row=[];
  let cell="";
  let quoted=false;

  for(let i=0;i<text.length;i++){
    const ch=text[i];
    const next=text[i+1];

    if(ch==='"' && quoted && next==='"'){
      cell+='"';
      i++;
      continue;
    }

    if(ch==='"'){
      quoted=!quoted;
      continue;
    }

    if(ch==="," && !quoted){
      row.push(cell.trim());
      cell="";
      continue;
    }

    if((ch==="\n" || ch==="\r") && !quoted){
      if(ch==="\r" && next==="\n")i++;
      row.push(cell.trim());
      cell="";
      if(row.some(v=>v!==""))rows.push(row);
      row=[];
      continue;
    }

    cell+=ch;
  }

  row.push(cell.trim());
  if(row.some(v=>v!==""))rows.push(row);

  if(rows.length<2)throw new Error("The CSV does not contain any receiver rows.");

  const headers=rows[0].map(normalizeCsvHeader);
  return rows.slice(1).map(values=>{
    const record={};
    headers.forEach((header,index)=>record[header]=values[index]??"");
    return record;
  });
}

function csvValue(row,aliases){
  for(const alias of aliases){
    const key=normalizeCsvHeader(alias);
    if(row[key]!==undefined && String(row[key]).trim()!==""){
      return String(row[key]).trim();
    }
  }
  return "";
}

function accountImportRecord(row){
  return {
    assetNumber:csvValue(row,["Asset Number","Asset","Asset #","Asset ID","Unit Number"]).toUpperCase(),
    model:csvValue(row,["Model","Receiver Model"]),
    accessCard:csvValue(row,["Access Card","Access Card Number","Card Number","Card"]),
    rid:csvValue(row,["RID","Receiver ID","ReceiverID","Receiver RID Num"]),
    serial:csvValue(row,["Serial Number","Serial","SN"]),
    type:csvValue(row,["Receiver Type","Type"])
  };
}

function resetAccountImportModal(){
  pendingAccountImport=null;
  $("accountImportStart").hidden=false;
  $("accountImportPreview").hidden=true;
  $("accountImportFileInput").value="";
}

function openAccountImportModal(){
  const currentCount=assignedFor(currentAccountId).length;
  if(currentCount>=20){
    toast("This account already has 20 receivers.");
    return;
  }
  resetAccountImportModal();
  openModal("accountImportModal");
}

async function prepareAccountImport(file){
  try{
    const rawRows=parseCsvText(await file.text());
    const records=rawRows.map(accountImportRecord);
    const currentCount=assignedFor(currentAccountId).length;
    const availableSlots=Math.max(0,20-currentCount);
    const seen=new Set();
    const preview=[];
    let newToMaster=0;
    let ready=0;
    let warnings=0;

    for(let i=0;i<records.length;i++){
      const record=records[i];

      if(!record.assetNumber){
        warnings++;
        preview.push({
          asset:`Row ${i+2}`,
          master:"Blocked",
          assignment:"Blocked",
          detail:"Missing Asset Number",
          canApply:false
        });
        continue;
      }

      if(seen.has(record.assetNumber)){
        warnings++;
        preview.push({
          asset:record.assetNumber,
          master:"Duplicate Row",
          assignment:"Blocked",
          detail:"Duplicate Asset Number in this CSV",
          canApply:false
        });
        continue;
      }
      seen.add(record.assetNumber);

      const existingMaster=master.find(x=>x.assetNumber.toUpperCase()===record.assetNumber);
      const existingAssignment=existingMaster ? assignmentForAsset(existingMaster.id) : null;

      if(existingAssignment){
        const assignedAccount=accountById(existingAssignment.accountId);
        warnings++;
        preview.push({
          asset:record.assetNumber,
          master:"Existing",
          assignment:"Blocked",
          detail:`Already assigned to Account ${assignedAccount?.number||"Unknown"}`,
          canApply:false
        });
        continue;
      }

      const applyIndex=ready;
      const withinCapacity=applyIndex<availableSlots;

      if(!withinCapacity){
        warnings++;
        preview.push({
          asset:record.assetNumber,
          master:existingMaster ? "Existing" : "New",
          assignment:"Blocked",
          detail:"Would exceed the 20-receiver account limit",
          canApply:false
        });
        continue;
      }

      if(!existingMaster)newToMaster++;
      ready++;

      preview.push({
        asset:record.assetNumber,
        master:existingMaster ? "Existing" : "New",
        assignment:"Ready",
        detail:record.model || record.accessCard || record.rid || "Receiver record",
        canApply:true,
        record
      });
    }

    pendingAccountImport={fileName:file.name,preview};

    $("accountImportStart").hidden=true;
    $("accountImportPreview").hidden=false;
    $("accountImportFileName").textContent=file.name;
    $("accountImportRows").textContent=records.length;
    $("accountImportNew").textContent=newToMaster;
    $("accountImportReady").textContent=ready;
    $("accountImportWarnings").textContent=warnings;
    $("accountImportMessage").textContent=`This account currently has ${currentCount} receiver${currentCount===1?"":"s"} and ${availableSlots} available slot${availableSlots===1?"":"s"}. Only rows marked Ready will be applied.`;
    $("applyAccountImport").disabled=ready===0;

    $("accountImportPreviewRows").innerHTML=preview.map(item=>{
      const masterClass=item.master==="New"?"import-new":item.master==="Existing"?"import-ok":"import-warn";
      const assignmentClass=item.assignment==="Ready"?"import-ok":"import-blocked";
      return `<tr>
        <td><strong>${esc(item.asset)}</strong></td>
        <td><span class="${masterClass}">${esc(item.master)}</span></td>
        <td><span class="${assignmentClass}">${esc(item.assignment)}</span></td>
        <td>${esc(item.detail)}</td>
      </tr>`;
    }).join("");
  }catch(error){
    toast(error.message||"Unable to read that CSV.");
  }
}

function applyAccountImport(){
  if(!pendingAccountImport)return;

  let applied=0;
  let newMasterCount=0;

  for(const item of pendingAccountImport.preview){
    if(!item.canApply)continue;

    const record=item.record;
    let receiver=master.find(x=>x.assetNumber.toUpperCase()===record.assetNumber);

    if(!receiver){
      receiver={
        id:makeId(),
        assetNumber:record.assetNumber,
        model:record.model,
        accessCard:record.accessCard,
        rid:record.rid,
        serial:record.serial,
        type:record.type,
        rentState:"Off Rent",
        offRentSince:new Date().toISOString()
      };
      master.push(receiver);
      newMasterCount++;
    }else{
      receiver.model=record.model||receiver.model;
      receiver.accessCard=record.accessCard||receiver.accessCard;
      receiver.rid=record.rid||receiver.rid;
      receiver.serial=record.serial||receiver.serial;
      receiver.type=record.type||receiver.type;
    }

    if(!assignmentForAsset(receiver.id)){
      assignments.push({
        id:makeId(),
        assetId:receiver.id,
        accountId:currentAccountId,
        assignedAt:new Date().toISOString()
      });
      applied++;
    }
  }

  save("Import receivers to account");
  closeModal("accountImportModal");
  resetAccountImportModal();
  renderAccountDetail();
  renderAccounts();
  renderMaster();
  renderDashboard();
  toast(`${applied} receiver${applied===1?"":"s"} assigned. ${newMasterCount} added to Master Registry.`);
}

$("importAccountReceiversButton").addEventListener("click",openAccountImportModal);
$("chooseAccountImportFile").addEventListener("click",()=>{
  $("accountImportFileInput").value="";
  $("accountImportFileInput").click();
});
$("accountImportFileInput").addEventListener("change",event=>{
  const file=event.target.files[0];
  if(file)prepareAccountImport(file);
});
$("cancelAccountImportPreview").addEventListener("click",()=>{
  closeModal("accountImportModal");
  resetAccountImportModal();
});
$("backToAccountImportStart").addEventListener("click",resetAccountImportModal);
$("applyAccountImport").addEventListener("click",applyAccountImport);


const AUDIT_KEY="atp.audit.v8";
let auditState=load(AUDIT_KEY,null);
let pendingAuditImport=null;

function persistAuditCache(value=auditState){
  try{
    // Remove the previous audit first so replacement data does not temporarily
    // count twice against the browser's small local-storage quota.
    localStorage.removeItem(AUDIT_KEY);
    if(value)localStorage.setItem(AUDIT_KEY,JSON.stringify(value));
    return true;
  }catch(error){
    // Audit results remain in memory and are saved by cloud sync. A full browser
    // cache must never stop the audit from running or displaying its results.
    try{localStorage.removeItem(AUDIT_KEY)}catch{}
    console.warn("Audit result could not be cached in this browser",error);
    return false;
  }
}

function auditRecordFromRow(row){
  return {
    accountNumber:csvValue(row,["Account Number","Account","Account #","Acct Number","Acct"]),
    accessCard:csvValue(row,["Access Card","Access Card Number","Card Number","Card"]),
    rid:csvValue(row,["RID","Receiver ID","ReceiverID","Receiver RID Num"])
  };
}

function receiverKey(card,rid){
  const c=String(card||"").trim();
  const r=String(rid||"").trim();
  if(c&&r)return `C:${c}|R:${r}`;
  if(c)return `C:${c}`;
  if(r)return `R:${r}`;
  return "";
}

function appReceiverSnapshot(accountId){
  return assignedFor(accountId).map(assignment=>{
    const asset=assetById(assignment.assetId);
    return {
      assetNumber:asset?.assetNumber||"",
      accessCard:asset?.accessCard||"",
      rid:asset?.rid||"",
      key:receiverKey(asset?.accessCard,asset?.rid)
    };
  });
}

function compareAuditRows(validRows,fileName){
  const auditByAccount=new Map();

  for(const row of validRows){
    const normalizedAccount=normalizeAuditAccount(row.accountNumber);
    if(!auditByAccount.has(normalizedAccount))auditByAccount.set(normalizedAccount,[]);
    auditByAccount.get(normalizedAccount).push({...row,accountNumber:normalizedAccount,key:receiverKey(row.accessCard,row.rid)});
  }

  // Audit only the accounts tracked by this local facility.
  // Company-wide accounts in the DirecTV workbook are intentionally ignored.
  const accountNumbers=new Set(accounts.map(account=>normalizeAuditAccount(account.number)).filter(Boolean));

  const results=[];

  for(const accountNumber of accountNumbers){
    const account=accounts.find(a=>normalizeAuditAccount(a.number)===accountNumber);
    const appRows=account?appReceiverSnapshot(account.id):[];
    const auditRows=auditByAccount.get(accountNumber)||[];

    const appMap=new Map();
    const auditMap=new Map();

    for(const row of appRows){
      if(!appMap.has(row.key))appMap.set(row.key,[]);
      appMap.get(row.key).push(row);
    }
    for(const row of auditRows){
      if(!auditMap.has(row.key))auditMap.set(row.key,[]);
      auditMap.get(row.key).push(row);
    }

    const matched=[];
    const missingFromAudit=[];
    const missingFromApp=[];

    const allKeys=new Set([...appMap.keys(),...auditMap.keys()]);
    for(const key of allKeys){
      const appList=appMap.get(key)||[];
      const auditList=auditMap.get(key)||[];
      const matchCount=Math.min(appList.length,auditList.length);

      for(let i=0;i<matchCount;i++)matched.push({app:appList[i],audit:auditList[i]});
      for(let i=matchCount;i<appList.length;i++)missingFromAudit.push({...appList[i],issueId:makeId(),status:"needs-research",notes:"",updatedAt:""});
      for(let i=matchCount;i<auditList.length;i++)missingFromApp.push({...auditList[i],issueId:makeId(),status:"needs-research",notes:"",updatedAt:""});
    }

    const countMatch=appRows.length===auditRows.length;
    const perfect=Boolean(account)&&countMatch&&missingFromAudit.length===0&&missingFromApp.length===0;

    results.push({
      accountNumber,
      accountName:account?.name||"Account not found in app",
      appCount:appRows.length,
      auditCount:auditRows.length,
      countMatch,
      matchedCount:matched.length,
      missingFromAudit,
      missingFromApp,
      perfect,
      accountExists:Boolean(account)
    });
  }

  return {
    fileName,
    importedAt:new Date().toISOString(),
    results
  };
}

function auditIssues(){
  if(!auditState?.results)return [];
  return auditState.results.flatMap(result=>[
    ...result.missingFromAudit.map(issue=>({result,issue,source:"app"})),
    ...result.missingFromApp.map(issue=>({result,issue,source:"audit"}))
  ]);
}

function auditUnresolvedIssues(){
  return auditIssues().filter(({issue})=>!["corrected","ignored"].includes(issue.status||"needs-research"));
}

function auditStatusLabel(status){
  return ({"needs-research":"Needs Research",confirmed:"Confirmed",corrected:"Corrected",ignored:"Ignored"})[status]||"Needs Research";
}

function findAuditIssue(issueId){
  return auditIssues().find(item=>item.issue.issueId===issueId)||null;
}

function saveAuditWorkflow(label){
  recordUndo(label,true);
  persistAuditCache();
  scheduleCloudSave();
  updateUndoControls();
  renderAuditResults();
  renderDashboard();
}

function masterReceiverForAuditIssue(issue){
  return master.find(receiver=>receiverKey(receiver.accessCard,receiver.rid)===receiverKey(issue.accessCard,issue.rid))||null;
}

function auditWorkflowMarkup(issue,source){
  const status=issue.status||"needs-research";
  const receiver=source==="app"?master.find(item=>item.assetNumber===issue.assetNumber):masterReceiverForAuditIssue(issue);
  const assignment=receiver?assignmentForAsset(receiver.id):null;
  const actions=[];
  if(source==="app"&&receiver){
    actions.push(`<button class="small-button" data-audit-edit="${esc(receiver.id)}">Correct Record</button>`);
    actions.push(`<button class="small-button" data-audit-move="${esc(receiver.id)}">Move</button>`);
    actions.push(`<button class="small-button danger" data-audit-remove="${esc(receiver.id)}">Remove</button>`);
  }else if(receiver&&!assignment){
    actions.push(`<button class="small-button" data-audit-assign="${esc(issue.issueId)}">Assign Here</button>`);
    actions.push(`<button class="small-button" data-audit-edit="${esc(receiver.id)}">Correct Record</button>`);
  }else if(receiver&&assignment){
    actions.push(`<button class="small-button" data-audit-move-here="${esc(issue.issueId)}">Move Here</button>`);
    actions.push(`<button class="small-button" data-audit-edit="${esc(receiver.id)}">Correct Record</button>`);
  }else{
    actions.push(`<button class="small-button" data-audit-add-master="${esc(issue.issueId)}">Add to Master</button>`);
  }
  return `<div class="audit-workflow">
    <div class="audit-workflow-top">
      <span class="audit-status-pill ${esc(status)}">${esc(auditStatusLabel(status))}</span>
      <select class="audit-status-select" data-audit-status="${esc(issue.issueId)}" aria-label="Audit issue status">
        ${["needs-research","confirmed","corrected","ignored"].map(value=>`<option value="${value}" ${status===value?"selected":""}>${auditStatusLabel(value)}</option>`).join("")}
      </select>
    </div>
    <textarea class="audit-note-input" data-audit-note="${esc(issue.issueId)}" placeholder="Research notes…">${esc(issue.notes||"")}</textarea>
    ${issue.changedBy?`<span class="changed-by">Changed by ${esc(issue.changedBy)}</span>`:""}
    <div class="audit-row-actions">${actions.join("")}</div>
  </div>`;
}

function renderAuditResults(){
  let workflowUpgraded=false;
  for(const {issue} of auditIssues()){
    if(!issue.issueId){issue.issueId=makeId();workflowUpgraded=true}
    if(!issue.status){issue.status="needs-research";workflowUpgraded=true}
    if(typeof issue.notes!=="string"){issue.notes="";workflowUpgraded=true}
  }
  if(workflowUpgraded){
    persistAuditCache();
    scheduleCloudSave();
  }
  const hasAudit=Boolean(auditState?.results?.length);
  $("auditEmptyState").hidden=hasAudit;
  $("auditResults").hidden=!hasAudit;
  $("clearAuditButton").disabled=!hasAudit;
  $("exportAuditButton").disabled=!hasAudit;
  $("printAuditButton").disabled=!hasAudit;
  $("auditFileLabel").textContent=hasAudit?`${auditState.fileName} · ${new Date(auditState.importedAt).toLocaleString()}`:"No audit imported";

  if(!hasAudit){
    $("auditAccountsChecked").textContent="0";
    $("auditPerfectMatches").textContent="0";
    $("auditIssueAccounts").textContent="0";
    $("auditUnmatchedReceivers").textContent="0";
    return;
  }

  const perfect=auditState.results.filter(r=>r.perfect).length;
  const issues=auditState.results.length-perfect;
  const unmatched=auditUnresolvedIssues().length;

  $("auditAccountsChecked").textContent=auditState.results.length;
  $("auditPerfectMatches").textContent=perfect;
  $("auditIssueAccounts").textContent=issues;
  $("auditUnmatchedReceivers").textContent=unmatched;

  const query=$("auditSearch").value.trim().toLowerCase();
  const filter=$("auditStatusFilter").value;

  const filtered=auditState.results.filter(result=>{
    const text=[
      result.accountNumber,
      result.accountName,
      ...result.missingFromAudit.flatMap(x=>[x.assetNumber,x.accessCard,x.rid]),
      ...result.missingFromApp.flatMap(x=>[x.accessCard,x.rid])
    ].join(" ").toLowerCase();

    const matchesSearch=text.includes(query);
    const resultStatuses=[...result.missingFromAudit,...result.missingFromApp].map(issue=>issue.status||"needs-research");
    const matchesFilter=filter==="all"||(filter==="perfect"&&result.perfect)||(filter==="issues"&&!result.perfect)||resultStatuses.includes(filter);
    return matchesSearch&&matchesFilter;
  });

  $("auditAccountList").innerHTML=filtered.map(result=>{
    const issueCount=result.missingFromAudit.length+result.missingFromApp.length;
    const appMissingRows=result.missingFromAudit.map(x=>`
      <div class="audit-issue-row">
        <div><strong>${esc(x.assetNumber||"Unknown Asset")}</strong><span>App assignment</span></div>
        <div><strong>${esc(x.accessCard||"No card")}</strong><span>RID: ${esc(x.rid||"—")}</span></div>
        ${auditWorkflowMarkup(x,"app")}
      </div>`).join("");

    const auditMissingRows=result.missingFromApp.map(x=>`
      <div class="audit-issue-row">
        <div><strong>${esc(x.accessCard||"No card")}</strong><span>DirecTV audit</span></div>
        <div><strong>RID: ${esc(x.rid||"—")}</strong><span>Not assigned in app account</span></div>
        ${auditWorkflowMarkup(x,"audit")}
      </div>`).join("");

    return `<section class="audit-account-card ${result.perfect?"perfect":"issues"}">
      <button class="audit-account-header" type="button">
        <span class="audit-account-title">
          <strong>Account ${esc(result.accountNumber)}</strong>
          <span>${esc(result.accountName)}</span>
        </span>
        <span class="audit-badges">
          <span class="audit-badge ${result.countMatch?"good":"bad"}">Count ${result.countMatch?"Matches":"Mismatch"}</span>
          <span class="audit-badge ${result.perfect?"good":"warn"}">${result.perfect?"Perfect Match":issueCount+" Receiver Issue"+(issueCount===1?"":"s")}</span>
        </span>
        <span class="audit-toggle">⌄</span>
      </button>

      <div class="audit-account-body">
        <div class="audit-count-line">
          <div class="audit-count-box"><span>App Count</span><strong>${result.appCount}</strong></div>
          <div class="audit-count-box"><span>DirecTV Count</span><strong>${result.auditCount}</strong></div>
          <div class="audit-count-box"><span>Correct Matches</span><strong>${result.matchedCount}</strong></div>
          <div class="audit-count-box"><span>Receiver Issues</span><strong>${issueCount}</strong></div>
        </div>

        ${result.perfect
          ? `<div class="audit-perfect-message">The account count and every receiver match the DirecTV audit.</div>`
          : `<div class="audit-issue-grid">
              <section class="audit-issue-section">
                <h4>In App, Missing from DirecTV Audit (${result.missingFromAudit.length})</h4>
                <div class="audit-issue-list">${appMissingRows||'<div class="audit-issue-row"><div><strong>None</strong></div></div>'}</div>
              </section>
              <section class="audit-issue-section">
                <h4>In DirecTV Audit, Missing from App Account (${result.missingFromApp.length})</h4>
                <div class="audit-issue-list">${auditMissingRows||'<div class="audit-issue-row"><div><strong>None</strong></div></div>'}</div>
              </section>
            </div>`
        }
      </div>
    </section>`;
  }).join("");
}

function resetAuditImport(){
  pendingAuditImport=null;
  $("auditImportStart").hidden=false;
  $("auditImportPreview").hidden=true;
  $("auditFileInput").value="";
}

function openAuditImport(){
  resetAuditImport();
  openModal("auditImportModal");
}

async function readAuditImportRows(file){
  const extension=file.name.split(".").pop().toLowerCase();
  if(!["xlsx","xls","csv"].includes(extension))throw new Error("Choose an XLSX, XLS, or CSV audit file.");
  const book=await readExcelBook(file);
  const accountKeys=new Set(["accountnumber","account","accountno","acctnumber","acct"]);
  const cardKeys=new Set(["accesscard","accesscardnumber","cardnumber","card"]);
  const ridKeys=new Set(["rid","receiverid","receiverridnum","receiverridnumber"]);
  const preferred=[...book.SheetNames].sort((a,b)=>Number(normalizeImportKey(b)==="receiverreport")-Number(normalizeImportKey(a)==="receiverreport"));
  for(const sheetName of preferred){
    const matrix=XLSX.utils.sheet_to_json(book.Sheets[sheetName],{header:1,defval:"",raw:false});
    const headerRowIndex=matrix.slice(0,50).findIndex(row=>{
      const keys=row.map(normalizeImportKey);
      return keys.some(key=>accountKeys.has(key))&&(keys.some(key=>cardKeys.has(key))||keys.some(key=>ridKeys.has(key)));
    });
    if(headerRowIndex<0)continue;
    const headers=matrix[headerRowIndex].map(normalizeCsvHeader);
    return matrix.slice(headerRowIndex+1).filter(row=>row.some(value=>String(value||"").trim()!=="")).map(values=>{
      const record={};headers.forEach((header,index)=>{if(header)record[header]=values[index]??""});return record;
    });
  }
  throw new Error("Could not find an Account Number column plus an Access Card or Receiver RID column in the audit file.");
}

function normalizeAuditAccount(value){return String(value||"").trim().replace(/\.0+$/g,"").replace(/\s+/g,"")}

async function prepareAuditImport(file){
  try{
    const rawRows=await readAuditImportRows(file);
    const parsed=rawRows.map(auditRecordFromRow);
    const preview=[];
    const valid=[];
    const localAccountNumbers=new Set(accounts.map(account=>normalizeAuditAccount(account.number)));
    let skipped=0;
    let ignoredCompanyWide=0;

    parsed.forEach((row,index)=>{
      const accountNumber=normalizeAuditAccount(row.accountNumber);
      const hasAccount=Boolean(accountNumber);
      const hasIdentifier=Boolean(row.accessCard||row.rid);
      const isLocalAccount=hasAccount&&localAccountNumbers.has(accountNumber);
      const validRow=isLocalAccount&&hasIdentifier;

      if(validRow){
        valid.push({...row,accountNumber});
      }else if(hasAccount&&!isLocalAccount){
        ignoredCompanyWide++;
      }else{
        skipped++;
      }

      preview.push({
        account:accountNumber||`Row ${index+4}`,
        card:row.accessCard||"—",
        rid:row.rid||"—",
        result:validRow
          ?"Ready"
          :hasAccount&&!isLocalAccount
            ?"Ignored — Not a Local Account"
            :!hasAccount
              ?"Missing Account Number"
              :"Missing Card and RID",
        valid:validRow,
        ignored:hasAccount&&!isLocalAccount
      });
    });

    pendingAuditImport={fileName:file.name,validRows:valid};

    $("auditImportStart").hidden=true;
    $("auditImportPreview").hidden=false;
    $("auditImportFileName").textContent=file.name;
    $("auditRowsRead").textContent=parsed.length;
    $("auditAccountsFound").textContent=new Set(valid.map(x=>x.accountNumber)).size;
    $("auditValidRows").textContent=valid.length;
    $("auditSkippedRows").textContent=skipped+ignoredCompanyWide;
    $("auditImportMessage").textContent=`Review only: this audit will not change app data. It will compare local accounts and return receiver/count mismatches for research. ${ignoredCompanyWide} company-wide row${ignoredCompanyWide===1?" was":"s were"} ignored because ${ignoredCompanyWide===1?"its account is":"their accounts are"} not tracked by this facility.`;
    $("runAuditButton").disabled=valid.length===0;

    const previewRows=[...preview.filter(item=>item.valid),...preview.filter(item=>!item.valid)].slice(0,150);
    $("auditImportPreviewRows").innerHTML=previewRows.map(item=>`
      <tr>
        <td><strong>${esc(item.account)}</strong></td>
        <td>${esc(item.card)}</td>
        <td>${esc(item.rid)}</td>
        <td><span class="${item.valid?"import-ok":item.ignored?"import-ignore":"import-blocked"}">${esc(item.result)}</span></td>
      </tr>`).join("");
  }catch(error){
    toast(error.message||"Unable to read that audit file.");
  }
}

async function runPendingAudit(){
  if(!pendingAuditImport?.validRows?.length){toast("No valid local-account audit rows are ready to compare.");return}
  const button=$("runAuditButton");const originalText=button.textContent;
  button.disabled=true;button.textContent="Running Audit…";
  $("auditImportMessage").textContent=`Comparing ${pendingAuditImport.validRows.length} DirecTV receiver rows with the app. Please wait…`;
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  try{
    // Audit imports can be large. Do not create a full-app Undo snapshot here;
    // that can exceed browser storage and abort the click before results render.
    const nextAuditState=compareAuditRows(pendingAuditImport.validRows,pendingAuditImport.fileName);
    auditState=nextAuditState;
    const cachedLocally=persistAuditCache();
    scheduleCloudSave("Run DirecTV audit");
    closeModal("auditImportModal");
    resetAuditImport();
    $("auditStatusFilter").value="issues";
    showView("audit");
    toast(`Audit complete. ${auditState.results.length} local accounts compared${cachedLocally?".":" and saved to cloud."}`);
  }catch(error){
    console.error("Audit run failed",error);
    button.disabled=false;button.textContent=originalText;
    $("auditImportMessage").textContent=`Audit could not run: ${error?.message||"Unknown browser error"}. The imported file is still available; try Run Audit again.`;
    toast("Audit could not run. Review the message in the audit window.");
  }
}

$("importAuditButton").addEventListener("click",openAuditImport);
$("chooseAuditFile").addEventListener("click",()=>{
  $("auditFileInput").value="";
  $("auditFileInput").accept=".xlsx,.xls,.csv";
  $("auditFileInput").click();
});
$("auditFileInput").addEventListener("change",event=>{
  const file=event.target.files[0];
  if(file)prepareAuditImport(file);
});
$("cancelAuditPreview").addEventListener("click",()=>{
  closeModal("auditImportModal");
  resetAuditImport();
});
$("backToAuditStart").addEventListener("click",resetAuditImport);
$("runAuditButton").addEventListener("click",runPendingAudit);
$("clearAuditButton").addEventListener("click",()=>{
  recordUndo("Clear audit results",true);
  auditState=null;
  localStorage.removeItem(AUDIT_KEY);
  scheduleCloudSave();
  updateUndoControls();
  renderAuditResults();
  toast("Audit results cleared.");
});
$("auditSearch").addEventListener("input",renderAuditResults);
$("auditStatusFilter").addEventListener("change",renderAuditResults);
$("auditAccountList").addEventListener("change",event=>{
  const status=event.target.closest("[data-audit-status]");
  const note=event.target.closest("[data-audit-note]");
  const issueId=status?.dataset.auditStatus||note?.dataset.auditNote;
  const found=findAuditIssue(issueId);
  if(!found)return;
  if(status)found.issue.status=status.value;
  if(note)found.issue.notes=note.value.trim();
  found.issue.changedBy=currentUser?.name||"Unknown";
  found.issue.updatedAt=new Date().toISOString();
  if(status)saveAuditWorkflow("Update audit issue status");
  else{
    recordUndo("Update audit research notes",true);
    persistAuditCache();
    scheduleCloudSave();
    updateUndoControls();
  }
});
$("auditAccountList").addEventListener("click",event=>{
  const header=event.target.closest(".audit-account-header");
  if(header){header.closest(".audit-account-card").classList.toggle("collapsed");return}

  const edit=event.target.closest("[data-audit-edit]");
  if(edit){
    pendingAuditIssueId=event.target.closest(".audit-workflow")?.querySelector("[data-audit-note]")?.dataset.auditNote||null;
    openMasterForm(assetById(edit.dataset.auditEdit));
    return;
  }

  const move=event.target.closest("[data-audit-move]");
  if(move){
    pendingAuditIssueId=event.target.closest(".audit-workflow")?.querySelector("[data-audit-note]")?.dataset.auditNote||null;
    openMove(move.dataset.auditMove);
    return;
  }

  const remove=event.target.closest("[data-audit-remove]");
  if(remove){
    const issueId=event.target.closest(".audit-workflow")?.querySelector("[data-audit-note]")?.dataset.auditNote;
    const receiver=assetById(remove.dataset.auditRemove);
    if(!receiver||!confirm(`Remove ${receiver.assetNumber} from its active account? It will remain in the Master Registry.`))return;
    const prior=assignmentForAsset(receiver.id);
    const priorAccount=accountById(prior?.accountId);
    assignments=assignments.filter(item=>item.assetId!==receiver.id);
    logReceiverEvent(receiver.id,"Removed during audit correction",priorAccount?`Account ${priorAccount.number} · ${priorAccount.name}`:"Active assignment removed","audit");
    save("Audit correction: remove receiver");
    completeAuditIssue(issueId,receiver.id,"Removed from active account");
    return;
  }

  const assign=event.target.closest("[data-audit-assign]");
  if(assign){assignAuditReceiver(assign.dataset.auditAssign,false);return}

  const moveHere=event.target.closest("[data-audit-move-here]");
  if(moveHere){assignAuditReceiver(moveHere.dataset.auditMoveHere,true);return}

  const add=event.target.closest("[data-audit-add-master]");
  if(add){
    const found=findAuditIssue(add.dataset.auditAddMaster);
    const account=accounts.find(item=>String(item.number)===String(found?.result.accountNumber));
    if(!found||!account)return;
    pendingAuditIssueId=found.issue.issueId;
    currentAccountId=account.id;
    openMasterForm(null,"",true);
    $("masterCardInput").value=found.issue.accessCard||"";
    $("masterRidInput").value=found.issue.rid||"";
  }
});

function completeAuditIssue(issueId,receiverId,detail){
  const found=findAuditIssue(issueId);
  if(!found)return;
  found.issue.status="corrected";
  found.issue.updatedAt=new Date().toISOString();
  found.issue.changedBy=currentUser?.name||"Unknown";
  found.issue.notes=[found.issue.notes,detail].filter(Boolean).join(found.issue.notes?" · ":"");
  if(receiverId){
    logReceiverEvent(receiverId,"Audit discrepancy corrected",`Account ${found.result.accountNumber} · ${detail}`,"audit");
    localStorage.setItem(KEYS.receiverHistory,JSON.stringify(receiverEvents));
  }
  persistAuditCache();
  scheduleCloudSave();
  renderAuditResults();
  renderDashboard();
}

function completePendingAuditAction(receiverId,detail){
  const issueId=pendingAuditIssueId;
  pendingAuditIssueId=null;
  completeAuditIssue(issueId,receiverId,detail);
}

function assignAuditReceiver(issueId,moveExisting){
  const found=findAuditIssue(issueId);
  const receiver=found?masterReceiverForAuditIssue(found.issue):null;
  const account=found?accounts.find(item=>String(item.number)===String(found.result.accountNumber)):null;
  if(!found||!receiver||!account)return;
  if(assignedFor(account.id).length>=20){toast("That account already has 20 receivers.");return}
  const existing=assignmentForAsset(receiver.id);
  const verb=existing?`move ${receiver.assetNumber} to Account ${account.number}`:`assign ${receiver.assetNumber} to Account ${account.number}`;
  if(!confirm(`Audit correction: ${verb}?`))return;
  const now=new Date().toISOString();
  const from=accountById(existing?.accountId);
  if(existing){
    existing.accountId=account.id;
    existing.assignedAt=now;
  }else{
    assignments.push({id:makeId(),assetId:receiver.id,accountId:account.id,assignedAt:now});
  }
  logReceiverEvent(receiver.id,existing?"Moved during audit correction":"Assigned during audit correction",existing?`From Account ${from?.number||"Unknown"} to Account ${account.number}`:`Account ${account.number} · ${account.name}`,"audit",now);
  save(existing?"Audit correction: move receiver":"Audit correction: assign receiver");
  completeAuditIssue(issueId,receiver.id,existing?"Moved to audited account":"Assigned to audited account");
  toast(`Receiver ${moveExisting||existing?"moved":"assigned"} to Account ${account.number}.`);
}

function latestAuditForAccount(accountNumber){
  return auditState?.results?.find(result=>String(result.accountNumber)===String(accountNumber))||null;
}

function reportRows(){
  return accounts
    .map(account=>{
      const receivers=assignedFor(account.id).map(item=>assetById(item.assetId)).filter(Boolean);
      const onRent=receivers.filter(receiver=>receiver.rentState==="On Rent").length;
      const offRent=receivers.length-onRent;
      const audit=latestAuditForAccount(account.number);

      return {
        account,
        assigned:receivers.length,
        onRent,
        offRent,
        available:Math.max(0,20-receivers.length),
        audit:audit ? (audit.perfect ? "Perfect Match" : `${audit.missingFromAudit.length+audit.missingFromApp.length} Issue${audit.missingFromAudit.length+audit.missingFromApp.length===1?"":"s"}`) : "Not Audited"
      };
    })
    .sort((a,b)=>String(a.account.number).localeCompare(String(b.account.number),undefined,{numeric:true}));
}

function assignedOffRentRows(){
  return assignments
    .map(assignment=>({
      receiver:assetById(assignment.assetId),
      account:accountById(assignment.accountId)
    }))
    .filter(item=>item.receiver&&item.account&&item.receiver.rentState==="Off Rent")
    .sort((a,b)=>String(a.account.number).localeCompare(String(b.account.number),undefined,{numeric:true})||a.receiver.assetNumber.localeCompare(b.receiver.assetNumber));
}

function renderReports(){
  const rows=reportRows();
  const offRentRows=assignedOffRentRows();

  $("reportMasterCount").textContent=master.length;
  $("reportAssignedCount").textContent=assignments.length;
  $("reportUnassignedCount").textContent=Math.max(0,master.length-assignments.length);
  $("reportOffRentCount").textContent=offRentRows.length;
  $("reportGeneratedAt").textContent=`Updated ${new Date().toLocaleString()}`;

  $("reportAccountRows").innerHTML=rows.map(row=>`
    <tr>
      <td><strong>${esc(row.account.number)}</strong></td>
      <td>${esc(row.account.name)}</td>
      <td>${esc(row.account.office||row.account.location||"—")}</td>
      <td>${row.assigned}</td>
      <td>${row.onRent}</td>
      <td>${row.offRent}</td>
      <td>${row.available}</td>
      <td><span class="report-status ${row.audit==="Perfect Match"?"good":row.audit==="Not Audited"?"neutral":"warn"}">${esc(row.audit)}</span></td>
    </tr>`).join("");
  $("reportAccountEmpty").hidden=rows.length!==0;

  $("reportOffRentRows").innerHTML=offRentRows.map(item=>`
    <tr>
      <td>${receiverInfoButton(item.receiver)}</td>
      <td>${esc(item.account.number)}</td>
      <td>${esc(item.account.name)}</td>
      <td>${esc(item.receiver.model||"—")}</td>
      <td>${esc(item.receiver.accessCard||"—")}</td>
      <td>${esc(item.receiver.rid||"—")}</td>
    </tr>`).join("");
  $("reportOffRentEmpty").hidden=offRentRows.length!==0;
}

// CSV quoting preserves separators/newlines but does not neutralize spreadsheet
// formulas in untrusted values; formula-safe export is tracked in DATA-05.
function csvCell(value){
  const text=String(value??"");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g,'""')}"` : text;
}

function downloadFile(name,content,type){
  const url=URL.createObjectURL(new Blob([content],{type}));
  const link=document.createElement("a");
  link.href=url;
  link.download=name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),0);
}

function exportAuditCsv(){
  if(!auditState?.results?.length)return;
  const lines=[["Account Number","Account Name","Mismatch Source","Asset Number","Access Card","RID","Research Status","Notes","Updated"]];
  for(const {result,issue,source} of auditIssues()){
    lines.push([
      result.accountNumber,
      result.accountName,
      source==="app"?"In App, Missing from DirecTV Audit":"In DirecTV Audit, Missing from App Account",
      issue.assetNumber||"",
      issue.accessCard||"",
      issue.rid||"",
      auditStatusLabel(issue.status||"needs-research"),
      issue.notes||"",
      issue.updatedAt||""
    ]);
  }
  const date=new Date().toISOString().slice(0,10);
  downloadFile(`tanmar-directv-audit-discrepancies-${date}.csv`,lines.map(row=>row.map(csvCell).join(",")).join("\r\n"),"text/csv;charset=utf-8");
  toast("Audit discrepancy report downloaded.");
}

$("exportAuditButton").addEventListener("click",exportAuditCsv);
$("printAuditButton").addEventListener("click",()=>{
  document.body.classList.add("printing-audit");
  window.print();
});
window.addEventListener("afterprint",()=>document.body.classList.remove("printing-audit"));

function exportReportCsv(){
  const headers=["Account Number","Account Name","Office / Location","Assigned","On Rent","Off Rent","Available Slots","Latest Audit"];
  const lines=[
    headers,
    ...reportRows().map(row=>[
      row.account.number,
      row.account.name,
      row.account.office||row.account.location||"",
      row.assigned,
      row.onRent,
      row.offRent,
      row.available,
      row.audit
    ])
  ];
  const date=new Date().toISOString().slice(0,10);
  downloadFile(`asset-tracker-account-report-${date}.csv`,lines.map(row=>row.map(csvCell).join(",")).join("\r\n"),"text/csv;charset=utf-8");
  toast("Account report downloaded.");
}

$("exportReportCsvButton").addEventListener("click",exportReportCsv);
$("printReportButton").addEventListener("click",()=>window.print());

// This browser export omits rentalStock and both databases' users/logs/history/
// service requests. The UI's complete-backup claim needs correction (DATA-03).
function downloadBackup(){
  const backup={
    app:"TanMar Receiver Control",
    schemaVersion:1,
    exportedAt:new Date().toISOString(),
    data:{master,accounts,assignments,activations,receiverEvents,auditState}
  };
  const date=new Date().toISOString().slice(0,10);
  downloadFile(`asset-tracker-backup-${date}.json`,JSON.stringify(backup,null,2),"application/json");
  toast("Complete backup downloaded.");
}

function validBackupArray(value){
  return Array.isArray(value)&&value.every(item=>item&&typeof item==="object"&&!Array.isArray(item));
}

async function restoreBackup(file){
  try{
    const backup=JSON.parse(await file.text());
    const data=backup?.data;
    if(!["TanMar Receiver Control","Asset Tracker Pro"].includes(backup?.app)||backup?.schemaVersion!==1||!data){
      throw new Error("This is not a supported TanMar Receiver Control backup.");
    }
    if(!validBackupArray(data.master)||!validBackupArray(data.accounts)||!validBackupArray(data.assignments)){
      throw new Error("The backup is missing required app data.");
    }

    const confirmed=confirm(
      `Restore ${data.accounts.length} account${data.accounts.length===1?"":"s"} and ${data.master.length} Master receiver${data.master.length===1?"":"s"}?\n\nThis will replace the Asset Tracker data currently stored in this browser.`
    );
    if(!confirmed)return;

    master=data.master;
    accounts=data.accounts;
    assignments=data.assignments;
    activations=validBackupArray(data.activations)?data.activations:[];
    receiverEvents=validBackupArray(data.receiverEvents)?data.receiverEvents:[];
    auditState=data.auditState&&typeof data.auditState==="object" ? data.auditState : null;
    currentAccountId=null;
    expandedAccountIds.clear();
    save("Restore app backup");
    persistAuditCache(auditState);
    renderDashboard();
    renderAccounts();
    renderMaster();
    renderActivations();
    renderLabels();
    renderAuditResults();
    showView("dashboard");
    toast("Backup restored successfully.");
  }catch(error){
    toast(error.message||"Unable to restore that backup.");
  }finally{
    $("backupFileInput").value="";
  }
}

$("downloadBackupButton").addEventListener("click",downloadBackup);
$("restoreBackupButton").addEventListener("click",()=>{
  $("backupFileInput").value="";
  $("backupFileInput").click();
});
$("backupFileInput").addEventListener("change",event=>{
  const file=event.target.files[0];
  if(file)restoreBackup(file);
});


let pendingDataImport=null;

function normalizeImportKey(value){
  return String(value||"").trim().toLowerCase().replace(/[^a-z0-9]/g,"");
}

function importValue(row,names){
  const normalized={};
  Object.keys(row||{}).forEach(key=>normalized[normalizeImportKey(key)]=row[key]);

  for(const name of names){
    const value=normalized[normalizeImportKey(name)];
    if(value!==undefined && String(value).trim()!=="")return String(value).trim();
  }
  return "";
}

// XLSX is provided by the externally loaded spreadsheet library; replace its
// vulnerable CDN version with a verified local reader under DEP-02.
async function readExcelBook(file){
  if(typeof XLSX==="undefined")throw new Error("Excel reader did not load. Refresh while connected to the internet.");
  return XLSX.read(await file.arrayBuffer(),{type:"array"});
}

function readNamedSheet(book,name){
  const sheetName=book.SheetNames.find(sheet=>normalizeImportKey(sheet)===normalizeImportKey(name));
  if(!sheetName)throw new Error(`Workbook is missing the "${name}" sheet.`);
  return XLSX.utils.sheet_to_json(book.Sheets[sheetName],{defval:"",raw:false});
}

function resetDataImport(){
  pendingDataImport=null;
  $("dataImportChoices").hidden=false;
  $("dataImportPreview").hidden=true;
  $("masterXlsxInput").value="";
  $("wtxXlsxInput").value="";
  $("tqCsvInput").value="";
}

function openDataImport(){
  resetDataImport();
  openModal("dataImportModal");
}

function showDataImportPreview(config){
  pendingDataImport={type:config.type,data:config.data};
  $("dataImportChoices").hidden=true;
  $("dataImportPreview").hidden=false;
  $("dataImportType").textContent=config.type;
  $("dataImportFileName").textContent=config.fileName;
  $("dataRowsRead").textContent=config.rows;
  $("dataNewCount").textContent=config.newCount;
  $("dataUpdateCount").textContent=config.updateCount;
  $("dataWarningCount").textContent=config.warningCount;
  $("dataImportMessage").textContent=config.message;
  $("dataImportPreviewRows").innerHTML=config.preview.slice(0,200).map(item=>`
    <tr>
      <td><strong>${esc(item.record)}</strong></td>
      <td><span class="${item.action==="New"?"import-new":item.action==="Update"?"import-ok":item.action==="Ignored"?"import-ignore":"import-blocked"}">${esc(item.action)}</span></td>
      <td>${esc(item.detail)}</td>
    </tr>`).join("");
  $("applyDataImport").disabled=!config.data.length;
}

function masterImportRecord(row){
  return {
    assetNumber:importValue(row,["Asset Number","Asset","asset","Asset #","Asset ID"]).toUpperCase(),
    accessCard:importValue(row,["Access Card","access_card","Access Card Number","Card Number","Card"]),
    serial:importValue(row,["Serial Number","serial_number","Serial","SN"]),
    rid:importValue(row,["Receiver ID","receiver_id","RID"]),
    type:importValue(row,["Type","Receiver Type"]),
    model:importValue(row,["Model","Receiver Model"])
  };
}

async function prepareMasterImport(file){
  try{
    const rows=readNamedSheet(await readExcelBook(file),"Master");
    const preview=[],data=[];
    let newCount=0,updateCount=0,warningCount=0;

    rows.forEach((row,index)=>{
      const record=masterImportRecord(row);
      if(!record.assetNumber){
        warningCount++;
        preview.push({record:`Row ${index+2}`,action:"Skipped",detail:"Missing Asset Number"});
        return;
      }

      const existing=master.find(receiver=>receiver.assetNumber.toUpperCase()===record.assetNumber);
      if(existing)updateCount++;
      else newCount++;

      preview.push({
        record:record.assetNumber,
        action:existing?"Update":"New",
        detail:record.model||record.type||"Receiver"
      });
      data.push(record);
    });

    showDataImportPreview({
      type:"Master Registry XLSX",
      fileName:file.name,
      rows:rows.length,
      newCount,updateCount,warningCount,
      message:"Updates permanent receiver information only. Account assignments and rent status are preserved.",
      preview,data
    });
  }catch(error){
    toast(error.message||"Unable to read the Master workbook.");
  }
}

function wtxImportRecord(row){
  return {
    accountNumber:importValue(row,["Account Number","account_number","Account #","Acct Number"]),
    accountName:importValue(row,["Account Name","account_name","Customer"]),
    assetNumber:importValue(row,["Asset Number","Asset","asset","Asset #","Asset ID"]).toUpperCase(),
    accessCard:importValue(row,["Access Card","access_card","Access Card Number","Card Number","Card"]),
    serial:importValue(row,["Serial Number","serial_number","Serial","SN"]),
    rid:importValue(row,["Receiver ID","receiver_id","RID"]),
    type:importValue(row,["Type","Receiver Type"]),
    model:importValue(row,["Model","Receiver Model"])
  };
}

function readWestTexasRows(book){
  const n=book.SheetNames.find(x=>normalizeImportKey(x)===normalizeImportKey("West Texas"));
  if(!n)throw new Error('Workbook is missing the "West Texas" sheet.');
  const s=book.Sheets[n],d=XLSX.utils.decode_range(s["!ref"]||"A1:N1");
  return XLSX.utils.sheet_to_json(s,{header:1,defval:"",raw:false,range:{s:{r:0,c:0},e:{r:d.e.r,c:13}}}).slice(1);
}
function cleanExcelValue(v){return String(v??"").trim();}
async function prepareWtxImport(file){
  try{
    const rows=readWestTexasRows(await readExcelBook(file)),preview=[],data=[],seen=new Set();
    let currentNumber="",currentName="",newCount=0,updateCount=0,warningCount=0;
    rows.forEach((c,i)=>{
      const asset=cleanExcelValue(c[1]).toUpperCase(),acct=cleanExcelValue(c[7]),name=cleanExcelValue(c[8]);
      if(acct)currentNumber=acct;if(name)currentName=name;if(!asset)return;
      if(!currentNumber){warningCount++;preview.push({record:asset,action:"Skipped",detail:`Row ${i+2}: no Account Number`});return;}
      if(seen.has(asset)){warningCount++;preview.push({record:asset,action:"Skipped",detail:"Duplicate Asset Number in West Texas sheet"});return;}seen.add(asset);
      const exists=master.find(x=>x.assetNumber.toUpperCase()===asset);exists?updateCount++:newCount++;
      preview.push({record:asset,action:exists?"Update":"New",detail:`Account ${currentNumber}${currentName?` · ${currentName}`:""}`});
      data.push({accountNumber:currentNumber,accountName:currentName||`Account ${currentNumber}`,assetNumber:asset,accessCard:cleanExcelValue(c[2]),serial:cleanExcelValue(c[3]),rid:cleanExcelValue(c[4]),type:cleanExcelValue(c[5]),model:cleanExcelValue(c[6]),office:cleanExcelValue(c[12]),notes:cleanExcelValue(c[13])});
    });
    showDataImportPreview({type:"West Texas XLSX",fileName:file.name,rows:rows.length,newCount,updateCount,warningCount,message:`Detected ${new Set(data.map(x=>x.accountNumber)).size} accounts and ${data.length} assigned receivers. Only columns A:N were read, preventing the workbook formatting from freezing the page.`,preview,data});
  }catch(e){toast(e.message||"Unable to read the West Texas workbook.");}
}

function normalizeRentStatus(value){
  const clean=String(value||"").trim().toLowerCase();

  if(["yes","y","1","true","on rent","onrent","rented"].includes(clean))return "On Rent";
  if(["no","n","0","false","off rent","offrent","not rented"].includes(clean))return "Off Rent";
  return "";
}

function parseCsvMatrix(text){
  const rows=[];
  let row=[];
  let cell="";
  let quoted=false;

  for(let i=0;i<text.length;i++){
    const ch=text[i];
    const next=text[i+1];

    if(ch==='"' && quoted && next==='"'){
      cell+='"';
      i++;
      continue;
    }

    if(ch==='"'){
      quoted=!quoted;
      continue;
    }

    if(ch==="," && !quoted){
      row.push(cell.trim());
      cell="";
      continue;
    }

    if((ch==="\n" || ch==="\r") && !quoted){
      if(ch==="\r" && next==="\n")i++;
      row.push(cell.trim());
      cell="";
      if(row.some(value=>value!==""))rows.push(row);
      row=[];
      continue;
    }

    cell+=ch;
  }

  row.push(cell.trim());
  if(row.some(value=>value!==""))rows.push(row);
  return rows;
}

async function prepareTqImport(file){
  try{
    const matrix=parseCsvMatrix(await file.text());
    const preview=[],data=[];
    let updateCount=0,warningCount=0,ignoredCount=0,rowsRead=0;
    let columnMap=null;
    const seenAssets=new Set();

    matrix.forEach((columns,index)=>{
      const normalizedColumns=columns.map(value=>String(value||"").replace(/\s+/g," ").trim().toLowerCase());
      const assetColumn=normalizedColumns.findIndex(value=>["inventory item id","asset number","asset #"].includes(value));
      const rentColumn=normalizedColumns.findIndex(value=>["on rent","on rent yes/no","rent status","rental status"].includes(value));

      if(assetColumn!==-1&&rentColumn!==-1){
        columnMap={
          asset:assetColumn,
          serial:normalizedColumns.findIndex(value=>value==="serial number"||value==="serial"),
          location:normalizedColumns.findIndex(value=>value==="location"),
          rent:rentColumn
        };
        return;
      }

      if(!columnMap)return;

      const assetNumber=String(columns[columnMap.asset]||"").trim().toUpperCase();
      const serialNumber=columnMap.serial===-1?"":String(columns[columnMap.serial]||"").trim();
      const location=columnMap.location===-1?"":String(columns[columnMap.location]||"").trim();
      const rawRentStatus=String(columns[columnMap.rent]||"").trim();
      const rentState=normalizeRentStatus(rawRentStatus);

      // Each location block in the downloaded TQ report has its own title and
      // header. Ignore those report labels instead of treating them as assets.
      if(!assetNumber||(!rawRentStatus&&columns.filter(Boolean).length<=2))return;
      rowsRead++;

      if(!assetNumber||!rentState){
        warningCount++;
        preview.push({
          record:assetNumber||`Row ${index+1}`,
          action:"Skipped",
          detail:!assetNumber
            ?"Missing Asset Number"
            :"Unrecognized On Rent / Off Rent value"
        });
        return;
      }

      // The company report can repeat a receiver in more than one location
      // block. Apply it once so the preview and update totals remain accurate.
      if(seenAssets.has(assetNumber))return;
      seenAssets.add(assetNumber);

      const receiver=master.find(item=>item.assetNumber.toUpperCase()===assetNumber);

      if(!receiver){
        ignoredCount++;
        preview.push({
          record:assetNumber,
          action:"Ignored",
          detail:"Company-wide receiver not in the local Master Registry"
        });
        return;
      }

      updateCount++;
      preview.push({
        record:assetNumber,
        action:"Update",
        detail:`${rentState}${location?` · ${location}`:""}${serialNumber?` · ${serialNumber}`:""}`
      });
      data.push({id:receiver.id,rentState});
    });

    showDataImportPreview({
      type:"TQ Report CSV",
      fileName:file.name,
      rows:rowsRead,
      newCount:0,
      updateCount,
      warningCount,
      message:`TQ report mapped automatically: Inventory Item ID, Serial Number, Location, and On Rent. ${ignoredCount} company-wide receiver${ignoredCount===1?" was":"s were"} ignored because ${ignoredCount===1?"it is":"they are"} not in the local Master Registry.`,
      preview,
      data
    });
  }catch(error){
    toast(error.message||"Unable to read the TQ CSV.");
  }
}

// Import previews are applied to in-memory collections then saved as one payload.
// Count processed versus actually assigned rows accurately when fixing DATA-05.
function applyDataImport(){
  if(!pendingDataImport)return;
  let processed=0;

  if(pendingDataImport.type==="Master Registry XLSX"){
    pendingDataImport.data.forEach(record=>{
      let receiver=master.find(item=>item.assetNumber.toUpperCase()===record.assetNumber);

      if(receiver){
        receiver.model=record.model||receiver.model;
        receiver.accessCard=record.accessCard||receiver.accessCard;
        receiver.rid=record.rid||receiver.rid;
        receiver.serial=record.serial||receiver.serial;
        receiver.type=record.type||receiver.type;
      }else{
        master.push({
          id:makeId(),
          ...record,
          rentState:"Off Rent",
          offRentSince:new Date().toISOString()
        });
      }
      processed++;
    });
  }

  if(pendingDataImport.type==="West Texas XLSX"){
    pendingDataImport.data.forEach(record=>{
      let account=accounts.find(item=>item.number===record.accountNumber);

      if(!account){
        account={
          id:makeId(),
          number:record.accountNumber,
          name:record.accountName||`Account ${record.accountNumber}`,
          location:"",
          office:""
        };
        accounts.push(account);
      }

      let receiver=master.find(item=>item.assetNumber.toUpperCase()===record.assetNumber);

      if(!receiver){
        receiver={
          id:makeId(),
          assetNumber:record.assetNumber,
          model:record.model,
          accessCard:record.accessCard,
          rid:record.rid,
          serial:record.serial,
          type:record.type,
          rentState:"Off Rent",
          offRentSince:new Date().toISOString()
        };
        master.push(receiver);
      }

      const assignment=assignmentForAsset(receiver.id);

      if(assignment){
        if(assignment.accountId!==account.id && assignedFor(account.id).length<20){
          assignment.accountId=account.id;
        }
      }else if(assignedFor(account.id).length<20){
        assignments.push({
          id:makeId(),
          assetId:receiver.id,
          accountId:account.id,
          assignedAt:new Date().toISOString()
        });
      }

      processed++;
    });
  }

  if(pendingDataImport.type==="TQ Report CSV"){
    pendingDataImport.data.forEach(item=>{
      const receiver=assetById(item.id);
      if(receiver){
        const previousState=receiver.rentState;
        setReceiverRentState(receiver,item.rentState);
        if(previousState!==item.rentState){
          logReceiverEvent(receiver.id,`Marked ${item.rentState}`,"Rent status updated from the TQ report.","rent");
        }
        processed++;
      }
    });
    reconcileRentalStock();
  }

  save(`Apply ${pendingDataImport.type}`);
  closeModal("dataImportModal");
  resetDataImport();
  renderDashboard();
  renderAccounts();
  renderMaster();
  renderRentalStock();
  if(currentAccountId)renderAccountDetail();
  toast(`${processed} record${processed===1?"":"s"} processed.`);
}

$("openMasterImport").onclick=openDataImport;
$("chooseMasterXlsx").onclick=()=>$("masterXlsxInput").click();
$("chooseWtxXlsx").onclick=()=>$("wtxXlsxInput").click();
$("chooseTqCsv").onclick=()=>$("tqCsvInput").click();

$("masterXlsxInput").onchange=event=>{
  const file=event.target.files[0];
  if(file)prepareMasterImport(file);
};

$("wtxXlsxInput").onchange=event=>{
  const file=event.target.files[0];
  if(file)prepareWtxImport(file);
};

$("tqCsvInput").onchange=event=>{
  const file=event.target.files[0];
  if(file)prepareTqImport(file);
};

$("cancelDataImport").onclick=()=>{
  closeModal("dataImportModal");
  resetDataImport();
};

$("backToDataImportChoices").onclick=resetDataImport;
$("applyDataImport").onclick=applyDataImport;


$("clearAllAppData").addEventListener("click",()=>{
  const confirmed=confirm(
    "Clear ALL app data?\n\nThis will remove every account, receiver, assignment, activation request, audit result, and test entry from the shared cloud records. You can restore it with Undo."
  );

  if(!confirmed)return;

  master=[];
  accounts=[];
  assignments=[];
  activations=[];
  receiverEvents=[];
  currentAccountId=null;
  auditState=null;

  save("Clear all app data");
  localStorage.removeItem(AUDIT_KEY);
  resetDataImport();
  closeModal("dataImportModal");
  renderDashboard();
  renderAccounts();
  renderMaster();
  renderActivations();
  selectedLabelIds.clear();
  renderLabels();
  renderAuditResults();
  showView("dashboard");
  toast("All app data cleared. You can now import clean data.");
});

// Establish a persisted starting point so the first user edit can always be
// undone without accidentally discarding initial or restored records.
if(localStorage.getItem(KEYS.master)===null)localStorage.setItem(KEYS.master,JSON.stringify(master));
if(localStorage.getItem(KEYS.accounts)===null)localStorage.setItem(KEYS.accounts,JSON.stringify(accounts));
if(localStorage.getItem(KEYS.assignments)===null)localStorage.setItem(KEYS.assignments,JSON.stringify(assignments));
if(localStorage.getItem(KEYS.activations)===null)localStorage.setItem(KEYS.activations,JSON.stringify(activations));
if(localStorage.getItem(KEYS.receiverHistory)===null)localStorage.setItem(KEYS.receiverHistory,JSON.stringify(receiverEvents));
updateUndoControls();
$("overdueOffRentRows").addEventListener("change",event=>{
  const checkbox=event.target.closest("[data-overdue-select]");
  if(!checkbox)return;
  if(checkbox.checked)selectedOverdueIds.add(checkbox.dataset.overdueSelect);
  else selectedOverdueIds.delete(checkbox.dataset.overdueSelect);
  updateOverdueSelectionControls();
});
$("selectAllOverdue").addEventListener("change",event=>{
  const ids=overdueOffRentRows().map(item=>item.receiver.id);
  ids.forEach(id=>event.target.checked?selectedOverdueIds.add(id):selectedOverdueIds.delete(id));
  renderDashboard();
});
$("generateDeactivationList").addEventListener("click",openDeactivationList);
$("deactivationBatchPicker").addEventListener("change",event=>renderDeactivationBatch(Number(event.target.value)||0));
$("directvRecipientEmail").addEventListener("change",event=>{
  const value=event.target.value.trim();
  if(value)localStorage.setItem(DIRECTV_RECIPIENT_KEY,value);
  else localStorage.removeItem(DIRECTV_RECIPIENT_KEY);
});
$("copyDeactivationList").addEventListener("click",async()=>{
  const text=$("deactivationEmailText").value;
  try{
    await navigator.clipboard.writeText(text);
    toast("Deactivation email copied.");
  }catch{
    $("deactivationEmailText").select();
    document.execCommand("copy");
    toast("Deactivation email copied.");
  }
});
$("openDeactivationEmail").addEventListener("click",()=>{
  const recipient=$("directvRecipientEmail").value.trim();
  if(!recipient||!$("directvRecipientEmail").checkValidity()){
    $("directvRecipientEmail").reportValidity();
    toast("Enter the DirecTV service email address first.");
    return;
  }
  localStorage.setItem(DIRECTV_RECIPIENT_KEY,recipient);
  const batchIndex=Number($("deactivationBatchPicker").value)||0;
  const subject=`Receiver Deactivation Request · Batch ${batchIndex+1} of ${deactivationBatches.length}`;
  location.href=`mailto:${encodeURIComponent(recipient)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent($("deactivationEmailText").value)}`;
});
$("cloudSyncButton").addEventListener("click",async()=>{
  setCloudStatus("connecting");
  try{
    await readCloudState();
    if(cloudQueued)await flushCloudSave();
    else setCloudStatus("synced","Shared records are current across connected devices.");
  }catch{
    setCloudStatus("error","Cloud is unavailable. Existing browser data is safe and sync will retry.");
  }
});
window.addEventListener("online",()=>{if(cloudQueued)flushCloudSave();else readCloudState({quiet:true}).catch(()=>{})});
window.addEventListener("offline",()=>setCloudStatus("error","Internet connection lost. Changes remain on this browser until cloud sync returns."));

function userInitials(name){
  return String(name||"").trim().slice(0,2).toUpperCase()||"--";
}

// Hiding controls is a UI convenience. API authorization must independently
// enforce permissions and must never trust these client restrictions (SEC-03).
function applyUserAccess(user){
  currentUser=user;
  $("profileButton").textContent=userInitials(user.name);
  $("profileButton").title=`${user.name} · ${user.role==="admin"?"Administrator":"Regular User"}`;
  $("profileMenuName").textContent=user.name;
  $("profileMenuRole").textContent=user.role==="admin"?"Administrator":"Regular User";
  document.querySelectorAll("[data-admin-only]").forEach(element=>element.hidden=user.role!=="admin");
  document.body.classList.remove("auth-locked");
  $("authGate").hidden=true;
}

function showAuthGate(needsSetup=false,message=""){
  authNeedsSetup=needsSetup;
  document.body.classList.add("auth-locked");
  $("authGate").hidden=false;
  $("authTitle").textContent=needsSetup?"Create Initial Administrator":"Employee Sign In";
  $("authDescription").textContent=needsSetup
    ?"Create the first administrator username using first initial plus last name, such as jdoe."
    :"Enter your username and PIN to continue.";
  $("authSubmit").textContent=needsSetup?"Create Administrator":"Sign In";
  $("authError").hidden=!message;
  $("authError").textContent=message;
  $("authPin").value="";
}

async function initializeAccess(){
  try{
    const response=await fetch("/api/auth",{cache:"no-store"});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||"Access service unavailable.");
    if(result.user){
      applyUserAccess(result.user);
      await initializeCloudSync();
    }else{
      showAuthGate(Boolean(result.needsSetup));
    }
  }catch(error){
    showAuthGate(false,error.message||"Access service unavailable.");
  }
}

$("authForm").addEventListener("submit",async event=>{
  event.preventDefault();
  $("authSubmit").disabled=true;
  $("authError").hidden=true;
  try{
    const response=await fetch("/api/auth",{
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({
        action:authNeedsSetup?"setup":"login",
        name:$("authName").value.trim(),
        pin:$("authPin").value
      })
    });
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||"Unable to sign in.");
    applyUserAccess(result.user);
    await initializeCloudSync();
  }catch(error){
    showAuthGate(authNeedsSetup,error.message||"Unable to sign in.");
  }finally{
    $("authSubmit").disabled=false;
  }
});

$("profileButton").addEventListener("click",()=>{$("profileMenu").hidden=!$("profileMenu").hidden});
$("signOutButton").addEventListener("click",async()=>{
  await fetch("/api/auth",{method:"DELETE"});
  location.reload();
});

async function loadUsers(){
  if(currentUser?.role!=="admin")return;
  try{
    const response=await fetch("/api/users",{cache:"no-store"});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||"Unable to load users.");
    $("userList").innerHTML=result.users.map(user=>`
      <div class="user-row ${user.active?"":"inactive"}" data-user-id="${esc(user.id)}">
        <label><span>Username</span><input data-user-name maxlength="40" pattern="[A-Za-z][A-Za-z0-9]{1,39}" autocapitalize="none" spellcheck="false" value="${esc(user.name)}">
          ${user.locked_until&&new Date(user.locked_until).getTime()>Date.now()
            ?`<small class="user-status locked">Locked until ${esc(formatHistoryDate(user.locked_until))}</small>`
            :`<small class="user-status ${user.active?"active":""}">${user.active?"Active":"Inactive"} · Last sign-in ${esc(user.last_login_at?formatHistoryDate(user.last_login_at):"Never")}</small>`}
        </label>
        <label><span>Permission</span><select data-user-role><option value="user" ${user.role==="user"?"selected":""}>Regular User</option><option value="admin" ${user.role==="admin"?"selected":""}>Administrator</option></select></label>
        <label><span>New PIN (optional)</span><input data-user-pin type="password" inputmode="numeric" maxlength="8" placeholder="Leave unchanged"></label>
        <div class="user-row-actions">
          <button class="small-button" data-save-user type="button">Save</button>
          ${user.locked_until&&new Date(user.locked_until).getTime()>Date.now()?`<button class="small-button" data-unlock-user type="button">Unlock</button>`:""}
          <button class="small-button ${user.active?"danger":""}" data-toggle-user="${user.active?"off":"on"}" type="button">${user.active?"Deactivate":"Reactivate"}</button>
        </div>
      </div>`).join("");
  }catch(error){toast(error.message||"Unable to load users.")}
}

async function loadActivity(){
  if(currentUser?.role!=="admin")return;
  try{
    const response=await fetch("/api/activity",{cache:"no-store"});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||"Unable to load activity.");
    activityRecords=result.activity||[];
    renderActivity();
  }catch(error){
    $("activityList").innerHTML=`<div class="empty-state"><strong>Activity unavailable</strong><span>${esc(error.message||"Unable to load activity.")}</span></div>`;
    $("activitySummary").textContent="Unable to load activity.";
  }
}

async function loadRecovery(){
  if(currentUser?.role!=="admin")return;
  try{
    const response=await fetch("/api/recovery",{cache:"no-store"});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||"Unable to load recovery points.");
    $("recoveryList").innerHTML=result.snapshots.length?result.snapshots.map(item=>`
      <div class="recovery-row" data-recovery-id="${esc(item.id)}">
        <strong class="recovery-revision">Revision ${esc(item.revision)}</strong>
        <span class="recovery-action">${esc(item.action||"Cloud snapshot")}</span>
        <span class="recovery-meta">${esc(formatHistoryDate(item.created_at))} · ${esc(item.created_by||"Unknown")}</span>
        <button class="small-button" data-restore-recovery type="button">Restore</button>
      </div>`).join(""):`<div class="empty-state"><strong>No recovery points yet</strong><span>A recovery point is created before each new shared-data save.</span></div>`;
  }catch(error){
    $("recoveryList").innerHTML=`<div class="empty-state"><strong>Recovery unavailable</strong><span>${esc(error.message||"Unable to load recovery points.")}</span></div>`;
  }
}

$("refreshRecoveryButton").addEventListener("click",loadRecovery);
$("recoveryList").addEventListener("click",async event=>{
  const button=event.target.closest("[data-restore-recovery]");
  const row=event.target.closest("[data-recovery-id]");
  if(!button||!row)return;
  if(!confirm("Restore this cloud recovery point? The current shared data will be preserved as a new recovery point first."))return;
  button.disabled=true;
  try{
    const response=await fetch("/api/recovery",{
      method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:row.dataset.recoveryId})
    });
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||"Unable to restore recovery point.");
    cloudQueued=false;
    cloudRevision=0;
    await readCloudState();
    await loadRecovery();
    await loadActivity();
    toast("Cloud recovery point restored.");
  }catch(error){toast(error.message||"Unable to restore recovery point.")}
  finally{button.disabled=false;}
});

function activityType(action=""){
  if(action.startsWith("Denied:"))return"denied";
  if(/(?:user|administrator|pin|access)/i.test(action))return"user";
  return"data";
}

function filteredActivity(){
  const query=$("activitySearch").value.trim().toLowerCase();
  const type=$("activityTypeFilter").value;
  const from=$("activityDateFrom").value?new Date(`${$("activityDateFrom").value}T00:00:00`).getTime():null;
  const through=$("activityDateTo").value?new Date(`${$("activityDateTo").value}T23:59:59.999`).getTime():null;
  return activityRecords.filter(item=>{
    const time=new Date(item.created_at).getTime();
    if(query&&!`${item.user_name||""} ${item.action||""}`.toLowerCase().includes(query))return false;
    if(type!=="all"&&activityType(item.action)!==type)return false;
    if(from!==null&&time<from)return false;
    if(through!==null&&time>through)return false;
    return true;
  });
}

function renderActivity(){
  const records=filteredActivity();
  $("activitySummary").textContent=`Showing ${records.length} of ${activityRecords.length} recorded event${activityRecords.length===1?"":"s"}.`;
  $("activityList").innerHTML=records.length?records.map(item=>`
      <div class="activity-row ${activityType(item.action)}">
        <strong class="activity-user">${esc(item.user_name||"Unknown")}</strong>
        <span class="activity-action">${esc(item.action||"Data change")}${item.revision?`<small class="activity-revision">Cloud revision ${esc(item.revision)}</small>`:""}</span>
        <time class="activity-time" datetime="${esc(item.created_at)}">${esc(formatHistoryDate(item.created_at)||item.created_at)}</time>
      </div>`).join(""):`<div class="empty-state"><strong>No matching activity</strong><span>Adjust the search or filters to see other events.</span></div>`;
}

$("refreshActivityButton").addEventListener("click",loadActivity);
["activitySearch","activityTypeFilter","activityDateFrom","activityDateTo"].forEach(id=>$(id).addEventListener("input",renderActivity));
$("exportActivityButton").addEventListener("click",()=>{
  const records=filteredActivity();
  if(!records.length){toast("No matching activity to export.");return;}
  const rows=[["Username","Type","Action","Cloud Revision","Date and Time"],...records.map(item=>[
    item.user_name||"Unknown",activityType(item.action),item.action||"Data change",item.revision||"",new Date(item.created_at).toLocaleString()
  ])];
  const date=new Date().toISOString().slice(0,10);
  downloadFile(`tanmar-activity-log-${date}.csv`,rows.map(row=>row.map(csvCell).join(",")).join("\r\n"),"text/csv;charset=utf-8");
  toast(`Exported ${records.length} activity record${records.length===1?"":"s"}.`);
});

$("userCreateForm").addEventListener("submit",async event=>{
  event.preventDefault();
  try{
    const response=await fetch("/api/users",{
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({name:$("newUserName").value.trim(),pin:$("newUserPin").value,role:$("newUserRole").value})
    });
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||"Unable to add user.");
    event.target.reset();
    await loadUsers();
    await loadActivity();
    toast("Authorized user added.");
  }catch(error){toast(error.message||"Unable to add user.")}
});

$("userList").addEventListener("click",async event=>{
  const row=event.target.closest("[data-user-id]");
  if(!row)return;
  const saveButton=event.target.closest("[data-save-user]");
  const toggleButton=event.target.closest("[data-toggle-user]");
  const unlockButton=event.target.closest("[data-unlock-user]");
  if(!saveButton&&!toggleButton&&!unlockButton)return;
  try{
    const response=await fetch("/api/users",{
      method:"PATCH",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({
        id:row.dataset.userId,
        name:row.querySelector("[data-user-name]").value.trim(),
        role:row.querySelector("[data-user-role]").value,
        pin:row.querySelector("[data-user-pin]").value,
        unlock:Boolean(unlockButton),
        active:toggleButton?toggleButton.dataset.toggleUser==="on":!row.classList.contains("inactive")
      })
    });
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||"Unable to update user.");
    await loadUsers();
    await loadActivity();
    toast(unlockButton?"User account unlocked.":toggleButton?"User access updated.":"User record saved.");
  }catch(error){toast(error.message||"Unable to update user.")}
});

initializeAccess();
