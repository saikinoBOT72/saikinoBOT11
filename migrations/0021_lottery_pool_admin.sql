-- 宝くじの元金をサーバーごとに持たせる。
--
-- これまで元金はコードの定数（SEED_POOL = 2000）だったので、
-- 身内の相場に合わせて変えられなかった。管理画面から触れるように列にする。
-- 既定値は今までと同じ 2000 なので、何もしなければ挙動は変わらない。
--
-- 「持ち越し」（carryover）は今ある列をそのまま管理画面から書き換える。
ALTER TABLE lottery ADD COLUMN seed_pool INTEGER NOT NULL DEFAULT 2000;
