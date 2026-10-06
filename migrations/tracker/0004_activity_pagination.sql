-- Stable newest-first pages break equal timestamps with the primary key.
-- Preserve existing indexes and all records; this is not a retention policy.
CREATE INDEX app_change_log_page_idx ON app_change_log (created_at DESC, id DESC);
