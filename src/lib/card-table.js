/**
 * 「卓」の出し入れの共通部分。
 *
 * ブラックジャックとポーカーは、卓を立てて・人が座って・進めて・精算する
 * という流れがまったく同じで、違うのは中身（state）だけ。
 * その共通部分だけをここに置き、テーブル名と初期状態を渡して使い回す。
 *
 * 同時押し対策も共通。読んだときの version のままでなければ書けないようにして、
 * 二人が同時に押しても手札や手番がすり替わらないようにする（duel.mutate と同じ考え方）。
 *
 * ゲームごとの中身（配り方・役・精算）は、それぞれのファイルが持つ。
 */

/**
 * @param {string} tableName D1 のテーブル名
 * @param {object} options
 * @param {() => object} options.emptyState 卓を立てたときの中身
 * @param {number} options.joinTimeoutMs 人を待てる時間
 * @param {number} options.playTimeoutMs 始まってからの持ち時間
 */
export function createTableStore(tableName, { emptyState, joinTimeoutMs, playTimeoutMs }) {
  async function getTable(db, id) {
    return db.get(`SELECT * FROM ${tableName} WHERE id = ?1`, id);
  }

  function stateOf(table) {
    try {
      return JSON.parse(table.state);
    } catch {
      return emptyState();
    }
  }

  async function createTable(db, { id, guildId, channelId, hostId, bet }) {
    const now = Date.now();
    await db.run(
      `INSERT INTO ${tableName} (id, guild_id, channel_id, host_id, bet, status, state, expires_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'joining', ?6, ?7, ?8)`,
      id,
      guildId,
      channelId,
      hostId,
      bet,
      JSON.stringify(emptyState()),
      now + joinTimeoutMs,
      now,
    );
    return getTable(db, id);
  }

  async function setMessageId(db, id, messageId) {
    await db.run(`UPDATE ${tableName} SET message_id = ?2 WHERE id = ?1`, id, messageId);
  }

  async function setStatus(db, id, status) {
    await db.run(`UPDATE ${tableName} SET status = ?2 WHERE id = ?1`, id, status);
  }

  /**
   * 状態を安全に書き換える。書けなかったら読み直してやり直す。
   * @returns {Promise<{ok: true, table: object, state: object, extra?: any} | {ok: false, reason: string}>}
   */
  async function mutate(db, id, apply, { allow = ['joining', 'playing'], attempts = 6 } = {}) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const table = await getTable(db, id);
      if (!table) return { ok: false, reason: 'missing' };
      if (!allow.includes(table.status)) return { ok: false, reason: 'closed' };

      const result = apply({ table, state: stateOf(table) });
      if (result?.reject) return { ok: false, reason: result.reject };

      const playing = result.status === 'playing' || table.status === 'playing';
      const written = await db.run(
        `UPDATE ${tableName} SET state = ?3, status = ?4, version = version + 1, expires_at = ?5
          WHERE id = ?1 AND version = ?2`,
        id,
        table.version,
        JSON.stringify(result.state),
        result.status ?? table.status,
        Date.now() + (playing ? playTimeoutMs : joinTimeoutMs),
      );
      if (written.changes === 1) {
        return { ok: true, table: await getTable(db, id), state: result.state, extra: result.extra };
      }
    }
    return { ok: false, reason: 'busy' };
  }

  /** 時間切れの卓（1分ごとの定期処理から拾う）。 */
  async function expiredTables(db, now = Date.now()) {
    return db.all(
      `SELECT * FROM ${tableName} WHERE status IN ('joining', 'playing') AND expires_at <= ?1 LIMIT 25`,
      now,
    );
  }

  return { createTable, getTable, stateOf, setMessageId, setStatus, mutate, expiredTables };
}
