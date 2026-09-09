-- ブラックジャックの卓。3人まで座って、ディーラー（Bot）と勝負する。
-- 山札・手札・手番は state（JSON）に入れ、同時押しは version の取り合いで防ぐ。
CREATE TABLE IF NOT EXISTS blackjack_tables (
  id         TEXT    PRIMARY KEY,
  guild_id   TEXT    NOT NULL,
  channel_id TEXT    NOT NULL,
  message_id TEXT,
  host_id    TEXT    NOT NULL,
  bet        INTEGER NOT NULL,  -- 卓の賭け金（全員同じ）
  status     TEXT    NOT NULL,  -- joining / playing / done / cancelled
  state      TEXT    NOT NULL DEFAULT '{}',
  version    INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blackjack_open ON blackjack_tables (status, expires_at);
