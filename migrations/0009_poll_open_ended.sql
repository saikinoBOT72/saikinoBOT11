-- 締切なしの予想大会（出題者が締め切るまでずっと受け付ける）。
-- 締切なしのときは closes_at を使わないので 0 を入れ、この印で見分ける。
ALTER TABLE polls ADD COLUMN open_ended INTEGER NOT NULL DEFAULT 0;
