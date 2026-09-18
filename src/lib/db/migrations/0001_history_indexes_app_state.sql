CREATE TABLE IF NOT EXISTS `app_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `pomodoro_sessions_date_idx` ON `pomodoro_sessions` (`date`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `work_sessions_date_idx` ON `work_sessions` (`date`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `work_sessions_company_id_idx` ON `work_sessions` (`company_id`);