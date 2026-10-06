import { failure, fields, json, selector } from "../../../lib/input";
import { lookupAsset } from "../../../lib/asset-lookup";
import { guardPublic } from "../../../lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Only these two non-private fields cross the public boundary. Legacy printed
// links can resolve by asset number; all new labels use the stable receiver ID.
export async function GET(request: Request) {
  try {
    await guardPublic(request, "lookup");
    const params = new URL(request.url).searchParams;
    const body: Record<string, unknown> = Object.fromEntries(params);
    fields(body, ["id", "a"]);
    if (params.size !== Object.keys(body).length) return json({ error: "Scan a valid receiver label." }, 400);
    const asset = await lookupAsset(selector({
      ...(body.id !== undefined ? { assetId: body.id } : {}),
      ...(body.a !== undefined ? { assetNumber: body.a } : {}),
    }));
    return json({ id: asset.id, assetNumber: asset.assetNumber });
  } catch (error) { return failure(error, "Receiver lookup unavailable. Please try again later."); }
}
