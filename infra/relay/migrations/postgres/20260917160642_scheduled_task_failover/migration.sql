CREATE TABLE "relay_scheduled_tasks" (
	"group_id" varchar(36) PRIMARY KEY,
	"revision" varchar(36) NOT NULL,
	"user_id" varchar(191) NOT NULL,
	"members" jsonb NOT NULL,
	"schedule" jsonb NOT NULL,
	"time_zone" varchar(100) NOT NULL,
	"enabled" boolean NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"next_run_at" varchar(64) NOT NULL,
	"activated_at" varchar(64),
	"heartbeats" jsonb NOT NULL
);
