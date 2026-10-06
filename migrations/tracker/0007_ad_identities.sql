-- Explicit operator links preserve application IDs, permissions and draft ownership.
-- Existing users/sessions remain PIN records until the operator chooses AD mode.
ALTER TABLE app_users ADD COLUMN ad_directory text, ADD COLUMN ad_guid uuid,
  ADD CONSTRAINT app_users_ad_identity CHECK (
    (ad_directory IS NULL AND ad_guid IS NULL) OR
    (ad_directory IS NOT NULL AND ad_directory ~ '^[a-z0-9][a-z0-9_-]{0,63}$' AND ad_guid IS NOT NULL)
  ), ADD CONSTRAINT app_users_ad_unique UNIQUE (ad_directory, ad_guid);
ALTER TABLE app_sessions
  ADD COLUMN auth_method text NOT NULL DEFAULT 'pin' CHECK (auth_method IN ('pin', 'ad')),
  ADD COLUMN auth_binding text,
  ADD COLUMN ad_guid uuid,
  ADD COLUMN ad_password_stamp text,
  ADD COLUMN directory_checked_at bigint,
  ADD CONSTRAINT app_sessions_ad_identity CHECK (
    (auth_method = 'pin' AND auth_binding IS NULL AND ad_guid IS NULL AND ad_password_stamp IS NULL AND directory_checked_at IS NULL) OR
    (auth_method = 'ad' AND auth_binding IS NOT NULL AND auth_binding ~ '^[a-f0-9]{64}$' AND ad_guid IS NOT NULL
      AND ad_password_stamp IS NOT NULL AND ad_password_stamp ~ '^[1-9][0-9]{0,18}$'
      AND directory_checked_at IS NOT NULL AND directory_checked_at > 0)
  );
