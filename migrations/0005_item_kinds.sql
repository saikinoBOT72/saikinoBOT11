-- アイテムに「使い切り」と「ずっと残る」の区別を持たせる。
-- いまあるアイテムと購入済みのものは、すべて使い切りとして扱う。

ALTER TABLE shop_items ADD COLUMN kind TEXT NOT NULL DEFAULT 'consumable';

-- 購入時点の種類を控えておく（出品が消えても持ち物として扱えるように）
ALTER TABLE purchases ADD COLUMN kind TEXT NOT NULL DEFAULT 'consumable';
-- 使い切りを使った日時。NULL なら未使用
ALTER TABLE purchases ADD COLUMN used_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_purchase_unused ON purchases (guild_id, buyer_id, item_id, used_at);
