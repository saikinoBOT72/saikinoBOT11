-- 釣りゲーム。ブラウザ側で釣って、成果は Discord の絵文字（fish_1〜fish_78）で見る。
--
-- 書き込み回数を抑えるため、次の形にしてある。
--  ・1回投げる  → players と sessions を1行ずつ更新（2書き込み）
--  ・取り込み   → catches に1行、dex を1行、players と sessions を更新（4書き込み）
-- 1時間に100回投げても 600 書き込みで、D1 の無料枠（10万/日）には遠く届かない。

-- 釣り人の持ち物。竿は1本だけ持てる（買い替え式）。
CREATE TABLE IF NOT EXISTS fishing_players (
  guild_id   TEXT    NOT NULL,
  user_id    TEXT    NOT NULL,
  rod        TEXT    NOT NULL DEFAULT 'bamboo',
  bait       INTEGER NOT NULL DEFAULT 0,
  casts      INTEGER NOT NULL DEFAULT 0,  -- 投げた回数
  landed     INTEGER NOT NULL DEFAULT 0,  -- 取り込めた回数
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

-- 釣った魚の在庫。同じ種類でも大きさが違うので1匹1行。売ると消える。
CREATE TABLE IF NOT EXISTS fishing_catches (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id  TEXT    NOT NULL,
  user_id   TEXT    NOT NULL,
  fish_id   INTEGER NOT NULL,
  size_mul  REAL    NOT NULL,  -- 0.5〜1.5
  price     INTEGER NOT NULL,  -- 釣った時点の売値
  caught_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fishing_catches_owner ON fishing_catches (guild_id, user_id, fish_id);

-- 図鑑。売っても残る記録。
CREATE TABLE IF NOT EXISTS fishing_dex (
  guild_id TEXT    NOT NULL,
  user_id  TEXT    NOT NULL,
  fish_id  INTEGER NOT NULL,
  count    INTEGER NOT NULL DEFAULT 0,
  best_mul REAL    NOT NULL DEFAULT 0,  -- いちばん大きかった個体
  first_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id, fish_id)
);

-- ブラウザとつなぐための合鍵。Discord の「URL発行」で作られる。
-- 進行中のあたりは pending（JSON）に入れ、nonce で使い回しを防ぐ。
CREATE TABLE IF NOT EXISTS fishing_sessions (
  token        TEXT    PRIMARY KEY,
  guild_id     TEXT    NOT NULL,
  user_id      TEXT    NOT NULL,
  display_name TEXT    NOT NULL,
  seat         INTEGER,           -- 0/1/2。座っていなければ NULL
  nonce        INTEGER NOT NULL DEFAULT 0,
  pending      TEXT,              -- 取り込み待ちのあたり（JSON）
  last_fish_id INTEGER,           -- 直近に釣った魚（島にいる人に見せる）
  last_size_mul REAL,
  last_catch_at INTEGER,
  seen_at      INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
-- 島にいる人の一覧を引くため
CREATE INDEX IF NOT EXISTS idx_fishing_sessions_island ON fishing_sessions (guild_id, seen_at);
-- 同じ人が二重にログインしたら古い方を消すため
CREATE INDEX IF NOT EXISTS idx_fishing_sessions_user ON fishing_sessions (guild_id, user_id);
