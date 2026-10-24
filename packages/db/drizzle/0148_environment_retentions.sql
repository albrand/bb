CREATE TABLE `environment_release_consents` (
	`id` text PRIMARY KEY NOT NULL,
	`environment_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_thread_id` text,
	`granted_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `environment_release_consents_environment_thread_idx` ON `environment_release_consents` (`environment_id`,`thread_id`);--> statement-breakpoint
CREATE INDEX `environment_release_consents_thread_idx` ON `environment_release_consents` (`thread_id`);--> statement-breakpoint
CREATE TABLE `environment_retention_transitions` (
	`id` text PRIMARY KEY NOT NULL,
	`retention_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`host_id` text NOT NULL,
	`from_state` text,
	`to_state` text NOT NULL,
	`path` text,
	`detail` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `environment_retention_transitions_retention_idx` ON `environment_retention_transitions` (`retention_id`);--> statement-breakpoint
CREATE INDEX `environment_retention_transitions_environment_idx` ON `environment_retention_transitions` (`environment_id`);--> statement-breakpoint
CREATE TABLE `environment_retentions` (
	`id` text PRIMARY KEY NOT NULL,
	`environment_id` text NOT NULL,
	`project_id` text NOT NULL,
	`host_id` text NOT NULL,
	`owner_thread_id` text,
	`provider_id` text NOT NULL,
	`original_path` text,
	`kept_path` text,
	`state` text NOT NULL,
	`message` text NOT NULL,
	`closed_at` integer,
	`closed_proof` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `environment_retentions_host_state_idx` ON `environment_retentions` (`host_id`,`state`);--> statement-breakpoint
CREATE INDEX `environment_retentions_environment_idx` ON `environment_retentions` (`environment_id`);--> statement-breakpoint
CREATE INDEX `environment_retentions_project_idx` ON `environment_retentions` (`project_id`);--> statement-breakpoint
CREATE INDEX `environment_retentions_thread_idx` ON `environment_retentions` (`owner_thread_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `environment_retentions_environment_kept_idx` ON `environment_retentions` (`environment_id`,`kept_path`);--> statement-breakpoint
ALTER TABLE `environments` ADD `teardown_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `environments` ADD `teardown_prior_status` text;--> statement-breakpoint
INSERT INTO `environment_release_consents` (`id`, `environment_id`, `thread_id`, `actor_kind`, `actor_thread_id`, `granted_at`) SELECT 'rel_' || lower(hex(randomblob(10))), `environment_id`, `id`, 'migrated', NULL, COALESCE(`archived_at`, `deleted_at`) FROM `threads` WHERE `environment_id` IS NOT NULL AND (`archived_at` IS NOT NULL OR `deleted_at` IS NOT NULL);
