-- 報告メッセージの転送先。
--
-- 「このチャンネルでした報告は、あっちのチャンネルに出す」という対応を持つ。
-- 報告パネルを置いたチャンネルを、パネルだけの静かな場所に保てるようにするためのもの。
--
-- 1サーバーに何組でも置ける（転送元ごとに1行）。
-- 転送元が決まっていない報告は、これまで通りその場のチャンネルに出る。
CREATE TABLE IF NOT EXISTS report_routes (
  guild_id        TEXT    NOT NULL,
  from_channel_id TEXT    NOT NULL,  -- ここでした報告を
  to_channel_id   TEXT    NOT NULL,  -- ここに出す
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (guild_id, from_channel_id)
);
