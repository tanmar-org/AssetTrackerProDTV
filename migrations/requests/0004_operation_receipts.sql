-- Version checks prevent an old tab overwriting a newer request transition.
ALTER TABLE service_requests ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);
-- Store success and permanent rejection with the row transition in one transaction.
-- Receipts must survive retries, tombstones and later versions of the request.
CREATE TABLE service_request_operations (
  id uuid PRIMARY KEY, request_id text NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL, created_at text NOT NULL
);
CREATE INDEX service_request_operations_request ON service_request_operations(request_id,created_at);
