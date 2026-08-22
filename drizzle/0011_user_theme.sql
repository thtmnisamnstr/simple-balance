CREATE TYPE "public"."user_theme" AS ENUM('system', 'light', 'dark');--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "theme" "user_theme" DEFAULT 'system' NOT NULL;