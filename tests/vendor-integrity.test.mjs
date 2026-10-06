import assert from "node:assert/strict";
import {cp,mkdir,mkdtemp,readFile,rm,symlink,writeFile} from "node:fs/promises";
import {spawn} from "node:child_process";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";
import {ESLint} from "eslint";
import {vendorFiles,verifyVendors} from "../scripts/vendor-integrity.mjs";

const root=fileURLToPath(new URL("../",import.meta.url));
// Exercise the fail-closed allowlist with disposable public-file copies. Tests
// never edit the real vendor bytes or rely on an outside CDN/security service.
async function fixture(t){
  const directory=await mkdtemp(path.join(os.tmpdir(),"assettracker-vendor-test-"));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  await mkdir(path.join(directory,"public/asset-tracker"),{recursive:true});
  await cp(path.join(root,"public/asset-tracker/vendor"),path.join(directory,"public/asset-tracker/vendor"),{recursive:true});
  await cp(path.join(root,"public/asset-tracker/index.html"),path.join(directory,"public/asset-tracker/index.html"));
  return directory;
}

test("reviewed local vendor scripts and distribution licenses match pins and page SRI",async()=>{
  assert.deepEqual(await verifyVendors(),{scripts:3,licenses:3});
});
test("changed vendor bytes cannot silently enter the lint exclusion",async t=>{
  const directory=await fixture(t),file=path.join(directory,"public/asset-tracker/vendor/qrcode.js");
  await writeFile(file,(await readFile(file))+"\n// Unexpected edit\n");
  await assert.rejects(verifyVendors(directory),/Vendor checksum mismatch: qrcode.js/);
});
test("missing or replaced license files fail verification",async t=>{
  const directory=await fixture(t),file=path.join(directory,"public/asset-tracker/vendor/jsbarcode-LICENSE.txt");
  await writeFile(file,"Unreviewed distribution notice");
  await assert.rejects(verifyVendors(directory),/Vendor checksum mismatch/);
  await rm(file);await assert.rejects(verifyVendors(directory),{code:"ENOENT"});
});
test("symlinked vendor bytes fail rather than following a different file",async t=>{
  const directory=await fixture(t),file=path.join(directory,"public/asset-tracker/vendor/qrcode.js");
  await rm(file);await symlink(path.join(root,"public/asset-tracker/vendor/qrcode.js"),file);
  await assert.rejects(verifyVendors(directory),/Vendor must be a regular file/);
});
test("missing, changed or duplicate script/SRI tags fail verification",async t=>{
  const directory=await fixture(t),file=path.join(directory,"public/asset-tracker/index.html"),html=await readFile(file,"utf8");
  const tag=html.match(/<script src="vendor\/jsbarcode\.min\.js"[^>]*><\/script>/)[0];
  for(const changed of [html.replace(tag,""),html.replace(tag,tag.replace('integrity="sha384-', 'integrity="bad-')),html.replace(tag,tag+tag)]){
    await writeFile(file,changed);await assert.rejects(verifyVendors(directory),/Vendor script\/SRI mismatch/);
  }
});
test("lint exclusions cover only reviewed assets; first-party files retain warning rules",async()=>{
  const staff=new ESLint({cwd:root});
  for(const file of vendorFiles.filter(file=>file.script))assert.equal(await staff.isPathIgnored(`public/asset-tracker/vendor/${file.name}`),true);
  for(const file of ["public/asset-tracker/app.js","public/asset-tracker/spreadsheet-worker.js","public/asset-tracker/vendor/new-application.js","scripts/verify-vendors.mjs","lib/service-operations.ts"])
    assert.equal(await staff.isPathIgnored(file),false,file);
  const findings=await staff.lintText("const lintRegression = 1;",{filePath:"public/asset-tracker/vendor/new-application.js"});
  assert.ok(findings[0].messages.some(item=>item.ruleId==="@typescript-eslint/no-unused-vars"));
  const qr=new ESLint({cwd:path.join(root,"service-request")});
  assert.equal(await qr.isPathIgnored("app/page.tsx"),false);
});

// Invoke the ACTUAL npm scripts with synthetic stdin. Future warning-only code
// must fail the same gate contributors run, even if a rule's severity stays warn.
async function lintWarning(directory,file,source){
  const child=spawn("npm",["run","lint","--","--stdin","--stdin-filename",file],{cwd:directory,stdio:["pipe","pipe","pipe"]});
  let output="";child.stdout.on("data",chunk=>{output+=chunk;});child.stderr.on("data",chunk=>{output+=chunk;});
  child.stdin.on("error",()=>{});child.stdin.end(source);
  const timer=setTimeout(()=>child.kill("SIGKILL"),20000);
  try{return await new Promise((resolve,reject)=>{child.on("error",reject);child.on("exit",(code,signal)=>resolve({code,signal,output}));});}
  finally{clearTimeout(timer);}
}
test("both npm lint commands reject newly introduced warnings",async()=>{
  const staff=await lintWarning(root,"public/asset-tracker/vendor/application-regression.js","const lintRegression = 1;");
  assert.equal(staff.signal,null);assert.equal(staff.code,1);assert.match(staff.output,/no-unused-vars/);assert.match(staff.output,/too many warnings/);
  const qr=await lintWarning(path.join(root,"service-request"),"app/lint-regression.tsx",'export default function Example(){ return <img src="/synthetic.png" alt="Synthetic"/>; }');
  assert.equal(qr.signal,null);assert.equal(qr.code,1);assert.match(qr.output,/no-img-element/);assert.match(qr.output,/too many warnings/);
});
