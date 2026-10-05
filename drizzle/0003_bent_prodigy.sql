CREATE TABLE `app_state_history` (
	`id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`payload` text NOT NULL,
	`action` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL
);
