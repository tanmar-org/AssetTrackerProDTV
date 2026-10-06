import { database } from "../../../lib/database";
import { validateInventory } from "../../../lib/inventory-state";
import { matchesSecret } from "../../../lib/server-secret";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (data: unknown, status = 200) => Response.json(data, {
  status, headers: { "cache-control": "no-store" },
});

// This is a private server-to-server endpoint, not a public asset directory.
// The QR server copies current inventory metadata into its internal request row;
// its public endpoint must return only the receiver ID and printed asset number.
export async function GET(request: Request) {
  const secret = process.env.ADMIN_SHARED_SECRET;
  if (!matchesSecret(request.headers.get("authorization"), secret ? `Bearer ${secret}` : undefined))
    return json({ error: "Unauthorized" }, 401);
  const params = new URL(request.url).searchParams;
  const id = params.get("id");
  const asset = params.get("a");
  if (params.size !== 1 || (id === null) === (asset === null) ||
      (id !== null ? !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)
        : !/^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,127}$/.test(asset!)))
    return json({ error: "Scan a valid receiver label." }, 400);
  try {
    // Read a single committed JSONB snapshot: receiver and assignment cannot come
    // from different inventory revisions. Metadata can change after this lookup;
    // cross-database status/inventory coordination remains DATA-02.
    const row = await database().prepare("SELECT payload FROM app_state WHERE id = $1")
      .bind("tanmar-receiver-control").first<{ payload: unknown }>();
    if (!row) return json({ error: "Receiver unavailable." }, 404);
    const state = validateInventory(row.payload);
    const receiver = state.master.find((item) => id !== null ? item.id === id
      : String(item.assetNumber).toUpperCase() === asset!.toUpperCase());
    if (!receiver) return json({ error: "Receiver unavailable." }, 404);
    const assignment = state.assignments.find((item) => item.assetId === receiver.id);
    const account = state.accounts.find((item) => item.id === assignment?.accountId);
    return json({
      id: receiver.id, assetNumber: receiver.assetNumber, model: receiver.model ?? "",
      receiverType: receiver.type ?? "", serialNumber: receiver.serial ?? "", rid: receiver.rid ?? "",
      accessCard: receiver.accessCard ?? "", rentState: receiver.rentState,
      accountNumber: account?.number ?? "", accountName: account?.name ?? "",
      recordedLocation: account?.location ?? "", office: account?.office ?? "",
    });
  } catch { return json({ error: "Receiver lookup unavailable." }, 503); }
}
