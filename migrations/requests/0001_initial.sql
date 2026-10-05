-- The public service connects to a separate database/role from staff inventory.
CREATE TABLE service_requests (
  id text PRIMARY KEY, asset_number text NOT NULL,
  model text NOT NULL DEFAULT '', receiver_type text NOT NULL DEFAULT '',
  serial_number text NOT NULL DEFAULT '', rid text NOT NULL DEFAULT '',
  access_card text NOT NULL DEFAULT '', rent_state text NOT NULL DEFAULT '',
  account_number text NOT NULL DEFAULT '', account_name text NOT NULL DEFAULT '',
  recorded_location text NOT NULL DEFAULT '', office text NOT NULL DEFAULT '',
  operator_name text NOT NULL DEFAULT '', requester_name text NOT NULL DEFAULT '',
  requester_phone text NOT NULL DEFAULT '', rig_frac text NOT NULL DEFAULT '',
  lease text NOT NULL DEFAULT '', error_code text NOT NULL,
  latitude double precision NOT NULL, longitude double precision NOT NULL,
  gps_accuracy double precision NOT NULL, gps_captured_at text NOT NULL,
  action text NOT NULL DEFAULT 'Reactivate / Refresh',
  status text NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Completed', 'Cancelled')),
  notes text NOT NULL DEFAULT '', requested_at text NOT NULL,
  completed_at text, deleted_at text
);
CREATE INDEX service_requests_asset_idx ON service_requests (asset_number);
CREATE INDEX service_requests_status_idx ON service_requests (status);
CREATE INDEX service_requests_requested_idx ON service_requests (requested_at);
