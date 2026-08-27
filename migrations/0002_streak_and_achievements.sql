-- 連日ボーナス（ストリーク）と称号

-- 連続報告日数。日付は設定タイムゾーン基準の 'YYYY-MM-DD'
CREATE TABLE IF NOT EXISTS streaks (
  guild_id  TEXT    NOT NULL,
  user_id   TEXT    NOT NULL,
  current   INTEGER NOT NULL DEFAULT 0,
  best      INTEGER NOT NULL DEFAULT 0,
  last_date TEXT,
  PRIMARY KEY (guild_id, user_id)
);

-- 「N日連続でちょうど到達したらMコイン」を管理者が並べる
CREATE TABLE IF NOT EXISTS streak_rewards (
  guild_id TEXT    NOT NULL,
  days     INTEGER NOT NULL,
  reward   INTEGER NOT NULL,
  PRIMARY KEY (guild_id, days)
);

-- 管理者が作る称号
CREATE TABLE IF NOT EXISTS achievements (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id       TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  emoji          TEXT,
  description    TEXT,
  condition_type TEXT    NOT NULL,  -- total_reports / activity_reports / streak / balance
  threshold      INTEGER NOT NULL,
  activity_name  TEXT,              -- condition_type = activity_reports のときの対象
  reward         INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_achievement_name ON achievements (guild_id, name);

CREATE TABLE IF NOT EXISTS user_achievements (
  guild_id       TEXT    NOT NULL,
  user_id        TEXT    NOT NULL,
  achievement_id INTEGER NOT NULL,
  earned_at      INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id, achievement_id)
);
