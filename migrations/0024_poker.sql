-- 5枚ポーカーの卓。ブラックジャックの卓とまったく同じ形にしてある
-- （出し入れは lib/card-table.js で共通化している）。
--
-- 手札は state の中に入れる。公開のメッセージには一切出さず、
-- 「手札を見る」を押した本人にだけ返すことで隠す。
CREATE TABLE IF NOT EXISTS poker_tables (
  id         TEXT    PRIMARY KEY,
  guild_id   TEXT    NOT NULL,
  channel_id TEXT    NOT NULL,
  message_id TEXT,
  host_id    TEXT    NOT NULL,
  bet        INTEGER NOT NULL,  -- 参加費。勝負に乗るともう同額
  status     TEXT    NOT NULL,  -- joining / playing / done / cancelled
  state      TEXT    NOT NULL DEFAULT '{}',
  version    INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_poker_open ON poker_tables (status, expires_at);
