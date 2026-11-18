/**
 * Components V2（Discord の新しいメッセージの形）。
 *
 * 【使いどころを絞っている理由】
 * この形で一度送ったメッセージは、あとから embed の形に戻せない（編集でも外せない）。
 * メニューは同じメッセージを画面ごとに書き換えていくので、ここでは使わない。
 * 送ったきり書き換えない投稿（ランキングの定期発表など）だけに使う。
 *
 * 【メンションに注意】
 * embed の中の <@id> は通知が鳴らないが、Text Display の中では allowed_mentions どおりに鳴る。
 * なので呼ぶ側は必ず allowed_mentions を自分で決めて渡す（ここでは何も鳴らさない形を既定にする）。
 */
import { ComponentType, MessageFlags } from './constants.js';

const text = (content) => ({ type: ComponentType.TEXT_DISPLAY, content });
const separator = () => ({ type: ComponentType.SEPARATOR, divider: true, spacing: 1 });

/** Text Display に入れられる文字の合計（1メッセージあたり）。 */
const MAX_TEXT = 4000;

/**
 * embed を、色つきの枠（Container）に入れた V2 の投稿に作り直す。
 * @param {object} source embed
 * @param {{header?: string, mentions?: string[]}} options header は枠の上に出す一言、mentions は鳴らしてよい人
 */
export function embedToV2(source, { header, mentions = [] } = {}) {
  const parts = [];
  if (source.author?.name) parts.push(text(`-# ${source.author.name}`));
  if (source.title) parts.push(text(`## ${source.title}`));
  if (source.description) parts.push(text(source.description));
  for (const field of source.fields ?? []) parts.push(text(`**${field.name}**\n${field.value}`));
  if (source.footer?.text) parts.push(separator(), text(`-# ${source.footer.text}`));

  // 文字が多すぎると送れないので、はみ出すぶんは後ろから削る
  let budget = MAX_TEXT - (header?.length ?? 0);
  const fitted = [];
  for (const part of parts) {
    if (part.type !== ComponentType.TEXT_DISPLAY) {
      fitted.push(part);
      continue;
    }
    if (budget <= 0) break;
    const content = part.content.length > budget ? `${part.content.slice(0, Math.max(0, budget - 1))}…` : part.content;
    budget -= content.length;
    fitted.push(text(content));
  }

  const container = { type: ComponentType.CONTAINER, components: fitted };
  if (typeof source.color === 'number') container.accent_color = source.color;
  return {
    flags: MessageFlags.IS_COMPONENTS_V2,
    components: [header ? text(header) : null, container].filter(Boolean),
    allowed_mentions: mentions.length > 0 ? { users: mentions } : { parse: [] },
  };
}
