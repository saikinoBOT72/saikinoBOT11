/**
 * いま動いている版。デプロイのとき GitHub Actions が --var で入れる（deploy.yml）。
 *   BUILD_SHA  … コミットの先頭7文字
 *   BUILD_TIME … 反映した時刻（UTC の ISO 形式）
 *   BUILD_NOTE … コミットの1行目（何を変えたか）
 * 手元で動かしたときは入っていないので「不明」と出す。
 */
export function versionOf(env) {
  return {
    sha: env?.BUILD_SHA || null,
    time: env?.BUILD_TIME || null,
    note: env?.BUILD_NOTE || null,
  };
}

/** 管理画面に出す1行。 */
export function describeVersion(env) {
  const { sha, time } = versionOf(env);
  if (!sha) return '版: 不明（手元で動かしているか、デプロイ前）';
  const at = time ? Date.parse(time) : NaN;
  return Number.isFinite(at) ? `版: ${sha}（<t:${Math.floor(at / 1000)}:f> に反映）` : `版: ${sha}`;
}

/**
 * 前に見た版と違えば、新しい版になったと記録する（最初に気づいた1回だけ true）。
 * 1分ごとの見回りから呼ぶ。
 */
export async function claimNewVersion(db, env, now = Date.now()) {
  const { sha } = versionOf(env);
  if (!sha) return false;
  const changed = await db.run(
    `INSERT INTO app_state (key, value, updated_at) VALUES ('version', ?1, ?2)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
     WHERE app_state.value != excluded.value`,
    sha,
    now,
  );
  return changed.changes === 1;
}
