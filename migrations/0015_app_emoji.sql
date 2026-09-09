-- Developer Portal に登録したアプリケーション絵文字の控え。
-- 名前から <:名前:数字> を引くために、管理メニューの「取り込む」で保存する。
-- Discord 側が正なので、ここは消えても取り込み直せばよい。
CREATE TABLE IF NOT EXISTS app_emoji (
  name       TEXT PRIMARY KEY,  -- 小文字にそろえた絵文字名
  code       TEXT NOT NULL,     -- <:名前:数字> または <a:名前:数字>
  updated_at INTEGER NOT NULL
);
