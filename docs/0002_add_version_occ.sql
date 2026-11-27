-- Migration 0002: Add optimistic concurrency control (version) column
ALTER TABLE saved_schedules ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
