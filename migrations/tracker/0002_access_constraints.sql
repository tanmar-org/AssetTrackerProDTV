-- Match the existing PBKDF2/session representation and five-attempt lockout.
-- Fail visibly on incompatible imported rows; never rewrite credentials here.
ALTER TABLE app_users
  ADD CONSTRAINT app_users_pin_hash_format CHECK (pin_hash ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT app_users_pin_salt_format CHECK (pin_salt ~ '^[a-f0-9]{32}$'),
  ADD CONSTRAINT app_users_attempts_bounded CHECK (failed_attempts < 5);
ALTER TABLE app_sessions
  ADD CONSTRAINT app_sessions_token_hash_format CHECK (token_hash ~ '^[a-f0-9]{64}$');
-- PIN/role/deactivation revocation and per-account expiry cleanup use this key.
CREATE INDEX app_sessions_user_idx ON app_sessions (user_id);
