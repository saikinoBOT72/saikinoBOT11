-- 予想大会に、出題者が自腹で上乗せする「賞金プール」を持たせる。
-- 山分けの原資は「参加者の賭け金 + 上乗せ」になる。
-- 正解者なし・不成立・中止のときは、上乗せぶんは出題者に返す。
ALTER TABLE polls ADD COLUMN bonus INTEGER NOT NULL DEFAULT 0;
