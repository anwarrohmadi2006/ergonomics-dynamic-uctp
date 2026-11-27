-- Migration 0001: Schedule archive storage on Cloudflare D1
CREATE TABLE IF NOT EXISTS saved_schedules (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  semester TEXT NOT NULL DEFAULT 'Ganjil 2026/2027',
  notes TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  total_sessions INTEGER NOT NULL DEFAULT 0,
  conflict_count INTEGER NOT NULL DEFAULT 0,
  comfort_score REAL NOT NULL DEFAULT 0,
  policy_json TEXT NOT NULL,
  audit_json TEXT NOT NULL,
  sessions_json TEXT NOT NULL,
  non_scheduled_json TEXT NOT NULL,
  rooms_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_saved_schedules_active_updated
  ON saved_schedules (is_active DESC, updated_at DESC);
