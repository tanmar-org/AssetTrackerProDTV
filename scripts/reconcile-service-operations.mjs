import {createDatabase} from "@tanmar/database";
import {setTimeout as delay} from "node:timers/promises";
import {reconcileServiceOperations} from "../lib/service-operations.ts";
import {serviceEndpoint} from "../lib/service-remote.ts";

// Run under the tracker runtime role using its private environment, never a
// migration owner. --watch is a supervised VM process, not an outside service.
const watch=process.argv.slice(2).length===1&&process.argv[2]==="--watch";
let store,stopping=false;
const stop=()=>{stopping=true;};process.on("SIGTERM",stop);process.on("SIGINT",stop);
try{
  if(process.argv.length>2&&!watch)throw new Error("Invalid reconciliation options.");
  serviceEndpoint();store=createDatabase(process.env.DATABASE_URL);
  do{
    try{
      const result=await reconcileServiceOperations(store,10,()=>stopping);
      process.stdout.write(JSON.stringify(result)+"\n");
    }catch{
      // Do not expose driver diagnostics, contacts, snapshots or credentials.
      process.stderr.write("Service reconciliation failed. Check database/service access privately.\n");
      if(!watch){process.exitCode=1;break;}
    }
    // Short increments honor shutdown promptly, without interrupting a transaction
    // that may already hold a QR receipt and be committing corresponding history.
    if(watch)for(let i=0;i<15&&!stopping;i++)await delay(1000);
  }while(watch&&!stopping);
}catch{
  process.stderr.write("Service reconciliation could not start. Check private runtime configuration and options.\n");process.exitCode=1;
}finally{
  await store?.close();process.off("SIGTERM",stop);process.off("SIGINT",stop);
}
