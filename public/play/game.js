/**
 * 夕凪島 ─ ブラウザの釣りゲーム。
 *
 * 【無料枠を減らさないための決めごと】
 *  ・サーバーを呼ぶのは cast と resolve の2回だけ。1匹釣るのに2リクエスト。
 *  ・島の様子（誰が座っていて何を釣ったか）は、その2つの応答に相乗りしてくる。
 *  ・何もしていないときの ping は20秒に1回。タブを見ていない間は止める。
 *  ・アニメーションも当たり判定も、ぜんぶこの中（ブラウザ）で完結させる。
 */
'use strict';

const TOKEN = location.hash.slice(1);
const API = '/api/fishing/';

/* 島の座標（1280x720 の背景に合わせてある） */
const SCALE = 5;                       // ドット1個を何ピクセルで描くか
const SEAT_X = [450, 655, 872];        // 切り株の中心
const SEAT_Y = 452;                    // キャラの足元（切り株が少し見える高さ）
const FLOAT_Y = 600;                   // ウキが浮かぶ水面
const HAND = { x: 14, y: 18 };         // キャラのどこで竿を持つか（ドット座標）

const ASSETS = {
  island: 'assets/island.png',
  idle: 'assets/char_idle.png',
  pull: 'assets/char_pull.png',
  floatUp: 'assets/float_up.png',
  floatDown: 'assets/float_down.png',
  alert: 'assets/alert.png',
};
for (const tier of ['bamboo', 'glass', 'carbon', 'legend']) {
  ASSETS[`rod_${tier}_idle`] = `assets/rod_${tier}_idle.png`;
  ASSETS[`rod_${tier}_pull`] = `assets/rod_${tier}_pull.png`;
}

const img = {};
const cv = document.getElementById('cv');
const g = cv.getContext('2d', { alpha: false });
// ドット絵を5倍に拡大して描くので、にじませる補間を切る。
// これを入れ忘れるとキャラも竿もウキもぼやける。
g.imageSmoothingEnabled = false;
const el = {
  boot: document.getElementById('boot'),
  act: document.getElementById('act'),
  hint: document.getElementById('hint'),
  card: document.getElementById('card'),
  bait: document.getElementById('baitChip'),
  rod: document.getElementById('rodChip'),
  stat: document.getElementById('statChip'),
};

/* ------------------------------------------------------------------ 状態 */

const S = {
  phase: 'loading',   // loading / sitting / ready / waiting / bite / fight / done
  seat: null,
  you: null,
  island: [],
  busy: false,
  // 1回ぶんのあたり
  cast: null,         // { nonce, biteMs, hookWindowMs, fight }
  castAt: 0,
  // 取り込み中
  tension: 0.5,
  band: 0.5,
  bandV: 0,
  progress: 0,
  slip: 0,
  holding: false,
  message: '',
  lastPing: 0,
};

/* ------------------------------------------------------------------ 通信 */

async function call(action, body = {}) {
  const res = await fetch(API + action, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN, ...body }),
  });
  const data = await res.json().catch(() => ({ error: '応答を読めませんでした' }));
  if (!res.ok) throw new Error(data.error || `通信に失敗しました (${res.status})`);
  return data;
}

/** 応答に相乗りしてくる島の様子を取り込む。 */
function absorb(data) {
  if (data.island) S.island = data.island;
  if (data.you) S.you = data.you;
  if (typeof data.bait === 'number' && S.you) S.you.bait = data.bait;
  paintHud();
}

/* ------------------------------------------------------------------ 画面 */

function paintHud() {
  if (!S.you) return;
  const low = S.you.bait <= 0;
  el.bait.className = 'chip' + (low ? ' warn' : '');
  el.bait.innerHTML = `<img src="assets/bait.png" alt="餌"><b>${S.you.bait}</b>`;
  el.rod.textContent = S.you.rodName;
  el.stat.textContent = `${S.you.landed} 匹`;
}

function showCard(html, kind = '') {
  el.card.className = 'show ' + kind;
  el.card.innerHTML = html;
}
function hideCard() {
  el.card.className = '';
}

function setAction(label, enabled, hint = '') {
  el.act.textContent = label;
  el.act.disabled = !enabled;
  el.hint.textContent = hint;
}

/* ------------------------------------------------------------------ 描画 */

/**
 * 画面の大きさに合わせる。
 * iOS の Safari では向きを固定できないので、縦に持っていたら
 * 画面ごと90度回して横画面として使う。当たり判定は offsetX/offsetY で
 * 取るため、回しても押した場所はずれない。
 */
function fit() {
  const portrait = window.innerHeight > window.innerWidth;
  const availW = (portrait ? window.innerHeight : window.innerWidth) - 10;
  const availH = (portrait ? window.innerWidth : window.innerHeight) - 10;
  const k = Math.min(availW / 1280, availH / 720);
  const w = Math.round(1280 * k);
  const h = Math.round(720 * k);
  const screen = document.getElementById('screen');
  screen.style.width = `${w}px`;
  screen.style.height = `${h}px`;
  screen.style.transform = `translate(-50%, -50%)${portrait ? ' rotate(90deg)' : ''}`;
  cv.style.width = `${w}px`;
  cv.style.height = `${h}px`;
  g.imageSmoothingEnabled = false;   // 大きさを変えると戻ることがある
}

/** ドット絵を SCALE 倍で、左上ではなく「足元の中心」を指定して置く。 */
function blitFoot(sprite, cx, footY, dy = 0) {
  const w = sprite.width * SCALE;
  const h = sprite.height * SCALE;
  g.drawImage(sprite, Math.round(cx - w / 2), Math.round(footY - h + dy * SCALE), w, h);
}

/** 竿は「いちばん下の不透明ドット」を手に合わせる。上下で高さが変わるため。 */
const gripCache = new Map();
function gripOf(sprite, key) {
  if (gripCache.has(key)) return gripCache.get(key);
  const c = document.createElement('canvas');
  c.width = sprite.width; c.height = sprite.height;
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.drawImage(sprite, 0, 0);
  const data = cx.getImageData(0, 0, c.width, c.height).data;
  let found = { x: 0, y: sprite.height - 1 };
  outer:
  for (let y = sprite.height - 1; y >= 0; y--) {
    const xs = [];
    for (let x = 0; x < sprite.width; x++) if (data[(y * sprite.width + x) * 4 + 3] >= 128) xs.push(x);
    if (xs.length) { found = { x: Math.round(xs.reduce((a, b) => a + b) / xs.length), y }; break outer; }
  }
  gripCache.set(key, found);
  return found;
}

/**
 * 上下のゆれ。待機と釣り中は1秒ごと、引いている間は0.5秒ごとに1ドット動かす。
 * なめらかに揺らすのではなく、パッと切り替えるのがドット絵らしい。
 */
function bobOf(now, fast) {
  const period = fast ? 500 : 1000;
  return Math.floor(now / period) % 2 === 0 ? 0 : 1;
}

function drawAngler(now, seat, { self, rodKey, fighting, name, bubble }) {
  const cx = SEAT_X[seat];
  const bob = bobOf(now, fighting);
  const body = fighting ? img.pull : img.idle;
  blitFoot(body, cx, SEAT_Y, bob);

  // 竿はキャラより手前
  const key = `rod_${rodKey}_${fighting ? 'pull' : 'idle'}`;
  const rod = img[key] ?? img.rod_bamboo_idle;
  const grip = gripOf(rod, key);
  const bodyLeft = Math.round(cx - (body.width * SCALE) / 2);
  const bodyTop = SEAT_Y - body.height * SCALE + bob * SCALE;
  g.drawImage(
    rod,
    bodyLeft + (HAND.x - grip.x) * SCALE,
    bodyTop + (HAND.y - grip.y) * SCALE,
    rod.width * SCALE, rod.height * SCALE,
  );

  // 名前
  const label = self ? `${name}（あなた）` : name;
  g.font = '600 20px "Hiragino Kaku Gothic ProN", sans-serif';
  g.textAlign = 'center';
  const tw = g.measureText(label).width;
  const ny = SEAT_Y - body.height * SCALE - 22;
  g.fillStyle = 'rgba(8,19,31,.78)';
  g.fillRect(cx - tw / 2 - 8, ny - 17, tw + 16, 24);
  g.fillStyle = self ? '#F2A65A' : '#F1E6D2';
  g.fillText(label, cx, ny);

  if (bubble) {
    g.font = '700 19px "Hiragino Kaku Gothic ProN", sans-serif';
    const bw = g.measureText(bubble).width;
    const by = ny - 30;
    g.fillStyle = 'rgba(53,176,168,.92)';
    g.fillRect(cx - bw / 2 - 9, by - 17, bw + 18, 25);
    g.fillStyle = '#08131F';
    g.fillText(bubble, cx, by);
  }
}

function drawFloat(now, seat, sunk) {
  const sprite = sunk ? img.floatDown : img.floatUp;
  const wave = Math.round(Math.sin(now / 420 + seat) * 3);
  blitFoot(sprite, SEAT_X[seat], FLOAT_Y + sprite.height * SCALE + wave, 0);
}

/** かかった合図。名札より上に、吹き出しごと大きく出して跳ねさせる。 */
function drawAlert(now, seat) {
  const cx = SEAT_X[seat];
  const jump = Math.floor(now / 110) % 2 === 0 ? 0 : 5;
  const k = 4;                                   // ！の拡大率
  const w = img.alert.width * k, h = img.alert.height * k;
  const boxW = w + 30, boxH = h + 22;
  const boxY = SEAT_Y - img.idle.height * SCALE - 46 - boxH - jump;
  const boxX = cx - boxW / 2;

  g.fillStyle = '#12101C';
  g.fillRect(boxX - 4, boxY - 4, boxW + 8, boxH + 8);
  g.fillStyle = '#E8443A';
  g.fillRect(boxX, boxY, boxW, boxH);
  // 吹き出しのしっぽ
  g.beginPath();
  g.moveTo(cx - 11, boxY + boxH); g.lineTo(cx + 11, boxY + boxH); g.lineTo(cx, boxY + boxH + 16);
  g.closePath();
  g.fillStyle = '#12101C'; g.fill();
  g.beginPath();
  g.moveTo(cx - 8, boxY + boxH - 2); g.lineTo(cx + 8, boxY + boxH - 2); g.lineTo(cx, boxY + boxH + 11);
  g.closePath();
  g.fillStyle = '#E8443A'; g.fill();

  g.drawImage(img.alert, Math.round(cx - w / 2), Math.round(boxY + 11), w, h);
}

/**
 * 空いている席の目印。座る前だけ出す。
 * 背景の切り株を塗りつぶさないよう、上に浮かぶ矢印と足元の輪だけにする。
 */
function drawSeatMarks(now) {
  const taken = new Set(S.island.map((p) => p.seat));
  g.textAlign = 'center';
  for (let i = 0; i < SEAT_X.length; i++) {
    if (taken.has(i)) continue;
    const cx = SEAT_X[i];
    const float = Math.round(Math.sin(now / 320 + i * 1.7) * 5);

    // 足元の輪
    g.save();
    g.globalAlpha = 0.45 + 0.2 * Math.sin(now / 320 + i * 1.7);
    g.strokeStyle = '#F2A65A'; g.lineWidth = 3;
    g.beginPath();
    g.ellipse(cx, SEAT_Y + 16, 42, 12, 0, 0, Math.PI * 2);
    g.stroke();
    g.restore();

    // 上に浮かぶ矢印
    const ay = SEAT_Y - 118 + float;
    g.fillStyle = '#F2A65A';
    g.strokeStyle = '#12101C'; g.lineWidth = 3;
    g.beginPath();
    g.moveTo(cx - 13, ay); g.lineTo(cx + 13, ay); g.lineTo(cx, ay + 17);
    g.closePath(); g.fill(); g.stroke();

    // ラベル
    g.font = '700 18px "Hiragino Kaku Gothic ProN", sans-serif';
    const label = 'ここに座る';
    const w = g.measureText(label).width;
    g.fillStyle = 'rgba(8,19,31,.85)';
    g.fillRect(cx - w / 2 - 9, ay - 32, w + 18, 24);
    g.strokeStyle = '#F2A65A'; g.lineWidth = 2;
    g.strokeRect(cx - w / 2 - 9, ay - 32, w + 18, 24);
    g.fillStyle = '#F2A65A';
    g.fillText(label, cx, ay - 14);
  }
}

/**
 * 取り込み中のゲージ。画面右のこれ1本だけ。
 *
 * どれだけ引き寄せたかは「わざと見せない」。かわりに、
 * 糸が切れそうになるほど枠が赤くなって震える。
 * 数字ではなく手応えで危なさを伝える。
 */
function drawFight(now) {
  const f = S.cast.fight;
  const danger = Math.min(1, S.slip / 3);          // 0=安全 1=切れる寸前

  // 危ないほど大きく震える
  const shake = danger > 0.12 ? danger * 7 : 0;
  const sx = shake ? (Math.random() - 0.5) * shake : 0;
  const sy = shake ? (Math.random() - 0.5) * shake : 0;

  const w = 54, h = 420;
  const x = 1150 + sx, y = 150 + sy;
  const padX = 26, padY = 34;

  // 枠。危ないほど赤く濃くなる
  const heat = danger * danger;                     // じわっと来て最後に一気に
  g.fillStyle = `rgba(${Math.round(8 + 180 * heat)},${Math.round(19 + 20 * heat)},${Math.round(31 + 26 * heat)},${0.86 + 0.1 * heat})`;
  g.fillRect(x - padX, y - padY, w + padX * 2, h + padY * 2);
  g.lineWidth = 2 + 3 * heat;
  g.strokeStyle = danger < 0.05
    ? '#24546B'
    : `rgb(${Math.round(36 + 196 * heat)},${Math.round(84 - 53 * heat)},${Math.round(107 - 81 * heat)})`;
  g.strokeRect(x - padX, y - padY, w + padX * 2, h + padY * 2);

  g.textAlign = 'center';
  g.font = '600 17px "Hiragino Kaku Gothic ProN", sans-serif';
  g.fillStyle = danger > 0.55 ? '#FFD2CE' : '#A9BDC6';
  g.fillText(danger > 0.55 ? '切れる！' : 'テンション', x + w / 2, y - 13);

  // 目盛りの土台
  g.fillStyle = '#0E2A3C';
  g.fillRect(x, y, w, h);

  // 安全な帯。ここに針を合わせ続ける
  const half = f.safe / 2;
  const lo = Math.max(0, S.band - half), hi = Math.min(1, S.band + half);
  g.fillStyle = danger > 0.5 ? 'rgba(232,131,126,.5)' : 'rgba(53,176,168,.55)';
  g.fillRect(x, y + (1 - hi) * h, w, (hi - lo) * h);

  // 上下の端は張りすぎ・ゆるみすぎ
  g.fillStyle = 'rgba(232,131,126,.2)';
  g.fillRect(x, y, w, h * 0.08);
  g.fillRect(x, y + h * 0.92, w, h * 0.08);

  // いまのテンション
  const ty = y + (1 - S.tension) * h;
  const inBand = S.tension >= lo && S.tension <= hi;
  g.fillStyle = inBand ? '#F2A65A' : '#E8443A';
  g.fillRect(x - 7, ty - 5, w + 14, 10);
  g.fillStyle = '#12101C';
  g.fillRect(x - 7, ty - 5, w + 14, 2);

  g.strokeStyle = '#12101C'; g.lineWidth = 2;
  g.strokeRect(x, y, w, h);
}

function render(now) {
  g.clearRect(0, 0, 1280, 720);
  if (img.island) g.drawImage(img.island, 0, 0, 1280, 720);

  if (S.phase === 'sitting') drawSeatMarks(now);

  for (const person of S.island) {
    const self = person.me;
    const fighting = self && (S.phase === 'fight' || S.phase === 'bite');
    drawAngler(now, person.seat, {
      self,
      rodKey: self ? (S.you?.rod ?? 'bamboo') : 'bamboo',
      fighting,
      name: person.name,
      bubble: person.fish && !self ? `${person.fish.name}！` : null,
    });
    if (self && (S.phase === 'waiting' || S.phase === 'bite' || S.phase === 'fight')) {
      drawFloat(now, person.seat, S.phase !== 'waiting');
    }
    if (self && S.phase === 'bite') drawAlert(now, person.seat);
  }

  if (S.phase === 'fight' && S.cast) drawFight(now);
  requestAnimationFrame(render);
}

/* ------------------------------------------------------------------ 進行 */

let timer = null;
const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };

function toReady(message = '') {
  S.phase = 'ready';
  S.cast = null;
  const canCast = (S.you?.bait ?? 0) > 0;
  setAction('投げる', canCast, canCast ? 'スペースキーでも投げられます' : '餌がありません。Discord の 🎣 → 釣り具屋 で買えます');
  if (message) el.hint.textContent = message;
}

async function doCast() {
  if (S.busy) return;
  S.busy = true;
  hideCard();
  try {
    const data = await call('cast');
    absorb(data);
    if (!data.ok) { toReady(data.reason || '投げられませんでした'); return; }
    S.cast = data;
    S.castAt = performance.now();
    S.phase = 'waiting';
    setAction('…', false, 'ウキが沈むまで待つ');
    clearTimer();
    timer = setTimeout(onBite, data.biteMs);
  } catch (error) {
    showCard(`<div class="meta miss">${error.message}</div>`);
    toReady();
  } finally {
    S.busy = false;
  }
}

function onBite() {
  S.phase = 'bite';
  setAction('あわせる！', true, 'いま押す！');
  clearTimer();
  // 猶予のうちに押さなければ逃げられる
  timer = setTimeout(() => finish(false, 'あわせ遅れ'), S.cast.hookWindowMs);
}

function startFight() {
  clearTimer();
  S.phase = 'fight';
  S.tension = 0.5;
  S.band = 0.5;
  S.bandV = 0;
  S.progress = 0;
  S.slip = 0;
  S.holding = false;
  setAction('引く（長押し）', true, '押すと張る／離すとゆるむ。帯の中に合わせ続ける');
  last = performance.now();
  tick();
}

let last = 0;
function tick() {
  if (S.phase !== 'fight') return;
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const f = S.cast.fight;

  // 魚が暴れて帯が動く。レアで大きいほど速い。
  S.bandV += (Math.random() - 0.5) * f.pull * dt * 7.5;
  S.bandV *= 0.95;
  S.band += S.bandV * dt;
  if (S.band < 0.18) { S.band = 0.18; S.bandV = Math.abs(S.bandV); }
  if (S.band > 0.82) { S.band = 0.82; S.bandV = -Math.abs(S.bandV); }

  S.tension += (S.holding ? f.pull : -f.ease) * dt;
  S.tension = Math.max(0, Math.min(1, S.tension));

  const half = f.safe / 2;
  const inBand = S.tension >= S.band - half && S.tension <= S.band + half;
  if (inBand) {
    S.progress += dt;
    S.slip = Math.max(0, S.slip - dt * 1.4);
  } else {
    S.slip += dt;
  }
  // 張りすぎ・ゆるめすぎは一気に悪化する
  if (S.tension >= 0.99 || S.tension <= 0.01) S.slip += dt * 1.5;

  if (S.progress >= f.needed) return finish(true);
  if (S.slip >= 3) return finish(false, S.tension >= 0.99 ? '糸が切れた' : 'バラした');
  requestAnimationFrame(tick);
}

async function finish(landed, why = '') {
  clearTimer();
  S.phase = 'done';
  setAction('…', false, '');
  try {
    const data = await call('resolve', { nonce: S.cast.nonce, landed });
    absorb(data);
    if (data.landed) {
      const kind = data.fish.rarity;
      // 図鑑用に Discord へ上げた絵文字を、そのままここでも使う
      const pic = data.fish.emoji
        ? `<img class="pic" src="https://cdn.discordapp.com/emojis/${data.fish.emoji}.png?size=128" alt="">`
        : '';
      showCard(
        `<div class="kind">${kind === 'sr' ? 'SUPER RARE' : kind === 'r' ? 'RARE' : 'NORMAL'}</div>
         ${pic}
         <div class="name">${data.fish.name}</div>
         <div class="meta">${data.fish.size} cm（${data.fish.sizeLabel}）　${data.fish.price} コイン</div>`,
        kind,
      );
    } else {
      showCard(
        `<div class="kind">${why || 'にげられた'}</div>
         <div class="name miss">にがした…</div>
         <div class="meta">${data.fish ? `${data.fish.name} だったようだ` : ''}</div>`,
      );
    }
  } catch (error) {
    showCard(`<div class="meta miss">${error.message}</div>`);
  }
  setTimeout(() => { hideCard(); toReady(); }, landed ? 2600 : 2000);
}

/* ------------------------------------------------------------------ 操作 */

function press() {
  markActive();
  if (S.phase === 'ready') return doCast();
  if (S.phase === 'bite') return startFight();
  if (S.phase === 'fight') { S.holding = true; el.act.classList.add('hold'); }
}
function release() {
  if (S.phase === 'fight') { S.holding = false; el.act.classList.remove('hold'); }
}

// ダブルタップ拡大・ピンチ・長押しメニュー・ドラッグを止める
for (const type of ['gesturestart', 'gesturechange', 'gestureend', 'contextmenu', 'dragstart']) {
  addEventListener(type, (event) => event.preventDefault(), { passive: false });
}
addEventListener('touchmove', (event) => { if (event.touches.length > 1) event.preventDefault(); }, { passive: false });
let lastTap = 0;
addEventListener('touchend', (event) => {
  const now = Date.now();
  if (now - lastTap < 320) event.preventDefault();   // ダブルタップ拡大
  lastTap = now;
}, { passive: false });

el.act.addEventListener('pointerdown', (event) => { event.preventDefault(); press(); });
el.act.addEventListener('pointerup', release);
el.act.addEventListener('pointercancel', release);
el.act.addEventListener('pointerleave', release);
addEventListener('keydown', (event) => {
  if (event.code !== 'Space' || event.repeat) return;
  event.preventDefault(); press();
});
addEventListener('keyup', (event) => { if (event.code === 'Space') release(); });

// iPhone は canvas を長押しすると虫めがね（選択カーソル）が出る。
// touchstart を止めれば出なくなるが、ボタンの反応まで消さないよう
// canvas にだけ効かせる。
cv.addEventListener('touchstart', (event) => event.preventDefault(), { passive: false });

/** 席を押して座る。touch でも動くよう pointerdown で拾う。 */
cv.addEventListener('pointerdown', async (event) => {
  markActive();
  if (S.phase !== 'sitting' || S.busy) return;
  // getBoundingClientRect は回転すると外接四角になって使えないので、
  // 要素そのものの座標系で来る offsetX/offsetY を使う。
  const x = event.offsetX * (1280 / cv.offsetWidth);
  const y = event.offsetY * (720 / cv.offsetHeight);
  const seat = SEAT_X.findIndex((sx) => Math.abs(x - sx) < 60 && y > SEAT_Y - 120 && y < SEAT_Y + 30);
  if (seat < 0) return;
  S.busy = true;
  try {
    const data = await call('seat', { seat });
    absorb(data);
    if (!data.ok) { el.hint.textContent = 'その席はふさがっています'; return; }
    S.seat = seat;
    toReady();
  } catch (error) {
    el.hint.textContent = error.message;
  } finally {
    S.busy = false;
  }
});

/* ------------------------------------------------------------------ 生存確認 */

/**
 * 何もしていないときだけ、20秒に1回だけ様子を見る。
 *
 * 【無料枠を守るための決めごと】
 * ・タブを見ていない間は止める
 * ・3分さわらなければ完全に止める。ページを開きっぱなしで放置されても
 *   リクエストは1件も飛ばない（さわればすぐ再開する）
 * この2つが無いと、開きっぱなしの人が1人いるだけで
 *   1日 4,300 リクエスト（20秒ごと × 24時間）を無言で使ってしまう。
 */
const IDLE_STOP_MS = 3 * 60 * 1000;
let lastActive = performance.now();

function markActive() {
  const wasIdle = performance.now() - lastActive > IDLE_STOP_MS;
  lastActive = performance.now();
  if (wasIdle) S.lastPing = 0;   // 戻ってきたらすぐ様子を見に行く
}
for (const type of ['pointerdown', 'keydown', 'touchstart']) {
  addEventListener(type, markActive, { passive: true });
}

async function heartbeat() {
  if (document.hidden || S.busy) return;
  if (performance.now() - lastActive > IDLE_STOP_MS) return;   // 放置中は黙る
  if (S.phase !== 'ready' && S.phase !== 'sitting' && S.phase !== 'waiting') return;
  if (performance.now() - S.lastPing < 20000) return;
  S.lastPing = performance.now();
  try { absorb(await call('ping')); } catch { /* つながらなくても釣りは続けられる */ }
}
setInterval(heartbeat, 5000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { markActive(); S.lastPing = 0; }
});

/* ------------------------------------------------------------------ 起動 */

function load(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`画像を読めません: ${src}`));
    image.src = src;
  });
}

(async function boot() {
  if (!/^[0-9a-f]{48}$/.test(TOKEN)) {
    el.boot.innerHTML = 'リンクが正しくありません。<br>Discord の <b>🎣 釣り → 島へ行く</b> から出し直してください。';
    return;
  }
  try {
    await Promise.all(Object.entries(ASSETS).map(async ([key, src]) => { img[key] = await load(src); }));
    const data = await call('join');
    absorb(data);
    S.seat = data.seat;
    el.boot.style.display = 'none';
    fit();
    addEventListener('resize', fit);
    requestAnimationFrame(render);
    if (S.seat === null) {
      S.phase = 'sitting';
      setAction('席を選ぶ', false, '座りたい切り株をタップ');
    } else {
      toReady();
    }
  } catch (error) {
    el.boot.innerHTML = `つながりませんでした。<br>${error.message}<br><br>Discord の <b>🎣 釣り → 島へ行く</b> でURLを出し直してみてください。`;
  }
})();
