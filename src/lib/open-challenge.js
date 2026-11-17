/**
 * だれでも受けられる挑戦状。
 *
 * 相手を決めずに出すと、opponent_id に ANYONE を入れておく（Discord の ID は数字だけなので重ならない）。
 * 最初に「受けて立つ」を押した人が相手になる。取り合いは1つの UPDATE で決めるので、
 * 2人が同時に押しても相手になれるのは1人だけ。
 */
export const ANYONE = 'anyone';

export function isOpenChallenge(opponentId) {
  return opponentId === ANYONE;
}

/** 画面に出す相手の名前。 */
export function opponentLabel(opponentId) {
  return isOpenChallenge(opponentId) ? '**だれでも**' : `<@${opponentId}>`;
}

/** 押した人を相手に決める。取れたら true。 */
export async function claimOpenChallenge(db, table, id, userId) {
  const result = await db.run(
    `UPDATE ${table} SET opponent_id = ?2
      WHERE id = ?1 AND opponent_id = ?3 AND status = 'pending' AND challenger_id != ?2`,
    id,
    userId,
    ANYONE,
  );
  return result.changes === 1;
}

/** 出した人が、まだ誰も受けていない挑戦状を取り下げる。 */
export async function withdrawOpenChallenge(db, table, id, challengerId) {
  const result = await db.run(
    `UPDATE ${table} SET status = 'cancelled'
      WHERE id = ?1 AND challenger_id = ?2 AND opponent_id = ?3 AND status = 'pending'`,
    id,
    challengerId,
    ANYONE,
  );
  return result.changes === 1;
}
