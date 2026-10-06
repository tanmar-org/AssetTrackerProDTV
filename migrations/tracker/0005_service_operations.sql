-- Durable intent is committed before the QR call. No bearer/session secret is
-- stored, and original attribution survives account deletion or renaming.
CREATE TABLE app_service_operations (
  id uuid PRIMARY KEY, request_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('status','delete')),
  target_status text CHECK (target_status IN ('Pending','Completed','Cancelled')),
  notes text NOT NULL CHECK (length(notes) <= 2048),
  expected_version integer NOT NULL CHECK (expected_version > 0),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  actor_id text NOT NULL, actor_name text NOT NULL,
  approver_id text NOT NULL, approver_name text NOT NULL,
  receiver_id text, receiver_baseline jsonb,
  snapshot jsonb NOT NULL, receipt jsonb,
  phase text NOT NULL DEFAULT 'pending' CHECK (phase IN ('pending','blocked','needs_review','done','failed')),
  error_code text NOT NULL DEFAULT '',
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  history_scope text CHECK (history_scope IN ('receiver','operation')),
  created_at text NOT NULL, updated_at text NOT NULL,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'delete' AND target_status IS NULL) OR (kind = 'status' AND target_status IS NOT NULL))
);
-- One unresolved intent per request prevents a later action overtaking its history.
CREATE UNIQUE INDEX app_service_operations_open_request ON app_service_operations(request_id)
  WHERE phase IN ('pending','blocked','needs_review');
CREATE INDEX app_service_operations_page ON app_service_operations(updated_at DESC,id DESC);
CREATE INDEX app_service_operations_due ON app_service_operations(next_attempt_at,id)
  WHERE phase IN ('pending','blocked');
