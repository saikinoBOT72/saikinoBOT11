-- 身内用 Discord Bot のデータベース（Cloudflare D1 / SQLite）
CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id         TEXT PRIMARY KEY,
  currency_name    TEXT    NOT NULL DEFAULT 'コイン',
  currency_emoji   TEXT    NOT NULL DEFAULT '🪙',
  starting_balance INTEGER NOT NULL DEFAULT 100,
  min_bet          INTEGER NOT NULL DEFAULT 1,
  max_bet          INTEGER NOT NULL DEFAULT 1000
);

CREATE TABLE IF NOT EXISTS balances (
  guild_id TEXT    NOT NULL,
  user_id  TEXT    NOT NULL,
  balance  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);

-- コインの増減はすべてここに残す（追跡用）
CREATE TABLE IF NOT EXISTS ledger (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id   TEXT    NOT NULL,
  user_id    TEXT    NOT NULL,
  amount     INTEGER NOT NULL,
  reason     TEXT    NOT NULL,
  detail     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger (guild_id, user_id, id DESC);

CREATE TABLE IF NOT EXISTS activities (
  guild_id     TEXT    NOT NULL,
  name         TEXT    NOT NULL,
  emoji        TEXT,
  reward       INTEGER NOT NULL,
  cooldown_sec INTEGER NOT NULL DEFAULT 0,
  daily_limit  INTEGER NOT NULL DEFAULT 0,
  description  TEXT,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (guild_id, name)
);

CREATE TABLE IF NOT EXISTS activity_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id   TEXT    NOT NULL,
  user_id    TEXT    NOT NULL,
  activity   TEXT    NOT NULL,
  reward     INTEGER NOT NULL,
  note       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_user ON activity_logs (guild_id, user_id, activity, created_at DESC);

CREATE TABLE IF NOT EXISTS shop_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id    TEXT    NOT NULL,
  seller_id   TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  description TEXT,
  price       INTEGER NOT NULL,
  image_url   TEXT,
  stock       INTEGER NOT NULL DEFAULT -1,   -- -1 = 無制限
  sold        INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shop_guild ON shop_items (guild_id, active, created_at DESC);

CREATE TABLE IF NOT EXISTS purchases (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id   TEXT    NOT NULL,
  item_id    INTEGER NOT NULL,
  buyer_id   TEXT    NOT NULL,
  seller_id  TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  price      INTEGER NOT NULL,
  image_url  TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_purchase_buyer ON purchases (guild_id, buyer_id, created_at DESC);

-- じゃんけん。時間切れは1分ごとの定期実行で返金する
CREATE TABLE IF NOT EXISTS rps_matches (
  id              TEXT PRIMARY KEY,
  guild_id        TEXT    NOT NULL,
  channel_id      TEXT    NOT NULL,
  message_id      TEXT,
  challenger_id   TEXT    NOT NULL,
  opponent_id     TEXT    NOT NULL,
  bet             INTEGER NOT NULL,
  status          TEXT    NOT NULL,          -- pending / playing / done / cancelled
  challenger_hand TEXT,
  opponent_hand   TEXT,
  round           INTEGER NOT NULL DEFAULT 1,
  expires_at      INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rps_open ON rps_matches (status, expires_at);
