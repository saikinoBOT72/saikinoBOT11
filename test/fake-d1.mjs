// テスト用の偽 D1。better-sqlite3 を使って src/lib/sql.js と同じ形を提供する。
import Database from 'better-sqlite3';
import fs from 'node:fs';

export function createFakeD1(schemaPath) {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(fs.readFileSync(schemaPath, 'utf8'));

  const statement = (sql) => sqlite.prepare(sql);
  const toMeta = (info) => ({ changes: info.changes, lastRowId: Number(info.lastInsertRowid) });

  // D1 は ?1 ?2 … を「何番目に渡した値か」で解決するが、
  // better-sqlite3 は名前付きとして扱うので、番号をキーにしたオブジェクトへ変換する。
  const bindArgs = (sql, params) => {
    if (params.length === 0) return [];
    if (!/\?\d/.test(sql)) return params;
    return [Object.fromEntries(params.map((value, index) => [String(index + 1), value]))];
  };

  return {
    async get(sql, ...params) {
      return statement(sql).get(...bindArgs(sql, params)) ?? null;
    },
    async all(sql, ...params) {
      return statement(sql).all(...bindArgs(sql, params));
    },
    async run(sql, ...params) {
      return toMeta(statement(sql).run(...bindArgs(sql, params)));
    },
    async batch(statements) {
      const runAll = sqlite.transaction((list) =>
        list.map(([sql, ...params]) => toMeta(statement(sql).run(...bindArgs(sql, params)))),
      );
      return runAll(statements);
    },
    close() {
      sqlite.close();
    },
  };
}
