-- ヨット（ヤッツィー）。卓の出し入れは lib/card-table.js を流用。
--
-- スコアカードは state の中に入れて、本人だけに見せる。
-- ひとりで練習するときは bet = 0 の卓を立て、チャンネルには何も出さない
-- （message_id が NULL のまま進む）。
CREATE TABLE IF NOT EXISTS yacht_tables (
  id         TEXT    PRIMARY KEY,
  guild_id   TEXT    NOT NULL,
  channel_id TEXT    NOT NULL,
  message_id TEXT,
  host_id    TEXT    NOT NULL,
  bet        INTEGER NOT NULL,  -- 参加費。0 ならひとり練習
  status     TEXT    NOT NULL,  -- joining / playing / done / cancelled
  state      TEXT    NOT NULL DEFAULT '{}',
  version    INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_yacht_open ON yacht_tables (status, expires_at);

-- 自己ベスト。練習でも本番でも、1枚書き終えたら更新する。
CREATE TABLE IF NOT EXISTS yacht_records (
  guild_id   TEXT    NOT NULL,
  user_id    TEXT    NOT NULL,
  best       INTEGER NOT NULL DEFAULT 0,
  plays      INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
