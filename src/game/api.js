/**
 * ブラウザの釣りゲームとやり取りする小さな API。
 *
 * 【いちばん大事な方針：無料枠を減らさない】
 *  ・画面と画像は public/ に置いて Cloudflare の静的配信に任せる。
 *    静的アセットへのアクセスは Worker が動かないので、リクエスト数に数えられない。
 *  ・Worker を呼ぶのは cast と resolve の2本だけ。1匹釣るのに2リクエスト。
 *  ・島の様子（誰が座っていて何を釣ったか）は専用の問い合わせを作らず、
 *    どの応答にも相乗りさせる。おかげで普段のポーリングが要らない。
 *  ・何もしていないときの ping は 20 秒に1回まで。タブが隠れている間は止める。
 *
 *  3人が1日3時間遊んで、1時間に100回投げても
 *    3人 × 3時間 × 100回 × 2リクエスト ＝ 1,800／日（無料枠 10万／日 の 2%）
 */
import {
  BAIT_PRICE, FISH_BY_ID, RODS_BY_KEY, actualSize, fightParams,
  priceOf, rollFish, rollSizeMultiplier, sizeLabel,
} from '../lib/fishing.js';
import * as store from '../lib/fishing-store.js';
import { emojiId, loadEmoji } from '../lib/emoji.js';

const SEATS = 3;
/** あたりが出るまでの待ち時間（ミリ秒）。 */
const BITE_MIN = 3500;
const BITE_MAX = 12000;
/** かかってから合わせるまでの猶予。 */
export const HOOK_WINDOW_MS = 1800;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });

const bad = (message, status = 400) => json({ error: message }, status);

/**
 * @param {Request} request
 * @param {string} action  /api/fishing/<action> の <action>
 */
export async function handleFishingApi(request, action, ctx) {
  if (request.method !== 'POST') return bad('POST で呼んでください。', 405);

  let body;
  try {
    body = await request.json();
  } catch {
    return bad('JSON として読めませんでした。');
  }

  const session = await store.getSession(ctx.db, body?.token);
  if (!session) return bad('この合鍵は使えません。Discord の 🎣 から URL を出し直してください。', 401);

  switch (action) {
    case 'join':    return join(session, ctx);
    case 'seat':    return seat(session, body, ctx);
    case 'cast':    return cast(session, ctx);
    case 'resolve': return resolve(session, body, ctx);
    case 'ping':    return ping(session, ctx);
    default:        return bad('知らない操作です。', 404);
  }
}

/**
 * Discord に上げてある魚の絵文字の ID。
 * ブラウザからは cdn.discordapp.com/emojis/<id>.png で画像として出せるので、
 * 図鑑用に描いた絵をそのままゲーム画面でも使える。
 */
async function fishEmojiId(fishId, ctx) {
  try {
    const emoji = await (ctx.emoji ? ctx.emoji() : loadEmoji(ctx.db));
    return emojiId(emoji[`fish_${fishId}`]);
  } catch {
    return null;   // 取り込み前でも釣りは続けられる
  }
}

/** どの応答にも付ける、島の今の様子。これがあるので定期問い合わせが要らない。 */
async function islandView(session, ctx) {
  const rows = await store.island(ctx.db, session.guild_id);
  return rows.map((row) => ({
    seat: row.seat,
    name: row.display_name,
    me: row.user_id === session.user_id,
    // 直近の釣果は30秒だけ見せる（ずっと出ていると邪魔なので）
    fish: row.last_catch_at && Date.now() / 1000 - row.last_catch_at < 30
      ? { id: row.last_fish_id, name: FISH_BY_ID.get(row.last_fish_id)?.name ?? '？' }
      : null,
  }));
}

async function playerView(session, ctx) {
  const player = await store.getPlayer(ctx.db, session.guild_id, session.user_id);
  const rod = RODS_BY_KEY.get(player.rod) ?? RODS_BY_KEY.get('bamboo');
  return {
    name: session.display_name,
    bait: player.bait,
    rod: rod.key,
    rodName: rod.name,
    casts: player.casts,
    landed: player.landed,
  };
}

async function join(session, ctx) {
  await store.touch(ctx.db, session.token);
  return json({
    seats: SEATS,
    seat: session.seat,
    you: await playerView(session, ctx),
    island: await islandView(session, ctx),
    baitPrice: BAIT_PRICE,
  });
}

async function seat(session, body, ctx) {
  const wanted = body?.seat;
  if (wanted !== null && !(Number.isInteger(wanted) && wanted >= 0 && wanted < SEATS)) {
    return bad('その席はありません。');
  }
  const ok = await store.takeSeat(ctx.db, session.token, session.guild_id, wanted);
  if (!ok) return json({ ok: false, reason: 'ふさがっています', island: await islandView(session, ctx) });
  const fresh = await store.getSession(ctx.db, session.token);
  return json({ ok: true, seat: wanted, island: await islandView(fresh ?? session, ctx) });
}

/**
 * 1回投げる。餌を1つ使い、かかる魚をここで決めてしまう。
 * 魚の正体は返さない（返すと当たりを見てから狙って外せてしまう）。
 * 返すのは「いつかかるか」と「どれくらい強いか」だけ。
 */
async function cast(session, ctx) {
  if (session.seat === null) return bad('先に席に座ってください。');
  if (session.pending) return bad('いま かかっている最中です。');

  const player = await store.getPlayer(ctx.db, session.guild_id, session.user_id);
  if (player.bait <= 0) {
    return json({ ok: false, reason: '餌がありません', you: await playerView(session, ctx) });
  }
  const held = await store.countInventory(ctx.db, session.guild_id, session.user_id);
  if (held >= store.INVENTORY_LIMIT) {
    return json({ ok: false, reason: `クーラーボックスがいっぱいです（${store.INVENTORY_LIMIT}匹）。売ってから来てください。` });
  }
  if (!(await store.consumeBait(ctx.db, session.guild_id, session.user_id))) {
    return json({ ok: false, reason: '餌がありません', you: await playerView(session, ctx) });
  }

  const fish = rollFish(player.rod);
  const sizeMul = rollSizeMultiplier();
  const fight = fightParams(fish, sizeMul);
  const nonce = session.nonce + 1;
  const biteMs = Math.floor(BITE_MIN + Math.random() * (BITE_MAX - BITE_MIN));

  const started = await store.startFight(ctx.db, session.token, {
    nonce, fishId: fish.id, sizeMul, biteMs, at: Date.now(),
  });
  if (!started) return bad('いま かかっている最中です。');

  return json({
    ok: true,
    nonce,
    biteMs,
    hookWindowMs: HOOK_WINDOW_MS,
    fight,                       // 引きの強さ。魚の正体は伏せたまま
    bait: player.bait - 1,
  });
}

/**
 * 取り込みの結果を受け取る。
 * ブラウザ側の申告を丸ごと信じると「常に成功」と言えてしまうので、
 * ・進行中のあたりと nonce が一致すること
 * ・最短でも必要な秒数だけ時間が経っていること
 * を見てから通す。身内サーバーなので、この程度で十分としている。
 */
async function resolve(session, body, ctx) {
  if (!session.pending) return bad('取り込み中のあたりがありません。');

  let pending;
  try {
    pending = JSON.parse(session.pending);
  } catch {
    await store.finishFight(ctx.db, session.token, false);
    return bad('あたりの記録が壊れていました。もう一度投げてください。');
  }

  if (body?.nonce !== pending.nonce) return bad('順番が合いません。もう一度投げてください。');

  const fish = FISH_BY_ID.get(pending.fishId);
  const fight = fightParams(fish, pending.sizeMul);
  const elapsed = (Date.now() - pending.at) / 1000;
  const shortest = (pending.biteMs / 1000) + fight.needed * 0.8;
  const landed = body?.landed === true && elapsed >= shortest;

  if (!landed) {
    await store.finishFight(ctx.db, session.token, false);
    return json({
      ok: true, landed: false,
      // 逃げられても何だったかは見せる（悔しさが next cast につながる）
      fish: { id: fish.id, name: fish.name, rarity: fish.rarity },
      island: await islandView(session, ctx),
      you: await playerView(session, ctx),
    });
  }

  await store.recordCatch(ctx.db, session.guild_id, session.user_id, fish.id, pending.sizeMul);
  await store.finishFight(ctx.db, session.token, true, fish.id, pending.sizeMul);

  return json({
    ok: true, landed: true,
    fish: {
      id: fish.id,
      name: fish.name,
      rarity: fish.rarity,
      size: actualSize(fish, pending.sizeMul),
      sizeLabel: sizeLabel(pending.sizeMul),
      price: priceOf(fish, pending.sizeMul),
      emoji: await fishEmojiId(fish.id, ctx),
    },
    island: await islandView(session, ctx),
    you: await playerView(session, ctx),
  });
}

/** 何もしていないときの生存確認。島の様子だけ返す。 */
async function ping(session, ctx) {
  await store.touch(ctx.db, session.token);
  return json({ island: await islandView(session, ctx), you: await playerView(session, ctx) });
}
