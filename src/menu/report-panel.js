/**
 * 専用チャンネルに置きっぱなしにする報告パネル。
 *
 * ボタンだけのメッセージをチャンネルに1つ投げておけば、
 * `/menu` を開かなくてもワンタップで報告できる。
 * Discord のボタンは消さない限りずっと残るので、貼るのは一度きりでよい。
 *
 * 【メニューと分けている理由】
 * メニューのボタン（m:…）は押されたメッセージを書き換える作りになっている。
 * 同じ仕組みでパネルを作ると、誰かが押した瞬間にパネルが結果表示に化けて
 * 消えてしまう。なので専用の名前空間（rp:…）を持たせ、
 * パネルには一切触らず、押した本人にだけ結果を返す。
 */
import { listActivities, getActivity } from '../lib/activities.js';
import { attemptReport, reportEmbed } from '../lib/reporting.js';
import { coins, truncate } from '../lib/format.js';
import { describeDayStart } from '../lib/calendar.js';
import { ButtonStyle } from '../discord/constants.js';
import { button, embed, row } from '../discord/builders.js';
import { reply } from '../discord/respond.js';

export const PANEL_PREFIX = 'rp';
/** ボタンは1行5個 × 5行まで。 */
const MAX_BUTTONS = 25;

const doId = (name) => `${PANEL_PREFIX}:do:${name}`;

/**
 * チャンネルに置くパネルの中身。
 * アクションを増やしたら貼り直してもらう（古いパネルも押せば動く）。
 */
export async function panelPayload(ctx, guildId) {
  const settings = await ctx.settings(guildId);
  const activities = (await listActivities(ctx.db, guildId)).slice(0, MAX_BUTTONS);

  if (activities.length === 0) {
    return { error: 'まだアクションが登録されていません。先に 📋 アクション管理 で登録してください。' };
  }

  const lines = activities.map(
    (activity) => `${activity.emoji ?? '•'} **${activity.name}**　＋${settings.currency_emoji}${activity.reward}`,
  );

  const rows = [];
  for (let index = 0; index < activities.length; index += 5) {
    rows.push(
      row(
        ...activities.slice(index, index + 5).map((activity) =>
          button(doId(activity.name), truncate(activity.name, 20), {
            emoji: activity.emoji ?? undefined,
            style: ButtonStyle.SUCCESS,
          }),
        ),
      ),
    );
  }

  return {
    embeds: [
      embed({
        color: 0x2ecc71,
        title: '💪 報告パネル',
        description: `やったことのボタンを押すだけで報告できます。\n\n${lines.join('\n')}`,
        footer: {
          text: [describeDayStart(ctx.calendar), '結果は押した本人にだけ表示されます'].filter(Boolean).join(' ／ '),
        },
      }),
    ],
    components: rows,
  };
}

/**
 * パネルのボタンが押されたとき。
 * パネル自体は絶対に書き換えず、押した人にだけ短く返す。
 */
export async function handleComponent(ix, ctx) {
  const [, action] = ix.customId.split(':');
  if (action !== 'do') return reply({ content: 'この操作は使えません。' });

  // アクション名に : が入っていても壊れないよう、前置きだけ削って残りを名前とする
  const name = ix.customId.slice(`${PANEL_PREFIX}:do:`.length);
  const activity = await getActivity(ctx.db, ix.guildId, name);
  if (!activity) {
    return reply({ content: `「${name}」は無くなったようです。管理者にパネルの貼り直しを頼んでください。` });
  }

  const settings = await ctx.settings(ix.guildId);
  const result = await attemptReport(ctx.db, {
    guildId: ix.guildId,
    userId: ix.userId,
    activity,
    calendar: ctx.calendar,
  });
  if (!result.ok) return reply({ content: result.message });

  // みんなに見えるほうはチャンネルへ
  ctx.announce(ix.channelId, {
    embeds: [
      reportEmbed({
        user: ix.user,
        displayName: ix.displayName,
        avatarUrl: ix.avatar,
        activity,
        result,
        settings,
      }),
    ],
  });

  return reply({
    embeds: [
      embed({
        color: 0x2ecc71,
        title: `${activity.emoji ?? '✅'} ${activity.name} を報告しました`,
        description: `${coins(activity.reward, settings)} を獲得！\n所持金は ${coins(result.balance, settings)} です。`,
      }),
    ],
  });
}
