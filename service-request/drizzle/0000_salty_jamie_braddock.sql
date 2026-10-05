CREATE TABLE `service_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_number` text NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`receiver_type` text DEFAULT '' NOT NULL,
	`serial_number` text DEFAULT '' NOT NULL,
	`rid` text DEFAULT '' NOT NULL,
	`access_card` text DEFAULT '' NOT NULL,
	`rent_state` text DEFAULT '' NOT NULL,
	`account_number` text DEFAULT '' NOT NULL,
	`account_name` text DEFAULT '' NOT NULL,
	`recorded_location` text DEFAULT '' NOT NULL,
	`office` text DEFAULT '' NOT NULL,
	`error_code` text NOT NULL,
	`latitude` real NOT NULL,
	`longitude` real NOT NULL,
	`gps_accuracy` real NOT NULL,
	`gps_captured_at` text NOT NULL,
	`action` text DEFAULT 'Reactivate / Refresh' NOT NULL,
	`status` text DEFAULT 'Pending' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`requested_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text,
	`deleted_at` text
);
--> statement-breakpoint
CREATE INDEX `service_requests_asset_idx` ON `service_requests` (`asset_number`);--> statement-breakpoint
CREATE INDEX `service_requests_status_idx` ON `service_requests` (`status`);--> statement-breakpoint
CREATE INDEX `service_requests_requested_idx` ON `service_requests` (`requested_at`);