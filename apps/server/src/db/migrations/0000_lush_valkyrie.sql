CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`actor_id` text,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_subject_idx` ON `audit_events` (`subject_type`,`subject_id`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`sha256` text NOT NULL,
	`filename` text NOT NULL,
	`format` text NOT NULL,
	`byte_size` integer NOT NULL,
	`model` text NOT NULL,
	`contract_number` text,
	`customer` text,
	`uploaded_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `documents_sha256_unique` ON `documents` (`sha256`);--> statement-breakpoint
CREATE TABLE `finding_observations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`finding_id` text NOT NULL,
	`run_id` text NOT NULL,
	`agent` text NOT NULL,
	`item_index` integer NOT NULL,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`finding_id`) REFERENCES `findings`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `observations_run_item_idx` ON `finding_observations` (`run_id`,`item_index`);--> statement-breakpoint
CREATE TABLE `findings` (
	`id` text PRIMARY KEY NOT NULL,
	`identity` text NOT NULL,
	`document_id` text NOT NULL,
	`topic` text NOT NULL,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`affected_term` text NOT NULL,
	`required_action` text NOT NULL,
	`rationale` text NOT NULL,
	`citations` text NOT NULL,
	`eligible` integer NOT NULL,
	`blocked_reasons` text NOT NULL,
	`latest_run_id` text NOT NULL,
	`first_seen_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`last_seen_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `findings_identity_unique` ON `findings` (`identity`);--> statement-breakpoint
CREATE INDEX `findings_document_idx` ON `findings` (`document_id`);--> statement-breakpoint
CREATE TABLE `invites` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`expires_at` text NOT NULL,
	`accepted_at` text
);
--> statement-breakpoint
CREATE TABLE `jira_changes` (
	`change_key` text PRIMARY KEY NOT NULL,
	`issue_key` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`changed_at` text NOT NULL,
	`observed_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jira_issues` (
	`issue_key` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`finding_id` text,
	`summary` text NOT NULL,
	`status` text NOT NULL,
	`status_category` text NOT NULL,
	`assignee_name` text,
	`labels` text NOT NULL,
	`comments` text NOT NULL,
	`remote_updated_at` text NOT NULL,
	`observed_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jira_links` (
	`finding_id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`issue_key` text NOT NULL,
	`status` text,
	`status_category` text,
	`assignee_name` text,
	`remote_updated_at` text,
	`drift` text DEFAULT 'in_sync' NOT NULL,
	`created_by_run_id` text,
	`linked_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`reconciled_at` text,
	FOREIGN KEY (`finding_id`) REFERENCES `findings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jira_links_issueKey_unique` ON `jira_links` (`issue_key`);--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`finding_id` text NOT NULL,
	`run_id` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text NOT NULL,
	`last_error` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`finding_id`) REFERENCES `findings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_dedupeKey_unique` ON `outbox` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `outbox_pending_idx` ON `outbox` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `run_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`event` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_events_seq_idx` ON `run_events` (`run_id`,`seq`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`agent` text NOT NULL,
	`parent_run_id` text,
	`runtime` text NOT NULL,
	`model` text NOT NULL,
	`effort` text NOT NULL,
	`auth` text,
	`prompt_version` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`output` text,
	`usage` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`started_at` text,
	`finished_at` text,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `runs_document_idx` ON `runs` (`document_id`,`agent`,`created_at`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`role` text DEFAULT 'reviewer' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE TABLE `watcher_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`change_key` text NOT NULL,
	`issue_key` text NOT NULL,
	`decision` text NOT NULL,
	`reply` text,
	`confidence` real NOT NULL,
	`policy` text NOT NULL,
	`status` text NOT NULL,
	`action_marker` text NOT NULL,
	`model` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`last_error` text,
	`executed_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`change_key`) REFERENCES `jira_changes`(`change_key`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `watcher_decisions_changeKey_unique` ON `watcher_decisions` (`change_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `watcher_decisions_actionMarker_unique` ON `watcher_decisions` (`action_marker`);--> statement-breakpoint
CREATE INDEX `watcher_pending_idx` ON `watcher_decisions` (`status`,`next_attempt_at`);