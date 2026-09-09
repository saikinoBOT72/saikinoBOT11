-- キャリーオーバー宝くじ。毎週日曜の夜に抽選し、当たりが出なければ次週に持ち越す。

-- サーバーごとの設定と、積み上がったキャリーオーバー。
CREATE TABLE IF NOT EXISTS lottery (
  guild_id      TEXT    PRIMARY KEY,
  channel_id    TEXT,                        -- 発表するチャンネル（未設定なら抽選しない）
  enabled       INTEGER NOT NULL DEFAULT 1,
  carryover     INTEGER NOT NULL DEFAULT 0,  -- 当たりが出ずに持ち越された分
  last_draw_key TEXT,                        -- 二重抽選を防ぐ 'YYYY-MM-DD'
  created_at    INTEGER NOT NULL
);

-- 買われた券。同じ回の同じ数字は1人しか買えない（主キーで保証する）。
CREATE TABLE IF NOT EXISTS lottery_tickets (
  guild_id   TEXT    NOT NULL,
  draw_key   TEXT    NOT NULL,  -- その回の締切日 'YYYY-MM-DD'
  number     INTEGER NOT NULL,  -- 0〜999
  user_id    TEXT    NOT NULL,
  price      INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, draw_key, number)
);
CREATE INDEX IF NOT EXISTS idx_lottery_owner ON lottery_tickets (guild_id, draw_key, user_id);

-- 過去の抽選結果。
CREATE TABLE IF NOT EXISTS lottery_draws (
  guild_id   TEXT    NOT NULL,
  draw_key   TEXT    NOT NULL,
  number     INTEGER NOT NULL,
  winner_id  TEXT,               -- 当たりが出なければ NULL
  prize      INTEGER NOT NULL,   -- 渡した額（当たりが出たときだけ）
  pool       INTEGER NOT NULL,   -- その回に集まった額
  carryover  INTEGER NOT NULL,   -- 抽選前に積み上がっていた額
  tickets    INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, draw_key)
);
