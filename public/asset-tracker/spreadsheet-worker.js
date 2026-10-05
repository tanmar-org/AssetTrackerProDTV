// A browser Web Worker, served by this app, isolates untrusted parsing from the
// staff page. No Cloudflare Worker, external service, or runtime CDN is involved.
importScripts("vendor/xlsx-0.20.3.full.min.js");

const MAX_FILE_BYTES=10*1024*1024;
const MAX_EXPANDED_BYTES=64*1024*1024;
const MAX_ENTRY_BYTES=32*1024*1024;
const MAX_ROWS=20001; // Includes headings/report preamble; never silently truncate.
const MAX_COLUMNS=256;
const MAX_CELLS=200000;
const MAX_TEXT=8192;

// XLSX is ZIP-based. Bound declared expansion and inspect actual deflate output
// before SheetJS allocates worksheets. Metadata alone cannot stop a lying archive.
async function checkZip(buffer){
  const view=new DataView(buffer),bytes=new Uint8Array(buffer);
  if(view.byteLength<4||view.getUint32(0,true)!==0x04034b50)return;
  let end=-1;
  for(let i=view.byteLength-22;i>=Math.max(0,view.byteLength-65557);i--){
    if(view.getUint32(i,true)===0x06054b50&&i+22+view.getUint16(i+20,true)===view.byteLength){end=i;break;}
  }
  if(end<0)throw new Error("The spreadsheet archive is incomplete.");
  const count=view.getUint16(end+10,true),size=view.getUint32(end+12,true),start=view.getUint32(end+16,true);
  if(view.getUint16(end+4,true)||view.getUint16(end+6,true)||count!==view.getUint16(end+8,true)||
      count>2048||start+size>end)throw new Error("Split, ZIP64, or oversized spreadsheet archives are not supported.");
  let offset=start,total=0;
  const entries=[];
  for(let i=0;i<count;i++){
    if(offset+46>start+size||view.getUint32(offset,true)!==0x02014b50)throw new Error("The spreadsheet archive is invalid.");
    const flags=view.getUint16(offset+8,true),method=view.getUint16(offset+10,true);
    const compressed=view.getUint32(offset+20,true),expanded=view.getUint32(offset+24,true);
    const nameSize=view.getUint16(offset+28,true),extraSize=view.getUint16(offset+30,true),commentSize=view.getUint16(offset+32,true);
    const local=view.getUint32(offset+42,true);
    if(flags&1||![0,8].includes(method)||view.getUint16(offset+34,true)||compressed===0xffffffff||expanded>MAX_ENTRY_BYTES||
        (total+=expanded)>MAX_EXPANDED_BYTES||local+30>start||view.getUint32(local,true)!==0x04034b50)
      throw new Error("Encrypted, unsupported, or oversized spreadsheet archives are not supported.");
    const dataStart=local+30+view.getUint16(local+26,true)+view.getUint16(local+28,true);
    if(dataStart+compressed>start||view.getUint16(local+8,true)!==method||view.getUint16(local+6,true)&1)
      throw new Error("The spreadsheet archive is invalid.");
    entries.push({start:dataStart,end:dataStart+compressed,expanded,method});
    offset+=46+nameSize+extraSize+commentSize;
  }
  if(offset!==start+size)throw new Error("The spreadsheet archive is invalid.");
  const ordered=[...entries].sort((a,b)=>a.start-b.start);
  if(ordered.some((entry,index)=>index&&entry.start<ordered[index-1].end))throw new Error("Overlapping spreadsheet archive entries are not supported.");
  let actualTotal=0;
  for(const entry of entries){
    if(entry.method===0){
      if(entry.end-entry.start!==entry.expanded)throw new Error("The spreadsheet archive is invalid.");
      actualTotal+=entry.expanded;
      continue;
    }
    if(typeof DecompressionStream==="undefined")throw new Error("Update your browser to import compressed spreadsheets.");
    const stream=new Blob([bytes.subarray(entry.start,entry.end)]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    const reader=stream.getReader();
    let actual=0;
    try{
      while(true){
        const chunk=await reader.read();
        if(chunk.done)break;
        actual+=chunk.value.byteLength;actualTotal+=chunk.value.byteLength;
        if(actual>MAX_ENTRY_BYTES||actualTotal>MAX_EXPANDED_BYTES||actual>entry.expanded){
          await reader.cancel();throw new Error("The expanded spreadsheet exceeds the import limits.");
        }
      }
    }finally{reader.releaseLock();}
    if(actual!==entry.expanded)throw new Error("The spreadsheet archive is invalid.");
  }
}

function checkBook(book){
  if(!book.SheetNames.length||book.SheetNames.length>32)throw new Error("Choose a workbook with 1–32 worksheets.");
  let cells=0,hasData=false;
  for(const name of book.SheetNames){
    const sheet=book.Sheets[name];
    if(!sheet?.["!ref"])continue;
    const range=XLSX.utils.decode_range(sheet["!fullref"]||sheet["!ref"]);
    if(range.e.r>=MAX_ROWS||range.e.c>=MAX_COLUMNS)throw new Error("The workbook exceeds 20,001 rows or 256 columns per worksheet.");
    for(const [address,cell] of Object.entries(sheet)){
      if(address.startsWith("!"))continue;
      hasData=true;
      if(++cells>MAX_CELLS)throw new Error("The workbook exceeds 200,000 populated cells.");
      if([cell.v,cell.w].some(value=>typeof value==="string"&&value.length>MAX_TEXT))throw new Error("A spreadsheet cell exceeds 8,192 characters.");
      // Imported values are text/numbers, not links, formula source, or rich HTML.
      delete cell.l;delete cell.h;delete cell.f;
    }
  }
  if(!hasData)throw new Error("The workbook does not contain any worksheet data.");
  return {SheetNames:book.SheetNames,Sheets:book.Sheets};
}

self.onmessage=async event=>{
  try{
    const {buffer,extension}=event.data;
    if(!(buffer instanceof ArrayBuffer)||!buffer.byteLength||buffer.byteLength>MAX_FILE_BYTES||!["xlsx","xls","csv"].includes(extension))
      throw new Error("Choose an XLSX, XLS, or CSV file up to 10 MiB.");
    if(extension==="xlsx"&&(buffer.byteLength<4||new DataView(buffer).getUint32(0,true)!==0x04034b50))
      throw new Error("The XLSX file is not a valid spreadsheet archive.");
    await checkZip(buffer);
    const book=XLSX.read(buffer,{type:"array",raw:true,sheetRows:MAX_ROWS+1,
      cellFormula:false,cellHTML:false,cellStyles:false,bookVBA:false});
    self.postMessage({book:checkBook(book)});
  }catch(error){
    // No cell contents/file names are copied into errors. Parser internals are
    // intentionally hidden; known limit messages give the user a useful remedy.
    const message=error instanceof Error&&/^(Choose |The (spreadsheet|expanded|workbook|XLSX)|Split, |Encrypted, |Overlapping |Update your browser|A spreadsheet)/.test(error.message)
      ?error.message:"Unable to read this spreadsheet. Export a fresh XLSX, XLS, or CSV file and try again.";
    self.postMessage({error:message});
  }
};
