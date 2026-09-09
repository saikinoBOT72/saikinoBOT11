/**
 * 地雷設置＆陣取りバトル。
 *
 * 3×3 の9マス。まず二人が**こっそり2つずつ地雷を埋め**、
 * そのあと交互にマスを取っていく。
 *
 * - 何もないマス → 自分の陣地になる
 * - **相手の地雷**を踏んだ → 爆発して、そのマスは**相手の陣地**になる
 * - 自分の地雷は不発。ふつうに自分の陣地になる
 *
 * 9マスは必ず誰かのものになるので引き分けはない。多く取ったほうが勝ち。
 */
export const SIZE = 3;
export const CELLS = SIZE * SIZE;
export const MINES_PER_PLAYER = 2;

export function emptyBoard() {
  return Array.from({ length: CELLS }, () => null);
}

/** 地雷を埋める。同じマスには2つ置けない。 */
export function placeMine(mines, cell) {
  if (cell < 0 || cell >= CELLS) return { ok: false, reason: 'range' };
  if (mines.includes(cell)) return { ok: false, reason: 'duplicate' };
  if (mines.length >= MINES_PER_PLAYER) return { ok: false, reason: 'full' };
  return { ok: true, mines: [...mines, cell] };
}

export function bothReady(mines) {
  return mines.challenger.length === MINES_PER_PLAYER && mines.opponent.length === MINES_PER_PLAYER;
}

/**
 * マスを取る。
 * @returns {{owner: 'challenger'|'opponent', exploded: boolean}}
 */
export function claim(cell, role, mines) {
  const enemy = role === 'challenger' ? 'opponent' : 'challenger';
  const exploded = mines[enemy].includes(cell);
  return { owner: exploded ? enemy : role, exploded };
}

export function countOwned(board, role) {
  return board.filter((owner) => owner === role).length;
}

export function isOver(board) {
  return board.every((owner) => owner !== null);
}

/** 取ったマスが多いほうが勝ち。9マスなので引き分けにはならない。 */
export function leader(board) {
  const challenger = countOwned(board, 'challenger');
  const opponent = countOwned(board, 'opponent');
  if (challenger === opponent) return 'draw';
  return challenger > opponent ? 'challenger' : 'opponent';
}
