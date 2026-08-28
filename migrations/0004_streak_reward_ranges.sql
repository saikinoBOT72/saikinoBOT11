-- 連日ボーナスを「ちょうどN日目に1回」から「X日目〜Y日目のあいだは毎日」に変更する。
-- 既存の設定は「X日目〜X日目」（＝その日だけ）として引き継ぐ。

CREATE TABLE streak_rewards_ranges (
  guild_id  TEXT    NOT NULL,
  activity  TEXT    NOT NULL,
  from_days INTEGER NOT NULL,
  to_days   INTEGER NOT NULL DEFAULT 0,  -- 0 = 上限なし（それ以降ずっと）
  reward    INTEGER NOT NULL,
  PRIMARY KEY (guild_id, activity, from_days)
);

INSERT INTO streak_rewards_ranges (guild_id, activity, from_days, to_days, reward)
  SELECT guild_id, activity, days, days, reward FROM streak_rewards;

DROP TABLE streak_rewards;
ALTER TABLE streak_rewards_ranges RENAME TO streak_rewards;
