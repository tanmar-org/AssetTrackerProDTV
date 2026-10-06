// Keep public responses separate from the private staff/receipt representation.
export type RequestRow = {
  id: string; version: number; deleted_at: string | null; asset_id: string | null; asset_number: string; model: string; receiver_type: string;
  serial_number: string; rid: string; access_card: string; rent_state: string; account_number: string;
  account_name: string; recorded_location: string; office: string; operator_name: string;
  requester_name: string; requester_phone: string; rig_frac: string; lease: string; error_code: string;
  latitude: number; longitude: number; gps_accuracy: number; gps_captured_at: string;
  action: string; status: string; notes: string; requested_at: string; completed_at: string | null;
};

export function mapRow(row: RequestRow) {
  return {
    id: row.id,
    version: row.version,
    assetId: row.asset_id,
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

