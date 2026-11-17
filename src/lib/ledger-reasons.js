/**
 * コインの増減の「理由」を、人が読める日本語にする。
 *
 * 履歴には 'blackjack:win' のような短い符号で残している（あとから集計しやすいように）。
 * 画面に出すときだけ、ここで日本語に直す。
 * 「ゲーム:動き」の形はゲーム名と動きを別々に引くので、ゲームを増やしても
 * GAME_NAMES に1行足すだけで済む。
 */

/** 符号の前半（ゲームや機能の名前）。 */
export const GAME_NAMES = {
  slot: 'スロット',
  coinflip: 'コイントス',
  highlow: 'ハイ&ロー',
  doors: '運命の扉',
  rps: 'じゃんけん',
  chinchiro: 'チンチロ',
  rr: 'ロシアンルーレット',
  cs: 'チャージ＆シュート',
  mine: '地雷＆陣取り',
  duel: '1対1の勝負',
  blackjack: 'ブラックジャック',
  poker: '簡ポーカー',
  pig: 'ピッグ',
  chohan: '丁半博打',
  yacht: 'ヨット',
  lottery: '宝くじ',
  poll: '予想大会',
  bingo: 'ビンゴ',
  scratch: 'スクラッチ',
  roulette: 'ルーレット',
  shop: 'ショップ',
  admin: '管理者',
  tip: '投げ銭',
};

/** 符号の後半（何が起きたか）。 */
const ACTIONS = {
  bet: '賭け',
  ante: '参加費',
  call: '勝負に乗った',
  double: 'ダブルダウン',
  escrow: '預かり',
  win: '払い戻し',
  refund: '返金',
  buy: '購入',
  sell: '売上',
  bonus: '賞金の上乗せ',
  give: 'から受け取り',
  take: 'が回収',
  set: 'が調整',
  send: '送った',
  receive: 'もらった',
};

/** 動きの言葉をつなげずに、そのまま書きたいもの。 */
const SPECIAL = {
  initial: '初期残高',
  report: '報告',
  pay: '送金',
  streak: '連日ボーナス',
  achievement: '称号のボーナス',
  ranking: 'ランキングの賞金',
  'slot:win': 'スロット当選',
  'coinflip:win': 'コイントス的中',
  'rps:win': 'じゃんけん勝利',
  'shop:buy': 'ショップで購入',
  'shop:sell': 'ショップで売れた',
  'admin:give': '管理者から',
  'admin:take': '管理者が回収',
  'admin:set': '管理者が調整',
  'lottery:buy': '宝くじを購入',
  'lottery:win': '宝くじ当選',
};

/** 理由の符号だけを日本語にする。知らない符号はそのまま返す（壊れて見えるより良い）。 */
export function reasonText(reason) {
  if (SPECIAL[reason]) return SPECIAL[reason];
  const [game, action] = String(reason ?? '').split(':');
  const name = GAME_NAMES[game];
  if (!name) return reason;
  if (!action) return name;
  const word = ACTIONS[action];
  if (!word) return name;
  // 「管理者から受け取り」のように、名前に直接つなげる言葉もある
  return /^[からが]/.test(word) ? `${name}${word}` : `${name}（${word}）`;
}

/** 履歴1行ぶんの説明。報告や連日ボーナスは、何をしたかも添える。 */
export function reasonLabel(entry) {
  const base = reasonText(entry.reason);
  const showDetail = ['report', 'streak', 'achievement', 'admin:give', 'admin:take', 'admin:set'].includes(entry.reason);
  return entry.detail && showDetail ? `${base}（${entry.detail}）` : base;
}
