import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { Worker } from "node:worker_threads";
import ts from "typescript";

const vendor = await readFile(new URL("../public/asset-tracker/vendor/xlsx-0.20.3.full.min.js", import.meta.url));
const library = vm.createContext({}); vm.runInContext(vendor.toString(), library);
const XLSX = library.XLSX;
const source = await readFile(new URL("../public/asset-tracker/app.js", import.meta.url), "utf8");
const parsed = ts.createSourceFile("app.js", source, ts.ScriptTarget.Latest, true);
function functions(names) {
  return parsed.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text))
    .map((node) => node.getText(parsed)).join("\n");
}
function workbook(rows, sheet = "Master") {
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), sheet); return book;
}
function bytes(book, bookType = "xlsx") { return new Uint8Array(XLSX.write(book, { type: "array", bookType, compression: true })); }
async function parse(bytes, extension = "xlsx") {
  const worker = new Worker(new URL("./helpers/spreadsheet-worker.mjs", import.meta.url));
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Synthetic spreadsheet worker timed out.")), 10000);
      worker.once("error", (error) => { clearTimeout(timer); reject(error); });
      worker.once("message", (result) => { clearTimeout(timer); if (result.error) reject(new Error(result.error)); else resolve(result.book); });
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      worker.postMessage({ buffer, extension }, [buffer]);
    });
  } finally { await worker.terminate(); }
}

// Hash pin covers the exact upstream bytes and SRI in the page, not just a label.
test("the local full SheetJS reader matches the pinned release bytes and page SRI", async () => {
  assert.equal(XLSX.version, "0.20.3");
  assert.equal(createHash("sha256").update(vendor).digest("hex"), "cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41");
  const html = await readFile(new URL("../public/asset-tracker/index.html", import.meta.url), "utf8");
  assert.match(html, /src="vendor\/xlsx-0.20.3.full.min.js"/);
  assert.ok(html.includes(`integrity="sha384-${createHash("sha384").update(vendor).digest("base64")}"`));
  assert.equal(/<script[^>]+src="https?:/.test(html), false, "Staff scripts must not require an external CDN.");
});

test("bounded XLSX and XLS imports preserve text identifiers and formatted numeric leading zeros", async () => {
  const book = workbook([["Asset Number", "Access Card", "Receiver ID", "Serial Number"], ["TEST-001", "000001", 2, "000003"]]);
  book.Sheets.Master.C2.z = "000000";
  for (const [format, extension] of [["xlsx", "xlsx"], ["biff8", "xls"]]) {
    const parsed = await parse(bytes(book, format), extension);
    const rows = XLSX.utils.sheet_to_json(parsed.Sheets.Master, { raw: false });
    assert.equal(rows[0]["Asset Number"], "TEST-001");
    assert.equal(rows[0]["Access Card"], "000001");
    assert.equal(rows[0]["Receiver ID"], "000002");
    assert.equal(rows[0]["Serial Number"], "000003");
  }
});

test("CSV audit and Excel account mapping retain leading-zero aliases", async () => {
  const context = vm.createContext({ XLSX, readExcelBook: (file) => parse(file.bytes, file.extension) });
  vm.runInContext(functions(["normalizeImportKey", "normalizeCsvHeader", "csvValue", "readAuditImportRows", "accountImportRecord"]), context);
  const rows = await context.readAuditImportRows({ name: "synthetic.csv", bytes: new TextEncoder().encode('Account Number,Access Card,Receiver RID Num\r\n000004,000001,000002\r\n'), extension: "csv" });
  assert.equal(rows[0].accountnumber, "000004"); assert.equal(rows[0].accesscard, "000001"); assert.equal(rows[0].receiverridnum, "000002");
  const excel = await parse(bytes(workbook([["Asset #", "Access Card", "RID"], ["TEST-001", "000001", "000002"]])));
  context.readExcelBook = async () => excel;
  vm.runInContext(functions(["readAccountImportRows"]), context);
  const accounts = await context.readAccountImportRows({ name: "synthetic.xlsx" });
  const record = context.accountImportRecord(accounts[0]);
  assert.equal(record.assetNumber, "TEST-001"); assert.equal(record.accessCard, "000001"); assert.equal(record.rid, "000002");
});

test("Master, West Texas and preamble audit mapping use the upgraded reader", async () => {
  const west = Array(14).fill(""); west[1] = "TEST-001"; west[2] = "000001"; west[4] = "000002"; west[7] = "000004";
  const book = workbook([["Asset Number", "Access Card"], ["TEST-001", "000001"]]);
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([Array(14).fill("Heading"), west]), "West Texas");
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["Synthetic report"], [], ["Account Number", "Access Card", "RID"], ["000004", "000001", "000002"]]), "Receiver Report");
  const parsedBook = await parse(bytes(book));
  const context = vm.createContext({ XLSX, readExcelBook: async () => parsedBook });
  vm.runInContext(functions(["normalizeImportKey", "normalizeCsvHeader", "readNamedSheet", "readWestTexasRows", "readAuditImportRows"]), context);
  assert.equal(context.readNamedSheet(parsedBook, "Master")[0]["Access Card"], "000001");
  assert.equal(context.readWestTexasRows(parsedBook)[0][7], "000004");
  const audit = await context.readAuditImportRows({ name: "synthetic.xlsx" });
  assert.equal(audit[0].accountnumber, "000004"); assert.equal(audit[0].rid, "000002");
});

test("spreadsheet formulas, HTML and hyperlinks are not returned as active content", async () => {
  const book = workbook([["Formula", "Link"], [2, "<img src=x onerror=alert(1)>"]]);
  book.Sheets.Master.A2.f = "1+1"; book.Sheets.Master.B2.l = { Target: "javascript:alert(1)" };
  const parsed = await parse(bytes(book));
  assert.equal(parsed.Sheets.Master.A2.v, 2); assert.equal(parsed.Sheets.Master.A2.f, undefined);
  assert.equal(parsed.Sheets.Master.B2.l, undefined); assert.equal(parsed.Sheets.Master.B2.h, undefined);
  assert.equal(parsed.Sheets.Master.B2.v, "<img src=x onerror=alert(1)>");
});

test("malformed, oversized, excessive-dimension and excessive-cell files are rejected", async () => {
  for (const input of [new Uint8Array(), new Uint8Array(10 * 1024 * 1024 + 1), new TextEncoder().encode("not an XLSX")])
    await assert.rejects(parse(input));
  const badZip = bytes(workbook([["test"]])); badZip[badZip.length - 22] = 0;
  await assert.rejects(parse(badZip), /archive/);
  const tooWide = workbook([["test"]]); tooWide.Sheets.Master["!ref"] = "A1:IW1";
  await assert.rejects(parse(bytes(tooWide)), /columns/);
  const tooTall = workbook([["test"]]); tooTall.Sheets.Master["!ref"] = "A1:A20002";
  await assert.rejects(parse(bytes(tooTall)), /rows/);
  await assert.rejects(parse(bytes(workbook([["x".repeat(8193)]]))), /characters/);
  const tooMany = workbook(Array.from({ length: 1001 }, () => Array(200).fill("x")));
  await assert.rejects(parse(bytes(tooMany)), /200,000/);
});

test("ZIP preflight rejects oversized declarations and compressed expansion that lies about its size", async () => {
  const valid = bytes(workbook([["a".repeat(8192)]]));
  const central = valid.findIndex((_, i) => i + 4 <= valid.length && new DataView(valid.buffer).getUint32(i, true) === 0x02014b50);
  assert.ok(central > 0);
  const declared = valid.slice(); new DataView(declared.buffer).setUint32(central + 24, 32 * 1024 * 1024 + 1, true);
  await assert.rejects(parse(declared), /oversized/);
  const lying = valid.slice(); new DataView(lying.buffer).setUint32(central + 24, 1, true);
  await assert.rejects(parse(lying), /expanded spreadsheet/);
});

test("CSV parsing preserves quoted text and rejects growth while scanning", () => {
  const context = vm.createContext({});
  vm.runInContext(functions(["checkCsvMatrix", "parseCsvMatrix", "parseCsvText", "normalizeCsvHeader"]), context);
  const records = context.parseCsvText('Asset Number,Serial\r\nTEST-01,"000001"\r\nTEST-02,"quoted, with ""quotes"""');
  assert.equal(records[0].serial, "000001"); assert.equal(records[1].serial, 'quoted, with "quotes"');
  const atLimit = Array(1000).fill(Array(200).fill("a").join(",")).join("\n") + "\n";
  assert.equal(context.parseCsvMatrix(atLimit).length, 1000, "A trailing newline must not add a phantom cell beyond the exact limit.");
  for (const input of ['a\n"unfinished', "a".repeat(8193), Array(257).fill("a").join(","), "a\n".repeat(20002)])
    assert.throws(() => context.parseCsvMatrix(input));
});

test("UI rejects oversized files before reading and terminates its parser on success, failure and timeout", async () => {
  let reads = 0, timeout;
  class Parser {
    static instances = [];
    constructor() { Parser.instances.push(this); this.stopped = false; }
    postMessage() {}
    terminate() { this.stopped = true; }
  }
  const context = vm.createContext({ sessionEpoch: 0, sessionActive: () => true, importCancellations: new Set(), XLSX, Worker: Parser, URL, document: { baseURI: "https://staff.example.invalid/asset-tracker/" },
    setTimeout: (callback) => { timeout = callback; return 1; }, clearTimeout() {} });
  vm.runInContext(functions(["checkImportFile", "readExcelBook"]), context);
  const file = { name: "synthetic.xlsx", size: 10, arrayBuffer: async () => { reads++; return new ArrayBuffer(10); } };
  await assert.rejects(context.readExcelBook({ ...file, size: 10 * 1024 * 1024 + 1 }), /10 MiB/); assert.equal(reads, 0);
  for (const outcome of ["success", "parser", "worker", "clone", "timeout"]) {
    const result = context.readExcelBook(file); await new Promise(setImmediate);
    const instance = Parser.instances.at(-1);
    if (outcome === "success") instance.onmessage({ data: { book: { SheetNames: ["test"] } } });
    if (outcome === "parser") instance.onmessage({ data: { error: "Synthetic rejection" } });
    if (outcome === "worker") instance.onerror();
    if (outcome === "clone") instance.onmessageerror();
    if (outcome === "timeout") timeout();
    if (outcome === "success") assert.equal((await result).SheetNames[0], "test"); else await assert.rejects(result);
    assert.equal(instance.stopped, true);
  }
});
