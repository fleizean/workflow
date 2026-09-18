ALTER TABLE `companies` DROP COLUMN `excel_column`;--> statement-breakpoint
ALTER TABLE `companies` DROP COLUMN `note_column`;--> statement-breakpoint
DELETE FROM `settings` WHERE `key` = 'export_half_hour_precision';--> statement-breakpoint
DELETE FROM `settings` WHERE `key` = 'script_url';