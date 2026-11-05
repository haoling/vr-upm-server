ALTER TABLE `builds` ADD `published_at` text;--> statement-breakpoint
CREATE UNIQUE INDEX `builds_published_version_uq` ON `builds` (`package_id`,`version`) WHERE status = 'published';