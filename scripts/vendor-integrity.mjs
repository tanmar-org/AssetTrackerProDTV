import {createHash} from "node:crypto";
import {lstat,readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

const repository=fileURLToPath(new URL("../",import.meta.url));
// This is a reviewable byte allowlist, not a signature or security advisory scan.
// Updating any pin requires upstream/license review and label/import regressions.
export const vendorFiles=Object.freeze([
  {name:"qrcode.js",sha256:"18ae399f81182bc9de916e9c77b195df20cc58d6f2d55a62b085a299f1bf1780",script:true},
  {name:"jsbarcode.min.js",sha256:"52e032534c3f98976ad95cb8c20baf80ed0cc83d42590602a8cf1db16e2e22ed",script:true},
  {name:"xlsx-0.20.3.full.min.js",sha256:"cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41",script:true},
  {name:"qrcode-LICENSE.txt",sha256:"3a850fa5f08101db6f40676c2786e10bd2cd5fff7b12ffdf1e0c434d4e49d90c"},
  {name:"jsbarcode-LICENSE.txt",sha256:"e34674e4ef4ed987f7a21a3040a1bdce83f08cc07eedfacbba1ffe53b0633734"},
  {name:"sheetjs-LICENSE.txt",sha256:"4d2a38ac35cda06a555c84074a819d413339cd3691b822cae50f8f322fe01f64"},
]);

export async function verifyVendors(root=repository){
  const directory=path.join(root,"public/asset-tracker");
  const html=await readFile(path.join(directory,"index.html"),"utf8");
  const scripts=html.match(/<script\b[^>]*>/g)||[];
  for(const vendor of vendorFiles){
    const file=path.join(directory,"vendor",vendor.name);
    // Refuse links/missing or edited artifacts before lint can exclude them.
    if(!(await lstat(file)).isFile())throw new Error(`Vendor must be a regular file: ${vendor.name}`);
    const bytes=await readFile(file);
    if(createHash("sha256").update(bytes).digest("hex")!==vendor.sha256)
      throw new Error(`Vendor checksum mismatch: ${vendor.name}`);
    if(vendor.script){
      const matches=scripts.filter(tag=>tag.includes(`src="vendor/${vendor.name}"`));
      const sri=`integrity="sha384-${createHash("sha384").update(bytes).digest("base64")}"`;
      if(matches.length!==1||!matches[0].includes(sri))throw new Error(`Vendor script/SRI mismatch: ${vendor.name}`);
    }
  }
  return {scripts:vendorFiles.filter(file=>file.script).length,licenses:vendorFiles.filter(file=>!file.script).length};
}
