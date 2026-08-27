// テスト用の偽 D1。better-sqlite3 を使って src/lib/sql.js と同じ形を提供する。
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

/** migrations/ の .sql を番号順にすべて流し込んで、本番と同じテーブルを作る。 */
export function createFakeD1(migrationsDir) {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const files = fs.readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();
  if (files.length === 0) throw new Error(`マイグレーションが見つかりません: ${migrationsDir}`);
  for (const file of files) sqlite.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));

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
