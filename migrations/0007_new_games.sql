-- ハイ&ロー・チンチロ・予想大会

-- ハイ&ローは途中でやめられるので、進行中の勝負を持ち越す。1人1つ。
CREATE TABLE IF NOT EXISTS highlow_games (
  guild_id   TEXT    NOT NULL,
  user_id    TEXT    NOT NULL,
  bet        INTEGER NOT NULL,
  card_rank  INTEGER NOT NULL,
  card_suit  TEXT    NOT NULL,
  multiplier REAL    NOT NULL DEFAULT 1,
  steps      INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

-- チンチロの1対1。動く可能性のある最大額（賭け金×5）を先に預かる。
CREATE TABLE IF NOT EXISTS chinchiro_matches (
  id              TEXT    PRIMARY KEY,
  guild_id        TEXT    NOT NULL,
  channel_id      TEXT    NOT NULL,
  message_id      TEXT,
  challenger_id   TEXT    NOT NULL,
  opponent_id     TEXT    NOT NULL,
  bet             INTEGER NOT NULL,
  escrow          INTEGER NOT NULL,
  status          TEXT    NOT NULL,  -- pending / playing / done / cancelled
  turn            TEXT,              -- challenger / opponent（次に振る人）
  challenger_dice TEXT,              -- 出目のJSON
  opponent_dice   TEXT,
  expires_at      INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chinchiro_open ON chinchiro_matches (status, expires_at);

-- 予想大会。お題に選択肢を立て、賭けを集めて正解者で山分けする。
CREATE TABLE IF NOT EXISTS polls (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id   TEXT    NOT NULL,
  channel_id TEXT    NOT NULL,
  message_id TEXT,
  owner_id   TEXT    NOT NULL,
  question   TEXT    NOT NULL,
  mode       TEXT    NOT NULL,          -- free（自由額・比例配分）/ fixed（固定額・等分）
  stake      INTEGER NOT NULL DEFAULT 0, -- fixed のときの参加費
  status     TEXT    NOT NULL,          -- open / closed / settled / cancelled
  answer     INTEGER,                   -- 正解の選択肢番号
  closes_at  INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_polls_open ON polls (status, closes_at);

CREATE TABLE IF NOT EXISTS poll_options (
  poll_id INTEGER NOT NULL,
  idx     INTEGER NOT NULL,
  label   TEXT    NOT NULL,
  PRIMARY KEY (poll_id, idx)
);

CREATE TABLE IF NOT EXISTS poll_bets (
  poll_id    INTEGER NOT NULL,
  user_id    TEXT    NOT NULL,
  option_idx INTEGER NOT NULL,
  amount     INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (poll_id, user_id)
);
