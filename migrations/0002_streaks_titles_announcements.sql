-- 連日ボーナス（アクションごと）・称号・称号の装備・定期発表

-- アクションごとの連続報告日数。日付は設定タイムゾーン基準の 'YYYY-MM-DD'
CREATE TABLE IF NOT EXISTS streaks (
  guild_id  TEXT    NOT NULL,
  user_id   TEXT    NOT NULL,
  activity  TEXT    NOT NULL,
  current   INTEGER NOT NULL DEFAULT 0,
  best      INTEGER NOT NULL DEFAULT 0,
  last_date TEXT,
  PRIMARY KEY (guild_id, user_id, activity)
);

-- 「このアクションをN日連続でMコイン」を管理者が並べる
CREATE TABLE IF NOT EXISTS streak_rewards (
  guild_id TEXT    NOT NULL,
  activity TEXT    NOT NULL,
  days     INTEGER NOT NULL,
  reward   INTEGER NOT NULL,
  PRIMARY KEY (guild_id, activity, days)
);

-- 管理者が作る称号
CREATE TABLE IF NOT EXISTS achievements (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id       TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  emoji          TEXT,
  description    TEXT,
  condition_type TEXT    NOT NULL,  -- activity_count / activity_streak / total_reports / balance
  threshold      INTEGER NOT NULL,
  activity_name  TEXT,              -- アクション条件のときの対象
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

-- 名前の横に出す称号（1人1つ）
CREATE TABLE IF NOT EXISTS profiles (
  guild_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  title_id INTEGER,
  PRIMARY KEY (guild_id, user_id)
);

-- 定期発表するランキング
CREATE TABLE IF NOT EXISTS announcements (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id      TEXT    NOT NULL,
  channel_id    TEXT    NOT NULL,
  metric        TEXT    NOT NULL,  -- balance / earned / activity_count / activity_total / activity_streak
  activity_name TEXT,              -- 空なら全アクション合計
  frequency     TEXT    NOT NULL,  -- daily / weekly
  weekday       INTEGER,           -- weekly のとき 0=日曜 … 6=土曜
  hour          INTEGER NOT NULL,  -- 設定タイムゾーンの時（0-23）
  top_n         INTEGER NOT NULL DEFAULT 5,
  prize         INTEGER NOT NULL DEFAULT 0,
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_run_date TEXT,              -- 二重投稿を防ぐ 'YYYY-MM-DD'
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_announce_enabled ON announcements (enabled, hour);
