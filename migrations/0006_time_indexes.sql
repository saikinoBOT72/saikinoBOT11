-- 期間で区切る集計（ランキング発表など）が、そのサーバーの全履歴を
-- 舐めないようにする。履歴が伸びても読み取り量が増え続けないための索引。
CREATE INDEX IF NOT EXISTS idx_ledger_time ON ledger (guild_id, created_at);
CREATE INDEX IF NOT EXISTS idx_logs_time ON activity_logs (guild_id, created_at);
