CREATE TABLE IF NOT EXISTS watch_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  baseline_id TEXT,
  high_water_id TEXT,
  poll_lease_until INTEGER NOT NULL DEFAULT 0,
  poll_token TEXT,
  last_success INTEGER,
  last_error TEXT,
  started_at INTEGER
);
INSERT OR IGNORE INTO watch_state (id) VALUES (1);

CREATE TABLE IF NOT EXISTS watched_posts (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  published_at TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('link','analyze','reset','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  claim_token TEXT,
  message_id TEXT,
  reset_message_id TEXT,
  analysis_json TEXT,
  last_error TEXT,
  discovered_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS watched_posts_pending ON watched_posts (phase, next_attempt, lease_until);

CREATE TABLE IF NOT EXISTS analysis_budget (
  day TEXT PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0
);
