CREATE TABLE `builds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`package_id` integer NOT NULL,
	`upload_id` integer NOT NULL,
	`version` text NOT NULL,
	`source_version_label` text,
	`config_snapshot` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`tarball_integrity` text,
	`log` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`package_id`) REFERENCES `packages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`upload_id`) REFERENCES `uploads`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `builds_status_idx` ON `builds` (`status`);--> statement-breakpoint
CREATE TABLE `guid_index` (
	`guid` text NOT NULL,
	`package_name` text NOT NULL,
	`version` text NOT NULL,
	`path` text NOT NULL,
	PRIMARY KEY(`guid`, `package_name`, `version`)
);
--> statement-breakpoint
CREATE TABLE `known_packages` (
	`name` text PRIMARY KEY NOT NULL,
	`detect_rules` text NOT NULL,
	`replacement_dependency` text
);
--> statement-breakpoint
CREATE TABLE `packages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`display_name` text NOT NULL,
	`source_url` text,
	`config_template` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `packages_name_unique` ON `packages` (`name`);--> statement-breakpoint
CREATE TABLE `uploads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sha256` text NOT NULL,
	`original_filename` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`analysis_json` text,
	`file_state` text DEFAULT 'stored' NOT NULL,
	`archived_at` text,
	`archive_note` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uploads_sha256_unique` ON `uploads` (`sha256`);