-- サイコロのゲーム2つ。どちらも卓の出し入れは lib/card-table.js で共通化している。
--
-- ピッグ  : 2〜4人。手番の人が振り続けて点を足す。1が出たらそのターンの点が消える
-- 丁半博打: 何人でも。丁（偶数）か半（奇数）に賭けて、壺を開ける

CREATE TABLE IF NOT EXISTS pig_tables (
  id         TEXT    PRIMARY KEY,
  guild_id   TEXT    NOT NULL,
  channel_id TEXT    NOT NULL,
  message_id TEXT,
  host_id    TEXT    NOT NULL,
  bet        INTEGER NOT NULL,  -- 参加費。全員ぶんがそのまま場になる
  status     TEXT    NOT NULL,  -- joining / playing / done / cancelled
  state      TEXT    NOT NULL DEFAULT '{}',
  version    INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pig_open ON pig_tables (status, expires_at);

CREATE TABLE IF NOT EXISTS chohan_tables (
  id         TEXT    PRIMARY KEY,
  guild_id   TEXT    NOT NULL,
  channel_id TEXT    NOT NULL,
  message_id TEXT,
  host_id    TEXT    NOT NULL,
  bet        INTEGER NOT NULL,  -- 一口の額。ボタンを押すたび1口ずつ賭ける
  status     TEXT    NOT NULL,  -- joining / playing / done / cancelled
  state      TEXT    NOT NULL DEFAULT '{}',
  version    INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chohan_open ON chohan_tables (status, expires_at);
