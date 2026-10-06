import { AccessInputError } from "./access-input.ts";

// One configured internal endpoint; user input never controls its origin/path.
// Reject redirects rather than sending the bearer credential elsewhere.
export function serviceEndpoint(suffix = "", env = process.env) {
  let url: URL;
  try { url = new URL(env.SERVICE_REQUEST_API_URL ?? ""); } catch { throw new AccessInputError("Service request synchronization is not configured.",503); }
  if (!["http:","https:"].includes(url.protocol) || url.username || url.password || !env.ADMIN_SHARED_SECRET)
    throw new AccessInputError("Service request synchronization is not configured.",503);
  url.search = "";url.hash = "";
  if (suffix) url.pathname = url.pathname.replace(/\/$/,"") + "/" + suffix;
  return url;
}
export async function readServiceBody(response: Response, limit = 2 * 1024 * 1024) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();let bytes = 0, body = "";
  try {
    while (true) {
      const {value,done} = await reader.read();if(done)break;
      bytes += value.byteLength;
      if(bytes > limit){await reader.cancel();throw new Error("Internal response exceeded its byte budget.");}
      body += decoder.decode(value,{stream:true});
    }
    return body + decoder.decode();
  } finally {reader.releaseLock();}
}
export async function serviceFetch(url: URL, method = "GET", body?: unknown, signal = AbortSignal.timeout(5000)) {
  const response = await fetch(url,{method,redirect:"error",signal,
    headers:{authorization:`Bearer ${process.env.ADMIN_SHARED_SECRET}`,...(body ? {"content-type":"application/json"} : {})},
    ...(body ? {body:JSON.stringify(body)} : {})});
  const contents = await readServiceBody(response,32768);
  // Status classification is local; never copy private upstream diagnostics.
  if(response.status === 404)return null;
  if(!response.ok)throw new Error("Internal service unavailable.");
  return JSON.parse(contents) as unknown;
}
