-- 報告パネルを置いた場所を覚えておく。
--
-- パネルと同じチャンネルに「○○が報告しました！」が流れると、
-- パネルがどんどん上へ押し上げられてボタンが押しにくくなる。
-- そこで報告のたびに古いパネルを消して下に貼り直す（いわゆる固定メッセージ）。
-- そのために、いまどのメッセージがパネルなのかを1サーバー1行で持っておく。
--
-- 書き込みは報告1回につき2回（貼り直す前の確保と、新しい message_id の記録）。
-- 報告そのものが1日に何百回も起きるものではないので、無料枠には影響しない。
CREATE TABLE IF NOT EXISTS report_panels (
  guild_id   TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  message_id TEXT,              -- 貼り直している最中は NULL
  updated_at INTEGER NOT NULL
);
