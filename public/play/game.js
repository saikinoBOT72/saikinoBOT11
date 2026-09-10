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
const g = cv.getContext('2d');
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
  el.bait.innerHTML = `🪱 <b>${S.you.bait}</b>`;
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

function fit() {
  const pad = 8;
  const w = window.innerWidth - pad * 2;
  const h = window.innerHeight - pad * 2;
  const k = Math.min(w / 1280, h / 720);
  const screen = document.getElementById('screen');
  screen.style.width = `${Math.round(1280 * k)}px`;
  screen.style.height = `${Math.round(720 * k)}px`;
  cv.style.width = `${Math.round(1280 * k)}px`;
  cv.style.height = `${Math.round(720 * k)}px`;
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

/** 取り込み中のゲージ。上が張りすぎ、下がゆるみすぎ。 */
function drawFight() {
  const x = 1090, y = 168, w = 44, h = 360;
  g.fillStyle = 'rgba(8,19,31,.88)';
  g.fillRect(x - 46, y - 36, w + 92, h + 52);
  g.strokeStyle = '#24546B'; g.lineWidth = 2;
  g.strokeRect(x - 46, y - 36, w + 92, h + 52);

  g.fillStyle = '#A9BDC6';
  g.font = '600 16px "Hiragino Kaku Gothic ProN", sans-serif';
  g.textAlign = 'center';
  g.fillText('テンション', x + w / 2, y - 14);

  // 目盛りの土台
  g.fillStyle = '#0E2A3C';
  g.fillRect(x, y, w, h);

  // 安全な帯（ここに針を合わせ続ける）
  const half = S.cast.fight.safe / 2;
  const lo = Math.max(0, S.band - half), hi = Math.min(1, S.band + half);
  g.fillStyle = 'rgba(53,176,168,.55)';
  g.fillRect(x, y + (1 - hi) * h, w, (hi - lo) * h);

  // 危険域
  g.fillStyle = 'rgba(232,131,126,.22)';
  g.fillRect(x, y, w, h * 0.1);
  g.fillRect(x, y + h * 0.9, w, h * 0.1);

  // いまのテンション
  const ty = y + (1 - S.tension) * h;
  const inBand = S.tension >= lo && S.tension <= hi;
  g.fillStyle = inBand ? '#F2A65A' : '#E8837E';
  g.fillRect(x - 6, ty - 4, w + 12, 8);

  g.strokeStyle = '#12101C'; g.lineWidth = 2;
  g.strokeRect(x, y, w, h);

  // 取り込みの進み
  const pw = 300, px = 1280 / 2 - pw / 2, py = 640;
  g.fillStyle = 'rgba(8,19,31,.85)';
  g.fillRect(px - 8, py - 8, pw + 16, 40);
  g.fillStyle = '#0E2A3C';
  g.fillRect(px, py, pw, 24);
  g.fillStyle = '#35B0A8';
  g.fillRect(px, py, pw * Math.min(1, S.progress / S.cast.fight.needed), 24);
  g.strokeStyle = '#12101C'; g.lineWidth = 2;
  g.strokeRect(px, py, pw, 24);

  // バラしそうな度合い
  if (S.slip > 0.15) {
    g.fillStyle = 'rgba(232,131,126,.9)';
    g.fillRect(px, py + 28, pw * Math.min(1, S.slip / 3), 6);
  }
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

  if (S.phase === 'fight' && S.cast) drawFight();
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
  S.bandV += (Math.random() - 0.5) * f.pull * dt * 5;
  S.bandV *= 0.94;
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
      showCard(
        `<div class="kind">${kind === 'sr' ? 'SUPER RARE' : kind === 'r' ? 'RARE' : 'NORMAL'}</div>
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
  if (S.phase === 'ready') return doCast();
  if (S.phase === 'bite') return startFight();
  if (S.phase === 'fight') { S.holding = true; el.act.classList.add('hold'); }
}
function release() {
  if (S.phase === 'fight') { S.holding = false; el.act.classList.remove('hold'); }
}

el.act.addEventListener('pointerdown', (event) => { event.preventDefault(); press(); });
el.act.addEventListener('pointerup', release);
el.act.addEventListener('pointercancel', release);
el.act.addEventListener('pointerleave', release);
addEventListener('keydown', (event) => {
  if (event.code !== 'Space' || event.repeat) return;
  event.preventDefault(); press();
});
addEventListener('keyup', (event) => { if (event.code === 'Space') release(); });

/** 席をクリックして座る。 */
cv.addEventListener('click', async (event) => {
  if (S.phase !== 'sitting' || S.busy) return;
  const rect = cv.getBoundingClientRect();
  const x = (event.clientX - rect.left) * (1280 / rect.width);
  const y = (event.clientY - rect.top) * (720 / rect.height);
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
 * タブを見ていない間は止める（無料枠を無駄に食わないため）。
 */
async function heartbeat() {
  if (document.hidden || S.busy) return;
  if (S.phase !== 'ready' && S.phase !== 'sitting' && S.phase !== 'waiting') return;
  if (performance.now() - S.lastPing < 20000) return;
  S.lastPing = performance.now();
  try { absorb(await call('ping')); } catch { /* つながらなくても釣りは続けられる */ }
}
setInterval(heartbeat, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) S.lastPing = 0; });

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
