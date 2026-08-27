-- 修復用。
--
-- 0002 を「アクションごとの連続記録」に作り直したが、その前の版が既に適用済みの
-- データベースでは、CREATE TABLE IF NOT EXISTS が既存のテーブルを素通りしてしまい、
-- streaks / streak_rewards が古い形（activity 列なし）のまま残った。
-- ここで正しい形に作り直す。連続記録の途中経過は失われるが、数日分に留まる。
--
-- 新規のデータベースでは 0002 の直後に走るので、中身が空のまま作り直すだけになる。

DROP TABLE IF EXISTS streaks;
CREATE TABLE streaks (
  guild_id  TEXT    NOT NULL,
  user_id   TEXT    NOT NULL,
  activity  TEXT    NOT NULL,
  current   INTEGER NOT NULL DEFAULT 0,
  best      INTEGER NOT NULL DEFAULT 0,
  last_date TEXT,
  PRIMARY KEY (guild_id, user_id, activity)
);

DROP TABLE IF EXISTS streak_rewards;
CREATE TABLE streak_rewards (
  guild_id TEXT    NOT NULL,
  activity TEXT    NOT NULL,
  days     INTEGER NOT NULL,
  reward   INTEGER NOT NULL,
  PRIMARY KEY (guild_id, activity, days)
);

-- 称号・装備・定期発表のテーブルは、取りこぼしがあっても揃うようにしておく
CREATE TABLE IF NOT EXISTS profiles (
  guild_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  title_id INTEGER,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS announcements (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id      TEXT    NOT NULL,
  channel_id    TEXT    NOT NULL,
  metric        TEXT    NOT NULL,
  activity_name TEXT,
  frequency     TEXT    NOT NULL,
  weekday       INTEGER,
  hour          INTEGER NOT NULL,
  top_n         INTEGER NOT NULL DEFAULT 5,
  prize         INTEGER NOT NULL DEFAULT 0,
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_run_date TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_announce_enabled ON announcements (enabled, hour);

-- 旧版で作られた称号の条件名を、新しい名前に合わせる
UPDATE achievements SET condition_type = 'activity_count' WHERE condition_type = 'activity_reports';

-- 旧版の「連続日数（全アクション共通）」は対象アクションを持たないため、作り直してもらう
UPDATE profiles SET title_id = NULL
 WHERE title_id IN (SELECT id FROM achievements WHERE condition_type = 'streak');
DELETE FROM user_achievements
 WHERE achievement_id IN (SELECT id FROM achievements WHERE condition_type = 'streak');
DELETE FROM achievements WHERE condition_type = 'streak';
