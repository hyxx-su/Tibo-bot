ALTER TABLE guild_settings ADD COLUMN reset_channel_id TEXT;
ALTER TABLE guild_settings ADD COLUMN reset_activated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE guild_settings ADD COLUMN reset_config_event TEXT NOT NULL DEFAULT '0';
ALTER TABLE guild_settings ADD COLUMN setup_complete INTEGER NOT NULL DEFAULT 0;
ALTER TABLE guild_settings ADD COLUMN reselect_needed INTEGER NOT NULL DEFAULT 0;
UPDATE guild_settings SET reset_channel_id=channel_id,reset_activated_at=activated_at,reset_config_event=config_event,
  setup_complete=CASE WHEN active=1 AND (channel_id IS NOT NULL OR config_event!='0') THEN 1 ELSE 0 END,
  reselect_needed=CASE WHEN active=1 AND channel_id IS NULL AND config_event!='0' THEN 1 ELSE 0 END;
