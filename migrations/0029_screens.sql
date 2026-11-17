-- 画面ごとの改善に使う列と表。

-- 【報告の取り消し（5分以内）】
-- 取り消すときに、連日ボーナスと連続記録も元に戻し、チャンネルに出た報告も書き換えるための控え。
ALTER TABLE activity_logs ADD COLUMN bonus INTEGER NOT NULL DEFAULT 0;     -- この報告で出た連日ボーナス
ALTER TABLE activity_logs ADD COLUMN streak_before TEXT;                   -- 報告前の連続記録（JSON）
ALTER TABLE activity_logs ADD COLUMN post_channel_id TEXT;                 -- チャンネルに出た報告
ALTER TABLE activity_logs ADD COLUMN post_message_id TEXT;

-- 【受け渡しの管理】使われたアイテムを、出品者が「対応した」と押した時刻。
ALTER TABLE purchases ADD COLUMN delivered_at INTEGER;

-- 【予想大会の正解を決める人】owner＝出題者 / admin＝サーバー管理者（出題者が自分で賭けたいとき）
ALTER TABLE polls ADD COLUMN judge TEXT NOT NULL DEFAULT 'owner';

-- 【隠し称号】条件を満たすまで、名前も条件も「？？？」で出す。
ALTER TABLE achievements ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;

-- 【プロフィールを見せるか】1 にすると、ほかの人からは見えない。
ALTER TABLE profiles ADD COLUMN hide_profile INTEGER NOT NULL DEFAULT 0;

-- 【1対1の勝ち負け】戦績（相手ごとの勝敗）と、勝利数の称号に使う。
-- これまでの勝負は記録していないので、この版から数える。
CREATE TABLE IF NOT EXISTS match_results (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id   TEXT    NOT NULL,
  game       TEXT    NOT NULL,   -- rps / cc / rr / cs / mine / doors
  winner_id  TEXT    NOT NULL,
  loser_id   TEXT    NOT NULL,
  amount     INTEGER NOT NULL,   -- 勝った人が受け取った額
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_match_winner ON match_results (guild_id, winner_id);
CREATE INDEX IF NOT EXISTS idx_match_loser ON match_results (guild_id, loser_id);

-- 【管理者による出品の取り下げ】1 なら、出品者が自分で再開できない。
ALTER TABLE shop_items ADD COLUMN taken_down INTEGER NOT NULL DEFAULT 0;
-- 出品者の「対応待ち」一覧を引くため。
CREATE INDEX IF NOT EXISTS idx_purchase_pending ON purchases (guild_id, seller_id, delivered_at, used_at);
