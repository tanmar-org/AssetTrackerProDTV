import { when } from "./inventory-fixture.mjs";

// Private synthetic request metadata for protocol and HTTP recovery tests.
export const snapshot=()=>({id:"request-1",assetId:"receiver-0",assetNumber:"TEST-0",action:"Reactivate / Refresh",status:"Completed",notes:"Synthetic notes",
  requestedAt:when,completedAt:when,version:2,accountNumber:"000001",accountName:"Synthetic Account",errorCode:"771",
  operatorName:"Test Operator",requesterName:"Synthetic Requester",requesterPhone:"555-0100",rigFrac:"Test Rig",lease:"Test Lease",
  mapUrl:"https://maps.google.com/?q=31.9,-102.2",gpsAccuracy:0});
