-- 遊べるゲームのオンオフ。
--
-- 管理メニューでオフにしたゲームの key を、カンマでつないだ文字列で持つ。
-- （例: 'rr,mine'）空なら全部オンで、これが既定。
--
-- 専用のテーブルを作らないのは、設定はどのみち毎回読んでいるから。
-- ここに置けば、ゲーム一覧を出すときも入口で弾くときも、D1 への問い合わせは増えない。
ALTER TABLE guild_settings ADD COLUMN disabled_games TEXT NOT NULL DEFAULT '';
