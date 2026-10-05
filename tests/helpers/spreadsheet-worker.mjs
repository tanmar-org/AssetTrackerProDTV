import { readFileSync } from "node:fs";
import { parentPort } from "node:worker_threads";
import vm from "node:vm";

// Load the actual browser worker and vendored parser in an isolated Node thread.
// importScripts resolves only repository files, never a network endpoint.
const root = new URL("../../public/asset-tracker/", import.meta.url);
const context = vm.createContext({ ArrayBuffer, DataView, Uint8Array, Blob, DecompressionStream,
  self: { postMessage: (data) => parentPort.postMessage(data) } });
context.importScripts = (...paths) => {
  for (const path of paths) vm.runInContext(readFileSync(new URL(path, root), "utf8"), context);
};
vm.runInContext(readFileSync(new URL("spreadsheet-worker.js", root), "utf8"), context);
parentPort.on("message", (data) => context.self.onmessage({ data }));
