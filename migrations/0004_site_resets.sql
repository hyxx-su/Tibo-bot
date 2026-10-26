CREATE TABLE IF NOT EXISTS site_reset_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  initialized_at INTEGER,
  next_poll_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  claim_token TEXT,
  last_success INTEGER,
  last_error TEXT
);
INSERT OR IGNORE INTO site_reset_state (id) VALUES (1);
CREATE TABLE IF NOT EXISTS site_reset_events (
  event_key TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  reset_type TEXT NOT NULL CHECK (reset_type IN ('regular','banked')),
  announced_at TEXT NOT NULL,
  original_url TEXT,
  content TEXT NOT NULL,
  discovered_at INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('baseline','pending','queued'))
);
CREATE INDEX IF NOT EXISTS site_reset_events_pending ON site_reset_events(phase,discovered_at);
