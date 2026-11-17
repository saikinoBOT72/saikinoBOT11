/**
 * みんなが書き込む文字（商品名・説明・お題・選択肢・送金メモ・称号名など）を整える。
 *
 * 【何を防ぐか】
 * ・偽のリンク：`[公式サイト](https://あやしい.example)` と書くと、embed の中では
 *   「公式サイト」とだけ見えて、押すと別の場所へ飛ぶ。URL をそのまま見せる形に直す。
 * ・見えない文字：幅ゼロの文字や、文字の並びを逆にする制御文字で、
 *   名前を本物そっくりに見せたり、表示を崩したりできる。取り除く。
 * ・@everyone / @here：通知は allowed_mentions で止めているが、文字として残ると
 *   それらしく見えるので、全角の ＠ に置き換える。
 *
 * どれも「消してしまう」より「見た目で分かる形に直す」を優先する。
 */

/**
 * 幅ゼロの文字・向きを変える制御文字・改行以外の制御文字。
 * 絵文字をつなぐ U+200D（👨‍👩‍👧 など）と、絵文字の見た目を選ぶ U+FE0F は残す。
 */
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0E\uFEFF\uFFA0]/g;

/** 見た目のリンク `[見える文字](URL)` を「見える文字（URL）」に直す。 */
function unmaskLinks(text) {
  return text.replace(/\[([^\]]*)\]\(\s*<?([^)\s>]+)>?\s*\)/g, (_, label, url) => `${label}（${url}）`);
}

function neutralizeMassMentions(text) {
  return text.replace(/@(everyone|here)/gi, '＠$1');
}

/**
 * 複数行の文（説明・選択肢の一覧など）。改行は残し、空行の続きすぎは詰める。
 * @returns {string|null} 空になったら null
 */
export function cleanText(text, { max = 1000 } = {}) {
  if (text == null) return null;
  const cleaned = neutralizeMassMentions(unmaskLinks(String(text).normalize('NFC').replace(INVISIBLE, '')))
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (cleaned === '') return null;
  return [...cleaned].slice(0, max).join('');
}

/** 1行の名前（商品名・称号名・アクション名・お題など）。改行は空白にする。 */
export function cleanLine(text, { max = 100 } = {}) {
  const cleaned = cleanText(text, { max: max * 2 });
  if (!cleaned) return null;
  const line = cleaned.replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return line === '' ? null : [...line].slice(0, max).join('');
}

/**
 * コインを現金や電子マネーと交換する出品に見えるか。
 *
 * コインに現実のお金の価値を持たせると、遊びのポイントではなく賭博の道具になってしまう
 * （Discord の規約でも、日本の刑法でも、ここが分かれ目）。README の運用ルールでも禁止している。
 * 「1回おごり」「肩たたき券」のような身内のやり取りは止めない。
 * @returns {string|null} 引っかかった言葉。問題なければ null
 */
export function realMoneyWord(text) {
  if (!text) return null;
  const normalized = String(text)
    .normalize('NFKC')
    .replace(/[\s　]/g, '')
    .toLowerCase();
  const patterns = [
    [/\d[\d,]*円/, '「〇〇円」'],
    [/現金|換金|キャッシュバック|送金して|振込|振り込/, '現金'],
    [/paypay|ペイペイ|楽天ペイ|linepay|メルペイ|aupay|d払い|suica|pasmo|nanaco|waon|edy/, '電子マネー'],
    [/ギフト(券|カード|コード)|アマギフ|amazonギフト|itunes|googleplay|apple(gift|ギフト)/, 'ギフト券'],
    [/rmt|リアルマネー|仮想通貨|暗号資産|ビットコイン|bitcoin|btc/, '現実のお金'],
  ];
  for (const [pattern, word] of patterns) {
    if (pattern.test(normalized)) return word;
  }
  return null;
}
