-- Shared pre-authentication counters cover unknown usernames across Node processes.
-- The operator applies this migration; HTTP handlers never create schema objects.
CREATE TABLE app_login_rate_limits (
  bucket_key text PRIMARY KEY CHECK (length(bucket_key) BETWEEN 1 AND 128),
  hits integer NOT NULL CHECK (hits BETWEEN 1 AND 301),
  expires_at bigint NOT NULL CHECK (expires_at > 0)
);
CREATE INDEX app_login_rate_limits_expiry_idx ON app_login_rate_limits (expires_at);
