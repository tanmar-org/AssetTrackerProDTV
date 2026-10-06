-- Recovery copies belong to an account, never a shared browser. Closed IDs are
-- retained until expiry so a delayed update cannot resurrect an applied draft.
CREATE TABLE app_inventory_drafts (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES app_users(id),
  version integer NOT NULL CHECK (version > 0),
  base_revision integer NOT NULL CHECK (base_revision >= 0),
  base_state jsonb NOT NULL,
  draft_state jsonb NOT NULL,
  label text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'applied', 'discarded')),
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX app_inventory_drafts_owner ON app_inventory_drafts(user_id, expires_at);
