-- Tombstones remain stored. The status index reaches old pending work without
-- loading newer completions; equal timestamps are ordered by the primary key.
CREATE INDEX service_requests_page_idx
  ON service_requests (requested_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX service_requests_status_page_idx
  ON service_requests (status, requested_at DESC, id DESC) WHERE deleted_at IS NULL;
