CREATE TABLE IF NOT EXISTS `thread_turn_spend` (
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`provider_thread_id` text NOT NULL,
	`input_tokens` integer,
	`cached_input_tokens` integer,
	`output_tokens` integer,
	`reasoning_output_tokens` integer,
	`total_tokens` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`thread_id`, `turn_id`, `provider_thread_id`),
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `thread_turn_spend_thread_idx` ON `thread_turn_spend` (`thread_id`,`turn_id`);
