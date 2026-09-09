-- サーバーごとの絵文字の差し替え。
-- 既定は Unicode の絵文字。カスタム絵文字を作ったら <:name:id> をここに入れて上書きする。
CREATE TABLE IF NOT EXISTS guild_emoji (
  guild_id TEXT NOT NULL,
  slot     TEXT NOT NULL,  -- lib/emoji.js の SLOTS のキー
  value    TEXT NOT NULL,  -- '🎲' か '<:dice1:123456789012345678>'
  PRIMARY KEY (guild_id, slot)
);
