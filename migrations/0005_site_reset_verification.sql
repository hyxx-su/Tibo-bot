ALTER TABLE site_reset_events ADD COLUMN source_type TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE site_reset_events ADD COLUMN verification TEXT NOT NULL DEFAULT 'pending' CHECK (verification IN ('pending','verified','rejected','retracted'));
ALTER TABLE site_reset_events ADD COLUMN verification_reason TEXT;
ALTER TABLE site_reset_events ADD COLUMN last_seen_at INTEGER;
ALTER TABLE site_reset_events ADD COLUMN missing_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS site_reset_events_verified ON site_reset_events(verification,announced_at);
