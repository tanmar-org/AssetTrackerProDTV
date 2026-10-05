const TEST_RECIPIENT="earrieta@tanmarcompanies.com";
const params=new URLSearchParams(location.search);
const data={
  asset:params.get("a")||"",
  model:params.get("m")||"",
  type:params.get("t")||"",
  serial:params.get("s")||"",
  rid:params.get("r")||"",
  card:params.get("c")||"",
  rentState:params.get("rs")||"",
  accountNumber:params.get("an")||"",
  accountName:params.get("ac")||"",
  recordedLocation:params.get("al")||"",
  office:params.get("ao")||""
};
let gps=null;

const byId=id=>document.getElementById(id);
const clean=value=>value||"—";
const details=[
  ["Model",data.model],
  ["Receiver Type",data.type],
  ["Serial Number",data.serial],
  ["Receiver ID (RID)",data.rid],
  ["Access Card",data.card],
  ["Rent Status",data.rentState],
  ["Current Account",data.accountNumber],
  ["Account Name",data.accountName],
  ["Recorded Location",data.recordedLocation],
  ["Office / Yard",data.office]
];

byId("assetNumber").textContent=clean(data.asset);
byId("receiverDetails").innerHTML=details
  .filter(([,value])=>value)
  .map(([label,value])=>`<dt>${label}</dt><dd>${clean(value)}</dd>`)
  .join("");

function setLocationState(kind,title,message){
  const panel=document.querySelector(".location-panel");
  panel.classList.remove("ready","error");
  if(kind)panel.classList.add(kind);
  byId("locationTitle").textContent=title;
  byId("locationMessage").textContent=message;
}

function updateReadyState(){
  byId("emailButton").disabled=!(gps&&byId("errorCode").value.trim());
}

function requestLocation(){
  byId("formError").hidden=true;
  if(!navigator.geolocation){
    gps=null;
    setLocationState("error","Location required","GPS location is not available on this device.");
    updateReadyState();
    return;
  }
  byId("locationButton").disabled=true;
  setLocationState("","Requesting location…","Approve the location prompt on your device.");
  navigator.geolocation.getCurrentPosition(position=>{
    gps={
      latitude:position.coords.latitude,
      longitude:position.coords.longitude,
      accuracy:position.coords.accuracy,
      capturedAt:new Date().toISOString()
    };
    setLocationState("ready","GPS location captured",`${gps.latitude.toFixed(6)}, ${gps.longitude.toFixed(6)} · accuracy ${Math.round(gps.accuracy)} m`);
    byId("locationButton").textContent="Refresh GPS Location";
    byId("locationButton").disabled=false;
    updateReadyState();
  },()=>{
    gps=null;
    setLocationState("error","Location required","Location permission must be allowed before this request can be created.");
    byId("locationButton").textContent="Try Location Again";
    byId("locationButton").disabled=false;
    updateReadyState();
  },{enableHighAccuracy:true,timeout:15000,maximumAge:0});
}

function createEmail(){
  const errorCode=byId("errorCode").value.trim();
  if(!errorCode){
    byId("formError").textContent="Enter the on-screen error code.";
    byId("formError").hidden=false;
    byId("errorCode").focus();
    return;
  }
  if(!gps){
    byId("formError").textContent="Location required. Share your GPS location before creating the email.";
    byId("formError").hidden=false;
    requestLocation();
    return;
  }
  byId("formError").hidden=true;
  const mapsLink=`https://maps.google.com/?q=${gps.latitude},${gps.longitude}`;
  const lines=[
    "Please reactivate or refresh this receiver.",
    "",
    `On-Screen Error Code: ${errorCode}`,
    "",
    "RECEIVER INFORMATION",
    `Asset Number: ${clean(data.asset)}`,
    `Model: ${clean(data.model)}`,
    `Receiver Type: ${clean(data.type)}`,
    `Serial Number: ${clean(data.serial)}`,
    `Receiver ID (RID): ${clean(data.rid)}`,
    `Access Card: ${clean(data.card)}`,
    `Rent Status: ${clean(data.rentState)}`,
    `Current Account: ${clean(data.accountNumber)}`,
    `Account Name: ${clean(data.accountName)}`,
    `Recorded Location: ${clean(data.recordedLocation)}`,
    `Office / Yard: ${clean(data.office)}`,
    "",
    "SCAN LOCATION",
    `GPS Coordinates: ${gps.latitude.toFixed(6)}, ${gps.longitude.toFixed(6)}`,
    `GPS Accuracy: ${Math.round(gps.accuracy)} meters`,
    `Map: ${mapsLink}`,
    `Captured: ${new Date(gps.capturedAt).toLocaleString()}`
  ];
  const subject=`${clean(data.asset)} / Service Request`;
  location.href=`mailto:${TEST_RECIPIENT}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join("\n"))}`;
}

byId("errorCode").addEventListener("input",()=>{
  byId("formError").hidden=true;
  updateReadyState();
});
byId("locationButton").addEventListener("click",requestLocation);
byId("emailButton").addEventListener("click",createEmail);
requestLocation();
