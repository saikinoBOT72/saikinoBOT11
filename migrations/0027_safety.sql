-- 安全まわりの直し。

-- 【1人用ゲームの同時押し対策】
-- ハイ&ローと運命の扉は「読んで → 払って → 消す」を別々にやっていたため、
-- 2台の端末で同時に「降りる」を押すと払い戻しが2回入った。
-- 版番号を持たせ、「読んだときの版のまま」でなければ進めないようにする。
ALTER TABLE highlow_games ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE doors_games ADD COLUMN version INTEGER NOT NULL DEFAULT 0;

-- 【釣りのデータを消す】
-- 釣りの機能は削除済み。読み書きするコードがもう無いので、
-- 本人が「自分のデータを削除」しても消せないデータになっていた。テーブルごと消す。
DROP TABLE IF EXISTS fishing_sessions;
DROP TABLE IF EXISTS fishing_dex;
DROP TABLE IF EXISTS fishing_catches;
DROP TABLE IF EXISTS fishing_players;

-- 【定期発表の集計期間】
-- auto     … 発表する時点で期間がまだ半分も過ぎていなければ、ひとつ前の期間（昨日・先週）を集計する
-- current  … いまの期間（今日・今週）
-- previous … ひとつ前の期間（昨日・先週）
-- これまでは必ず「いまの期間」だったので、月曜の朝に出す「今週の稼ぎ」が数時間ぶんしか入らなかった。
ALTER TABLE announcements ADD COLUMN period TEXT NOT NULL DEFAULT 'auto';

-- 【管理用チャンネル】
-- エラーや反映のお知らせを流す先。決めていなければどこにも流さない。
ALTER TABLE guild_settings ADD COLUMN log_channel_id TEXT;
