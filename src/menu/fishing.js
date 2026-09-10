/**
 * 🎣 釣りの画面。ショップ（餌・竿）、図鑑、売却、ゲームのURL発行。
 *
 * 実際に釣るのはブラウザ側。ここは「持ち物とお金」を扱う入口になっている。
 * 釣った魚は在庫に溜まり、売って初めてコインになる。
 */
import { ButtonStyle } from '../discord/constants.js';
import { getBalance, deposit, withdraw } from '../lib/economy.js';
import { coins } from '../lib/format.js';
import {
  BAIT_PACKS, BAIT_PRICE, FISH, FISH_BY_ID, RARITY, RODS, RODS_BY_KEY,
  actualSize, expectedPerHour, fishSlot, rodRank, sizeLabel,
} from '../lib/fishing.js';
import * as store from '../lib/fishing-store.js';
import { button, embed, id, row, show, withNotice } from './common.js';

const PAGE = 26;   // 図鑑1ページの魚の数

/**
 * 釣りは試運転中なので、管理者だけが開ける。
 * ボタンを隠すだけでは custom_id を打てば入れてしまうので、入口で弾く。
 */
function guard(handler) {
  return async (ix, args, ctx) => {
    if (!ix.isAdmin) {
      const { openHome } = await import('./router.js');
      return openHome(ix, [], ctx, '釣りはまだ試運転中です。');
    }
    return handler(ix, args, ctx);
  };
}

/** 戻る先。ホームと同じ宛先のボタンを2つ置くと Discord に弾かれるので、行き先を分ける。 */
function backTo(screen) {
  return button(id(screen, 'open'), '戻る', { emoji: '◀️' });
}

function homeButton() {
  return button(id('home', 'open'), 'メニュー', { emoji: '🏠' });
}

/** 魚の絵文字。まだ登録していなければ素の魚で代用する。 */
function fishEmoji(emoji, fishId) {
  return emoji[fishSlot(fishId)] ?? '🐟';
}

/* ------------------------------------------------------------------ 入口 */

export async function open(ix, _args, ctx, notice = null) {
  const settings = await ctx.settings(ix.guildId);
  const [balance, player, held, dex] = await Promise.all([
    getBalance(ctx.db, ix.guildId, ix.userId),
    store.getPlayer(ctx.db, ix.guildId, ix.userId),
    store.countInventory(ctx.db, ix.guildId, ix.userId),
    store.dexOf(ctx.db, ix.guildId, ix.userId),
  ]);
  const rod = RODS_BY_KEY.get(player.rod) ?? RODS[0];
  const worth = await store.inventorySummary(ctx.db, ix.guildId, ix.userId);
  const total = worth.reduce((sum, line) => sum + line.total, 0);

  const main = embed({
    color: 0x1e6b7a,
    author: { name: ix.displayName, icon_url: ix.avatar },
    title: '🎣 釣り',
    description: [
      `所持金 ${coins(balance, settings)}`,
      `**${rod.name}**　🪱 餌 **${player.bait}** 個`,
      held > 0
        ? `クーラーボックス **${held}** 匹（売れば ${coins(total, settings)}）`
        : 'クーラーボックスは空です',
    ].join('\n'),
    fields: [
      { name: '図鑑', value: `**${dex.size}** / ${FISH.length} 種`, inline: true },
      { name: '投げた回数', value: `${player.casts.toLocaleString('ja-JP')} 回`, inline: true },
      { name: '釣り上げた数', value: `${player.landed.toLocaleString('ja-JP')} 匹`, inline: true },
    ],
    footer: { text: '実際に釣るのはブラウザです。「島へ行く」でURLを出せます' },
  });

  return show(ix, {
    embeds: [withNotice(main, notice)],
    components: [
      row(
        button(id('fish', 'url'), '島へ行く', { emoji: '🏝️', style: ButtonStyle.SUCCESS }),
        button(id('fish', 'shop'), '釣り具屋', { emoji: '🪱', style: ButtonStyle.PRIMARY }),
      ),
      row(
        button(id('fish', 'sell'), '魚を売る', { emoji: '💴', disabled: held === 0 }),
        button(id('fish', 'dex', '0'), '図鑑', { emoji: '📖' }),
      ),
      row(backTo('admin'), homeButton()),
    ],
  });
}

/* ------------------------------------------------------------------ URL発行 */

export async function url(ix, _args, ctx) {
  const token = await store.issueSession(ctx.db, ix.guildId, ix.userId, ix.displayName);
  const origin = ctx.origin ?? '';
  // 合鍵は # の後ろに置く。こうするとサーバーのログにも Referer にも残らない。
  const link = `${origin}/play/#${token}`;

  return show(ix, {
    embeds: [
      embed({
        color: 0x1e6b7a,
        title: '🏝️ 夕凪島へ',
        description: [
          origin
            ? `下のリンクを開くと島に行けます。\n\n${link}`
            : 'ゲームのURLが設定されていません。管理者に `GAME_ORIGIN` の設定を頼んでください。',
          '',
          `**このリンクはあなた専用です。** ${store.SESSION_HOURS} 時間で切れるので、`,
          '切れたらまたここから出し直してください。',
          '横画面で遊ぶのがおすすめです。',
        ].join('\n'),
      }),
    ],
    components: [row(button(id('fish', 'open'), '釣りメニューへ', { emoji: '🎣' }), homeButton())],
  });
}

/* ------------------------------------------------------------------ 釣り具屋 */

export async function shop(ix, _args, ctx, notice = null) {
  const settings = await ctx.settings(ix.guildId);
  const [balance, player] = await Promise.all([
    getBalance(ctx.db, ix.guildId, ix.userId),
    store.getPlayer(ctx.db, ix.guildId, ix.userId),
  ]);
  const owned = rodRank(player.rod);

  const rodLines = RODS.map((rod, index) => {
    const mark = index === owned ? '**使用中**' : index < owned ? '所持済み' : coins(rod.price, settings);
    const perHour = expectedPerHour(rod.key);
    const sign = perHour >= 0 ? '+' : '';
    return `${rod.name}　${mark}\n　　1時間あたりの目安 ${sign}${perHour.toLocaleString('ja-JP')}`;
  }).join('\n');

  const main = embed({
    color: 0x1e6b7a,
    title: '🪱 釣り具屋',
    description: `所持金 ${coins(balance, settings)}　🪱 餌 **${player.bait}** 個`,
    fields: [
      { name: `餌（1個 ${coins(BAIT_PRICE, settings)}）`, value: '1回投げるごとに1個使います。' },
      { name: '竿', value: rodLines },
    ],
    footer: { text: '竿は買っても釣りの儲けでは元が取れません。見栄えとロマンのためのものです' },
  });

  const baitRow = row(
    ...BAIT_PACKS.map((count) =>
      button(id('fish', 'bait', String(count)), `餌 ${count}個`, {
        emoji: '🪱',
        style: ButtonStyle.PRIMARY,
        disabled: balance < count * BAIT_PRICE,
      }),
    ),
  );
  const next = RODS[owned + 1];
  const rodRow = row(
    next
      ? button(id('fish', 'rod', next.key), `${next.name}を買う`, {
          emoji: '🎣',
          style: ButtonStyle.SUCCESS,
          disabled: balance < next.price,
        })
      : button(id('fish', 'shop'), '竿はすべて揃いました', { disabled: true }),
  );

  return show(ix, {
    embeds: [withNotice(main, notice)],
    components: [baitRow, rodRow, row(button(id('fish', 'open'), '戻る', { emoji: '◀️' }), homeButton())],
  });
}

export async function bait(ix, [rawCount], ctx) {
  const count = Number(rawCount);
  if (!BAIT_PACKS.includes(count)) return shop(ix, [], ctx, 'その個数は買えません。');
  const cost = count * BAIT_PRICE;
  const paid = await withdraw(ctx.db, ix.guildId, ix.userId, cost, 'fishing:bait', `餌 ${count}個`);
  if (!paid) return shop(ix, [], ctx, 'お金が足りません。');
  await store.addBait(ctx.db, ix.guildId, ix.userId, count);
  const settings = await ctx.settings(ix.guildId);
  return shop(ix, [], ctx, `餌を ${count} 個買いました（${coins(cost, settings)}）。`);
}

export async function rod(ix, [key], ctx) {
  const wanted = RODS_BY_KEY.get(key);
  if (!wanted) return shop(ix, [], ctx, 'その竿はありません。');
  const player = await store.getPlayer(ctx.db, ix.guildId, ix.userId);
  if (rodRank(key) <= rodRank(player.rod)) return shop(ix, [], ctx, 'もう持っています。');
  const paid = await withdraw(ctx.db, ix.guildId, ix.userId, wanted.price, 'fishing:rod', wanted.name);
  if (!paid) return shop(ix, [], ctx, 'お金が足りません。');
  await store.setRod(ctx.db, ix.guildId, ix.userId, key);
  return shop(ix, [], ctx, `${wanted.name} を手に入れました。`);
}

/* ------------------------------------------------------------------ 売却 */

export async function sell(ix, _args, ctx, notice = null) {
  const settings = await ctx.settings(ix.guildId);
  const emoji = await ctx.emoji();
  const lines = await store.inventorySummary(ctx.db, ix.guildId, ix.userId);

  if (lines.length === 0) {
    return open(ix, [], ctx, 'クーラーボックスは空です。');
  }

  const byRarity = { n: 0, r: 0, sr: 0 };
  for (const line of lines) {
    const fish = FISH_BY_ID.get(line.fish_id);
    if (fish) byRarity[fish.rarity] += line.total;
  }
  const total = lines.reduce((sum, line) => sum + line.total, 0);

  const body = lines.slice(0, 24).map((line) => {
    const fish = FISH_BY_ID.get(line.fish_id);
    return `${fishEmoji(emoji, line.fish_id)} ${fish?.name ?? '？'} ×${line.n}　${coins(line.total, settings)}`;
  });
  if (lines.length > 24) body.push(`…ほか ${lines.length - 24} 種`);

  const main = embed({
    color: 0x1e6b7a,
    title: '💴 魚を売る',
    description: `ぜんぶ売ると ${coins(total, settings)}`,
    fields: [{ name: '中身', value: body.join('\n') || '—' }],
    footer: { text: '売ると在庫から消えますが、図鑑の記録は残ります' },
  });

  return show(ix, {
    embeds: [withNotice(main, notice)],
    components: [
      row(
        button(id('fish', 'sold', 'all'), 'ぜんぶ売る', { emoji: '💴', style: ButtonStyle.SUCCESS }),
        button(id('fish', 'sold', 'n'), 'ノーマルだけ', { disabled: byRarity.n === 0 }),
      ),
      row(button(id('fish', 'open'), '戻る', { emoji: '◀️' }), homeButton()),
    ],
  });
}

export async function sold(ix, [scope], ctx) {
  const rarity = scope === 'all' ? null : scope;
  if (rarity !== null && !RARITY[rarity]) return sell(ix, [], ctx, 'その選び方はできません。');
  const result = await store.sellAll(ctx.db, ix.guildId, ix.userId, { rarity });
  if (result.count === 0) return sell(ix, [], ctx, '売れる魚がありませんでした。');
  await deposit(ctx.db, ix.guildId, ix.userId, result.total, 'fishing:sell', `${result.count}匹`);
  const settings = await ctx.settings(ix.guildId);
  return open(ix, [], ctx, `${result.count} 匹を ${coins(result.total, settings)} で売りました。`);
}

/* ------------------------------------------------------------------ 図鑑 */

export async function dex(ix, [rawPage], ctx) {
  const emoji = await ctx.emoji();
  const found = await store.dexOf(ctx.db, ix.guildId, ix.userId);
  const pages = Math.ceil(FISH.length / PAGE);
  const page = Math.min(Math.max(Number(rawPage) || 0, 0), pages - 1);
  const slice = FISH.slice(page * PAGE, (page + 1) * PAGE);

  // まだ釣っていない魚は絵文字も伏せる。中身が見えていると集める楽しみが無い。
  const lines = slice.map((fish) => {
    const seen = found.get(fish.id);
    if (!seen) return '⬛ ???';
    const best = actualSize(fish, seen.best_mul);
    return `${fishEmoji(emoji, fish.id)} **${fish.name}**　×${seen.count}　最大 ${best}cm（${sizeLabel(seen.best_mul)}）`;
  });

  const counts = { n: [0, 0], r: [0, 0], sr: [0, 0] };
  for (const fish of FISH) {
    counts[fish.rarity][1]++;
    if (found.has(fish.id)) counts[fish.rarity][0]++;
  }

  return show(ix, {
    embeds: [
      embed({
        color: 0x1e6b7a,
        title: `📖 図鑑（${found.size} / ${FISH.length} 種）`,
        description: Object.entries(counts)
          .map(([key, [got, all]]) => `${RARITY[key].label} ${got}/${all}`)
          .join('　'),
        fields: [{ name: `${page + 1} / ${pages} ページ`, value: lines.join('\n') || '—' }],
        footer: { text: '釣った魚は、売っても図鑑には残ります' },
      }),
    ],
    components: [
      row(
        button(id('fish', 'dex', String(page - 1)), '前', { emoji: '◀️', disabled: page === 0 }),
        button(id('fish', 'dex', String(page + 1)), '次', { emoji: '▶️', disabled: page >= pages - 1 }),
      ),
      row(button(id('fish', 'open'), '戻る', { emoji: '◀️' }), homeButton()),
    ],
  });
}

export const actions = Object.fromEntries(
  Object.entries({ open, url, shop, bait, rod, sell, sold, dex }).map(([name, fn]) => [name, guard(fn)]),
);
