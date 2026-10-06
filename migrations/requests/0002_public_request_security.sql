-- Keep the original migration checksum intact. Existing rows retain their
-- historical metadata; operators must reconcile duplicates/invalid GPS first.
ALTER TABLE service_requests ADD COLUMN asset_id text;
ALTER TABLE service_requests ADD CONSTRAINT service_request_asset_id
  CHECK (asset_id IS NULL OR asset_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$');
ALTER TABLE service_requests ADD CONSTRAINT service_request_coordinates
  CHECK (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180
    AND gps_accuracy BETWEEN 0 AND 10000);

-- Both indexes protect legacy rows (no stable ID) and asset-number reuse. The
-- ID index also protects a receiver renamed while its request is still pending.
CREATE UNIQUE INDEX service_requests_pending_number_unique
  ON service_requests (upper(asset_number)) WHERE status = 'Pending' AND deleted_at IS NULL;
CREATE UNIQUE INDEX service_requests_pending_id_unique
  ON service_requests (asset_id) WHERE asset_id IS NOT NULL AND status = 'Pending' AND deleted_at IS NULL;

CREATE TABLE request_rate_limits (
  bucket_key text PRIMARY KEY, hits integer NOT NULL CHECK (hits > 0),
  expires_at bigint NOT NULL
);
CREATE INDEX request_rate_limits_expiry_idx ON request_rate_limits (expires_at);
