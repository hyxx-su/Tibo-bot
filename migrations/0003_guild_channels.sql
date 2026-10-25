CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id TEXT PRIMARY KEY,
  channel_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  activated_at INTEGER NOT NULL DEFAULT 0,
  config_event TEXT NOT NULL DEFAULT '0',
  welcome_message_id TEXT,
  welcome_channel_id TEXT,
  welcome_lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS post_deliveries (
  post_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  content TEXT NOT NULL,
  message_id TEXT,
  phase TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  claim_token TEXT,
  last_error TEXT,
  PRIMARY KEY (post_id, guild_id, kind)
);
CREATE INDEX IF NOT EXISTS post_deliveries_pending ON post_deliveries(phase,next_attempt,lease_until);
