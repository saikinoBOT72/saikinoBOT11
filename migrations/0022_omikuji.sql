-- 1日1回のおみくじ。コインは動かさないので、残高や台帳には触らない。
--
-- 引いた結果をそのまま残すのは、同じ日に開き直したときに同じものを見せるため。
-- 文そのものではなく添字（picks）で持つので、あとから文言を直しても過去の記録が壊れない。
--
-- 書き込みは1人1日1回だけ。読みも画面を開いたときの1回だけなので、無料枠には響かない。
CREATE TABLE IF NOT EXISTS omikuji_draws (
  guild_id    TEXT    NOT NULL,
  user_id     TEXT    NOT NULL,
  draw_date   TEXT    NOT NULL,  -- 'YYYY-MM-DD'（DAY_START_HOUR で区切った日付）
  rank        TEXT    NOT NULL,  -- 総合運の名前
  picks       TEXT    NOT NULL,  -- [{tier, index}] を6項目ぶん
  number      INTEGER NOT NULL,  -- ラッキーナンバー 0〜999
  item_index  INTEGER NOT NULL,
  color_index INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id, draw_date)
);
