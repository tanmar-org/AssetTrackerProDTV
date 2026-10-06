import { InputError, text } from "./input";

export type AssetSnapshot = {
  id: string; assetNumber: string; model: string; receiverType: string; serialNumber: string; rid: string;
  accessCard: string; rentState: string; accountNumber: string; accountName: string; recordedLocation: string; office: string;
};

// Fetch only the operator-configured staff endpoint. Never follow a redirect with
// the bearer credential or accept a destination supplied by a label/form caller.
export async function lookupAsset(selector: { key: string; value: string }): Promise<AssetSnapshot> {
  const secret = process.env.ADMIN_SHARED_SECRET;
  if (!secret || !process.env.TRACKER_ASSET_API_URL) throw new Error("Lookup is not configured.");
  const url = new URL(process.env.TRACKER_ASSET_API_URL);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("Invalid lookup configuration.");
  url.searchParams.set(selector.key, selector.value);
  const response = await fetch(url, { headers: { authorization: `Bearer ${secret}` }, cache: "no-store",
    redirect: "error", signal: AbortSignal.timeout(5000) });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 404) throw new InputError("Receiver unavailable. Contact TanMar for help.", 404);
    throw new Error("Receiver lookup failed.");
  }
  // A trusted server can still be misconfigured. Bound and validate its response;
  // these private fields must never be spread into a public response or error.
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing lookup response.");
  let bytes = 0, contents = "";
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 8192) { await reader.cancel(); throw new Error("Lookup response is too large."); }
      contents += decoder.decode(value, { stream: true });
    }
    contents += decoder.decode();
  } finally { reader.releaseLock(); }
  const row = JSON.parse(contents) as AssetSnapshot;
  if (!row || typeof row !== "object" || typeof row.id !== "string" || typeof row.assetNumber !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.id) || !/^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,127}$/.test(row.assetNumber) ||
      (selector.key === "id" ? row.id !== selector.value : row.assetNumber.toUpperCase() !== selector.value.toUpperCase()))
    throw new Error("Invalid lookup response.");
  for (const key of ["model", "receiverType", "serialNumber", "rid", "accessCard", "rentState", "accountNumber"] as const)
    text(row[key], "Receiver field", 128, false, true);
  for (const key of ["accountName", "recordedLocation", "office"] as const) text(row[key], "Account field", 256, false, true);
  return row;
}
