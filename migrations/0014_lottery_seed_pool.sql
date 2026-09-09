-- 宝くじに元金を持たせる。
-- 誰も買っていなくても賞金がこの額から始まるようにして、1枚目を買う気にさせる。
-- 当たって払い出したあとも、またこの額から積み直す（コードの SEED_POOL と同じ値）。
UPDATE lottery SET carryover = 2000 WHERE carryover < 2000;
