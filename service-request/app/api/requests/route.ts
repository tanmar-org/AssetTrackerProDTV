import { database } from "../../../lib/database";

// Server-only PostgreSQL connections require the Node runtime and fresh responses.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RequestRow = {
  id: string;
  asset_number: string;
  model: string;
  receiver_type: string;
  serial_number: string;
  rid: string;
  access_card: string;
  rent_state: string;
  account_number: string;
  account_name: string;
  recorded_location: string;
  office: string;
  operator_name: string;
  requester_name: string;
  requester_phone: string;
  rig_frac: string;
  lease: string;
  error_code: string;
  latitude: number;
  longitude: number;
  gps_accuracy: number;
  gps_captured_at: string;
  action: string;
  status: string;
  notes: string;
  requested_at: string;
  completed_at: string | null;
};

const allowedStatuses = new Set(["Pending", "Completed", "Cancelled"]);

// Staff read/update/delete requests use the server-to-server shared secret.
// Public POST intentionally does not call this guard so a scanned label can submit.
function authorized(request: Request) {
  const token = request.headers.get("authorization");
  return Boolean(
    (process.env.ADMIN_SHARED_SECRET &&
      token === `Bearer ${process.env.ADMIN_SHARED_SECRET}`),
  );
}

// Staff reads/updates go through the tracker server proxy. Cross-origin browser
// access is unnecessary, so do not retain the original Sites CORS allowlist.
function dashboardJson(_request: Request, data: unknown, init?: ResponseInit) {
  return Response.json(data, { ...init, headers: { ...init?.headers, "cache-control": "no-store" } });
}

export function OPTIONS() {
  return new Response(null, { status: 403 });
}

function mapRow(row: RequestRow) {
  return {
    id: row.id,
    assetNumber: row.asset_number,
    model: row.model,
    receiverType: row.receiver_type,
    serialNumber: row.serial_number,
    rid: row.rid,
    accessCard: row.access_card,
    rentState: row.rent_state,
    accountNumber: row.account_number,
    accountName: row.account_name,
    recordedLocation: row.recorded_location,
    office: row.office,
    operatorName: row.operator_name,
    requesterName: row.requester_name,
    requesterPhone: row.requester_phone,
    rigFrac: row.rig_frac,
    lease: row.lease,
    errorCode: row.error_code,
    latitude: row.latitude,
    longitude: row.longitude,
    gpsAccuracy: row.gps_accuracy,
    gpsCapturedAt: row.gps_captured_at,
    action: row.action,
    status: row.status,
    notes: row.notes,
    requestedAt: row.requested_at,
    completedAt: row.completed_at,
    mapUrl: `https://maps.google.com/?q=${row.latitude},${row.longitude}`,
    source: "QR",
  };
}

// Receiver/account metadata and GPS are caller supplied, not verified against the
// tracker. Asset lookup, input bounds, and abuse controls are required (SEC-05/QR-01).
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const assetNumber = String(body.assetNumber || "").trim().toUpperCase();
    const operatorName = String(body.operatorName || "").trim();
    const requesterName = String(body.requesterName || "").trim();
    const requesterPhone = String(body.requesterPhone || "").trim();
    const rigFrac = String(body.rigFrac || "").trim();
    const lease = String(body.lease || "").trim();
    const errorCode = String(body.errorCode || "").trim();
    const latitude = Number(body.latitude);
    const longitude = Number(body.longitude);
    const gpsAccuracy = Number(body.gpsAccuracy);
    const gpsCapturedAt = String(body.gpsCapturedAt || "").trim();

    if (!assetNumber)
      return Response.json(
        { error: "Asset Number is required." },
        { status: 400 },
      );
    if (!requesterName || !requesterPhone || requesterName.length > 120 || requesterPhone.length > 40)
      return Response.json(
        { error: "Requester name and callback phone number are required." },
        { status: 400 },
      );
    if (!errorCode)
      return Response.json(
        { error: "On-screen error code is required." },
        { status: 400 },
      );
    if (!operatorName)
      return Response.json(
        { error: "Operator Name is required." },
        { status: 400 },
      );
    if (!rigFrac)
      return Response.json(
        { error: "Rig/Frac is required." },
        { status: 400 },
      );
    if (!lease)
      return Response.json(
        { error: "Lease is required." },
        { status: 400 },
      );
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      !Number.isFinite(gpsAccuracy) ||
      !gpsCapturedAt
    )
      return Response.json(
        { error: "Location required." },
        { status: 400 },
      );

    const db = database();
    // A separate SELECT cannot prevent concurrent duplicate inserts. Enforce the
    // pending-request rule atomically when implementing SEC-05.
    const duplicate = await db
      .prepare(
        "SELECT id FROM service_requests WHERE asset_number = $1 AND status = 'Pending' AND deleted_at IS NULL LIMIT 1",
      )
      .bind(assetNumber)
      .first<{ id: string }>();

    if (duplicate)
      return Response.json(
        {
          error: "A pending request already exists for this receiver.",
          requestId: duplicate.id,
        },
        { status: 409 },
      );

    const id = crypto.randomUUID();
    const requestedAt = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO service_requests (
          id, asset_number, model, receiver_type, serial_number, rid,
          access_card, rent_state, account_number, account_name,
          recorded_location, office, operator_name, requester_name, requester_phone, rig_frac, lease,
          error_code, latitude, longitude,
          gps_accuracy, gps_captured_at, action, status, notes, requested_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, 'Pending', '', $24)`,
      )
      .bind(
        id,
        assetNumber,
        String(body.model || "").trim(),
        String(body.receiverType || "").trim(),
        String(body.serialNumber || "").trim(),
        String(body.rid || "").trim(),
        String(body.accessCard || "").trim(),
        String(body.rentState || "").trim(),
        String(body.accountNumber || "").trim(),
        String(body.accountName || "").trim(),
        String(body.recordedLocation || "").trim(),
        String(body.office || "").trim(),
        operatorName,
        requesterName,
        requesterPhone,
        rigFrac,
        lease,
        errorCode,
        latitude,
        longitude,
        gpsAccuracy,
        gpsCapturedAt,
        "Reactivate / Refresh",
        requestedAt,
      )
      .run();

    return Response.json({ id, status: "Pending", requestedAt }, { status: 201 });
  } catch {
    return Response.json(
      {
        error: "Unable to submit the service request.",
      },
      { status: 500 },
    );
  }
}

// The newest 500 non-deleted rows are returned, including completed requests.
// Older pending rows can fall outside this window; pagination is DATA-06.
export async function GET(request: Request) {
  if (!authorized(request))
    return dashboardJson(request, { error: "Unauthorized" }, { status: 401 });
  try {
    const result = await database()
      .prepare(
        "SELECT * FROM service_requests WHERE deleted_at IS NULL ORDER BY requested_at DESC LIMIT 500",
      )
      .all<RequestRow>();
    return dashboardJson(request, { requests: result.results.map(mapRow) });
  } catch {
    return dashboardJson(
      request,
      {
        error: "Unable to load requests.",
      },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request) {
  if (!authorized(request))
    return dashboardJson(request, { error: "Unauthorized" }, { status: 401 });
  try {
    const body = (await request.json()) as {
      id?: string;
      status?: string;
      notes?: string;
    };
    const id = String(body.id || "").trim();
    const status = String(body.status || "").trim();
    if (!id || !allowedStatuses.has(status))
      return dashboardJson(
        request,
        { error: "A valid request and status are required." },
        { status: 400 },
      );

    const completedAt = status === "Completed" ? new Date().toISOString() : null;
    const result = await database()
      .prepare(
        "UPDATE service_requests SET status = $1, completed_at = $2, notes = $3 WHERE id = $4 AND deleted_at IS NULL",
      )
      .bind(status, completedAt, String(body.notes || "").trim(), id)
      .run();

    if (!result.meta.changes)
      return dashboardJson(request, { error: "Request not found." }, { status: 404 });
    return dashboardJson(request, { id, status, completedAt });
  } catch {
    return dashboardJson(
      request,
      {
        error: "Unable to update request.",
      },
      { status: 500 },
    );
  }
}

// Deletion is a tombstone: retained rows disappear from list/update queries.
// A retention/backup policy must handle them separately from this UI action.
export async function DELETE(request: Request) {
  if (!authorized(request))
    return dashboardJson(request, { error: "Unauthorized" }, { status: 401 });
  try {
    const id = new URL(request.url).searchParams.get("id")?.trim() || "";
    if (!id)
      return dashboardJson(request, { error: "Request id is required." }, { status: 400 });
    const result = await database()
      .prepare(
        "UPDATE service_requests SET deleted_at = $1 WHERE id = $2 AND deleted_at IS NULL",
      )
      .bind(new Date().toISOString(), id)
      .run();
    if (!result.meta.changes)
      return dashboardJson(request, { error: "Request not found." }, { status: 404 });
    return dashboardJson(request, { id, deleted: true });
  } catch {
    return dashboardJson(
      request,
      {
        error: "Unable to delete request.",
      },
      { status: 500 },
    );
  }
}
