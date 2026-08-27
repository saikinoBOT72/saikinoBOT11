/**
 * D1 を薄くラップして `get / all / run / batch` だけの小さな形にする。
 * テストでは同じ形の偽物（better-sqlite3 製）を差し込むので、
 * ロジック側は Cloudflare に依存しない。
 *
 * プレースホルダは `?1` `?2` の番号付きを使う（同じ値を何度も渡さずに済む）。
 */
export function wrapD1(d1) {
  const prepare = (sql, params) => (params.length > 0 ? d1.prepare(sql).bind(...params) : d1.prepare(sql));
  const meta = (result) => ({
    changes: result?.meta?.changes ?? 0,
    lastRowId: result?.meta?.last_row_id ?? null,
  });

  return {
    async get(sql, ...params) {
      return prepare(sql, params).first();
    },
    async all(sql, ...params) {
      const result = await prepare(sql, params).all();
      return result.results ?? [];
    },
    async run(sql, ...params) {
      return meta(await prepare(sql, params).run());
    },
    /**
     * 複数の文をひとつのトランザクションで実行する。
     * @param {Array<[string, ...unknown[]]>} statements
     */
    async batch(statements) {
      if (statements.length === 0) return [];
      const results = await d1.batch(statements.map(([sql, ...params]) => prepare(sql, params)));
      return results.map(meta);
    },
  };
}
