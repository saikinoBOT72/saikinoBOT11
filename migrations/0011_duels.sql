-- 1対1の対戦ゲーム共通の置き場。
-- ロシアンルーレット・チャージ＆シュート・地雷＆陣取り・運命の扉（2人）で使う。
-- ルールごとの中身は state（JSON）に入れ、同時押しは version の取り合いで防ぐ。
CREATE TABLE IF NOT EXISTS duels (
  id            TEXT    PRIMARY KEY,
  guild_id      TEXT    NOT NULL,
  channel_id    TEXT    NOT NULL,
  message_id    TEXT,
  game          TEXT    NOT NULL,  -- rr / cs / mine / doors
  challenger_id TEXT    NOT NULL,
  opponent_id   TEXT    NOT NULL,
  bet           INTEGER NOT NULL,
  escrow        INTEGER NOT NULL,  -- 1人あたり預かった額
  status        TEXT    NOT NULL,  -- pending / playing / done / cancelled
  turn          TEXT,              -- challenger / opponent / null（同時手番）
  state         TEXT    NOT NULL DEFAULT '{}',
  version       INTEGER NOT NULL DEFAULT 0,
  expires_at    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_duels_open ON duels (status, expires_at);

-- 運命の扉（1人プレイ）。途中でやめられるので進行中の勝負を持ち越す。1人1つ。
CREATE TABLE IF NOT EXISTS doors_games (
  guild_id   TEXT    NOT NULL,
  user_id    TEXT    NOT NULL,
  bet        INTEGER NOT NULL,
  multiplier REAL    NOT NULL DEFAULT 1,
  steps      INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
