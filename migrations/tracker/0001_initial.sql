-- Preserve API representations and historical IDs during the backend port.
-- JSONB validates state payloads; timestamps remain canonical ISO strings for
-- compatibility with existing browser/session code and eventual D1 import.
CREATE TABLE app_users (
  id text PRIMARY KEY, name text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'user')),
  pin_hash text NOT NULL, pin_salt text NOT NULL,
  active integer NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until text, last_login_at text,
  created_at text NOT NULL, updated_at text NOT NULL
);
CREATE UNIQUE INDEX app_users_name_unique ON app_users (lower(name));
CREATE TABLE app_sessions (
  id text PRIMARY KEY, user_id text NOT NULL REFERENCES app_users(id),
  token_hash text NOT NULL UNIQUE, expires_at text NOT NULL, created_at text NOT NULL
);
CREATE TABLE app_change_log (
  id text PRIMARY KEY, user_id text, user_name text NOT NULL,
  action text NOT NULL, revision integer, created_at text NOT NULL
);
CREATE INDEX app_change_log_created_idx ON app_change_log (created_at);
CREATE TABLE app_state (
  id text PRIMARY KEY, payload jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at text NOT NULL, updated_by text
);
CREATE INDEX app_state_updated_at_idx ON app_state (updated_at);
CREATE TABLE app_state_history (
  id text PRIMARY KEY, revision integer NOT NULL, payload jsonb NOT NULL,
  action text NOT NULL, created_at text NOT NULL, created_by text NOT NULL
);
CREATE INDEX app_state_history_created_idx ON app_state_history (created_at);
