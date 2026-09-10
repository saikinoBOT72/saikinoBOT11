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
 *
 * 【いつも一番下にいる】
 * 報告すると「○○が報告しました！」がチャンネルに流れる。放っておくと
 * パネルがどんどん上へ押し上げられて、押すのにスクロールが要るようになる。
 * そこで報告のあと、古いパネルを消して下に貼り直す。
 * どのメッセージがパネルなのかは report_panels テーブルが覚えている。
 */
import { listActivities, getActivity } from '../lib/activities.js';
import { attemptReport, reportEmbed } from '../lib/reporting.js';
import { coins, truncate } from '../lib/format.js';
import { describeDayStart } from '../lib/calendar.js';
import { ButtonStyle } from '../discord/constants.js';
import { button, embed, row } from '../discord/builders.js';
import { reply } from '../discord/respond.js';

const now = () => Math.floor(Date.now() / 1000);

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

/* ------------------------------------------------ どこに貼ったかを覚える */

export async function rememberPanel(db, guildId, channelId, messageId) {
  await db.run(
    `INSERT INTO report_panels (guild_id, channel_id, message_id, updated_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(guild_id) DO UPDATE SET channel_id = ?2, message_id = ?3, updated_at = ?4`,
    guildId,
    channelId,
    messageId,
    now(),
  );
}

export function getPanel(db, guildId) {
  return db.get('SELECT channel_id, message_id FROM report_panels WHERE guild_id = ?1', guildId);
}

/**
 * 貼り直す権利を1人だけに渡す。
 * 同じ瞬間に2人が報告しても、パネルが2枚に増えないようにするため
 * 「message_id を空にできた人」だけが貼り直す。
 */
async function claimRestick(db, guildId, messageId) {
  const result = await db.run(
    'UPDATE report_panels SET message_id = NULL, updated_at = ?3 WHERE guild_id = ?1 AND message_id = ?2',
    guildId,
    messageId,
    now(),
  );
  return result.changes === 1;
}

/**
 * 報告をチャンネルに流したあと、パネルを一番下に貼り直す。
 * パネルが無いチャンネルなら何もしない（余計な通信をしない）。
 */
export async function restickPanel(ctx, guildId, channelId) {
  const panel = await getPanel(ctx.db, guildId);
  if (!panel || panel.channel_id !== channelId || !panel.message_id) return;

  // 先に中身を作る。作れなかった時に message_id を消してしまわないように
  const payload = await panelPayload(ctx, guildId);
  if (payload.error) return;

  if (!(await claimRestick(ctx.db, guildId, panel.message_id))) return;

  // 新しいほうを先に貼る。こうすればパネルが一瞬も消えない
  const message = await ctx.rest.createMessage(channelId, payload);
  await rememberPanel(ctx.db, guildId, channelId, message.id);
  await removeMessage(ctx, channelId, panel.message_id);
}

/** 消せなくても困らないので、失敗は握りつぶす（誰かが手で消していた等）。 */
async function removeMessage(ctx, channelId, messageId) {
  try {
    await ctx.rest.deleteMessage(channelId, messageId);
  } catch (error) {
    console.error('古い報告パネルを消せませんでした:', error);
  }
}

/**
 * 報告をみんなに見えるように流す。パネルのあるチャンネルなら貼り直しまで面倒を見る。
 * 順番が大事なので1本の流れにしてある（報告 → 貼り直し）。
 */
export function announceReport(ctx, { guildId, channelId, payload }) {
  if (!channelId) return;
  ctx.waitUntil(
    (async () => {
      await ctx.rest.createMessage(channelId, payload);
      await restickPanel(ctx, guildId, channelId);
    })(),
  );
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

  // みんなに見えるほうはチャンネルへ。そのあとパネルを下に貼り直す
  announceReport(ctx, {
    guildId: ix.guildId,
    channelId: ix.channelId,
    payload: {
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
    },
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
