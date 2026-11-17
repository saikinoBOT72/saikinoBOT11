/**
 * ゲームの入口画面の「遊び方」を、2回目からは畳む。
 *
 * 入口の画面にはルールの説明が毎回ぜんぶ出ていて、慣れた人には長い。
 * はじめて開いたときだけ全文を見せ、2回目からは最初と最後の段落（所持金と「まず金額を選んで」）だけにして、
 * 「📖 遊び方」ボタンで全文を開けるようにする。読んだかどうかは seen_rules に残す。
 *
 * あわせて、どの画面にいるかを上に小さく出す（🏠 › 🎮 あそぶ › 🎰 スロット）。
 */
import { ButtonStyle, ComponentType } from '../discord/constants.js';
import { json } from '../discord/respond.js';
import { button, id } from './common.js';
import { GAME_BY_KEY } from '../lib/game-catalog.js';

/** はじめて開いたなら true（印を付ける）。2回目以降は false。 */
async function firstVisit(db, guildId, userId, game) {
  const marked = await db.run(
    'INSERT OR IGNORE INTO seen_rules (guild_id, user_id, game, seen_at) VALUES (?1, ?2, ?3, ?4)',
    guildId,
    userId,
    game,
    Date.now(),
  );
  return marked.changes === 1;
}

/** 金額や相手を選ぶ「入口」の画面か（進行中の勝負の画面は畳まない）。 */
function isEntryScreen(data) {
  for (const actionRow of data?.components ?? []) {
    for (const component of actionRow.components ?? []) {
      if (component.type === ComponentType.USER_SELECT) return true;
      if ((component.custom_id ?? '').endsWith(':custom') || /:custom:/.test(component.custom_id ?? '')) return true;
    }
  }
  return false;
}

function crumbOf(game) {
  return { name: `🏠 › 🎮 あそぶ › ${game.emoji} ${game.name}` };
}

/** 説明を最初と最後の段落だけにし、ルールの欄を外す。 */
function folded(embedObject) {
  const paragraphs = String(embedObject.description ?? '').split('\n\n').filter((text) => text.trim() !== '');
  const kept = paragraphs.length > 2 ? [paragraphs[0], paragraphs.at(-1)] : paragraphs;
  return {
    ...embedObject,
    description: `${kept.join('\n\n')}\n\n📖 ルールは下の「遊び方」ボタンから見られます。`,
    fields: (embedObject.fields ?? []).filter((field) => /所持金|いまの|あなたの/.test(field.name)),
  };
}

/** 「📖 遊び方」ボタンを、入るところに足す。 */
function withRulesButton(components, key) {
  const rulesButton = button(id(key, 'open', 'rules'), '遊び方', { emoji: '📖', style: ButtonStyle.SECONDARY });
  const rows = components.map((actionRow) => ({ ...actionRow, components: [...actionRow.components] }));
  const last = rows.at(-1);
  const onlyButtons = last?.components.every((component) => component.type === ComponentType.BUTTON);
  if (last && onlyButtons && last.components.length < 5) last.components.push(rulesButton);
  else if (rows.length < 5) rows.push({ type: ComponentType.ACTION_ROW, components: [rulesButton] });
  return rows;
}

/** 画面名の actions の open を包む。 */
export function foldRules(key, actions) {
  if (!actions.open) return actions;
  const game = GAME_BY_KEY.get(key);
  return {
    ...actions,
    async open(ix, args = [], ctx, notice = null) {
      const wantRules = args[0] === 'rules';
      const response = await actions.open(ix, wantRules ? [] : args, ctx, notice);
      const body = await response.clone().json().catch(() => null);
      const data = body?.data;
      const first = data?.embeds?.[0];
      if (!first || !game) return response;

      const withCrumb = { ...first, author: first.author ?? crumbOf(game) };
      const entry = isEntryScreen(data);
      const showAll = wantRules || !entry || (ix.guildId && (await firstVisit(ctx.db, ix.guildId, ix.userId, key)));

      const nextData = showAll
        ? { ...data, embeds: [withCrumb, ...data.embeds.slice(1)] }
        : { ...data, embeds: [folded(withCrumb), ...data.embeds.slice(1)], components: withRulesButton(data.components ?? [], key) };
      return json({ ...body, data: nextData });
    },
  };
}

/**
 * 画面の上に「いまどこにいるか」を小さく出す（すでに名前などを出している画面はそのまま）。
 * 管理・ショップ・報告のように、奥へ何段も入っていく画面に使う。
 */
export function withCrumb(label, actions) {
  return Object.fromEntries(
    Object.entries(actions).map(([name, handler]) => [
      name,
      async (ix, args, ctx, ...rest) => {
        const response = await handler(ix, args, ctx, ...rest);
        const body = await response.clone().json().catch(() => null);
        const first = body?.data?.embeds?.[0];
        if (!first || first.author || (body.type !== 4 && body.type !== 7)) return response;
        return json({ ...body, data: { ...body.data, embeds: [{ ...first, author: { name: label } }, ...body.data.embeds.slice(1)] } });
      },
    ]),
  );
}
