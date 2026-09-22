/**
 * `wrangler tail --format json` の出力を、読める形にまとめる。
 *
 * 見たいのは3つ。
 *   ・そもそもBotに届いているか
 *   ・返せているか（outcome）
 *   ・どれだけ時間がかかったか
 */
import fs from 'node:fs';

const path = process.argv[2];
const lines = fs.existsSync(path)
  ? fs
      .readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('{'))
  : [];

const events = [];
for (const line of lines) {
  try {
    events.push(JSON.parse(line));
  } catch {
    // tail は途中で切れた行を出すことがある。読めない行は飛ばす
  }
}

console.log('## 本番のログ\n');
if (events.length === 0) {
  console.log('```');
  console.log('記録がありません。');
  console.log('');
  console.log('考えられること:');
  console.log('  ・記録している間に Discord で操作しなかった');
  console.log('  ・Discord からBotにそもそも届いていない');
  console.log('    （Developer Portal の Interactions Endpoint URL を確認）');
  console.log('```');
  process.exit(0);
}

const OUTCOME = {
  ok: '✅ ok（ちゃんと返せた）',
  exception: '💥 exception（例外で落ちた）',
  exceededCpu: '⏱️ exceededCpu（計算に時間をかけすぎて打ち切られた）',
  canceled: '🚫 canceled（途中で止められた）',
  unknown: '❓ unknown',
};

console.log('```');
for (const event of events) {
  const when = event.eventTimestamp ? new Date(event.eventTimestamp).toISOString().slice(11, 23) : '--:--';
  const outcome = OUTCOME[event.outcome] ?? event.outcome;
  const took = typeof event.wallTime === 'number' ? `　${event.wallTime}ms` : '';
  const cpu = typeof event.cpuTime === 'number' ? `　CPU ${event.cpuTime}ms` : '';
  const path = event.event?.request?.url ? new URL(event.event.request.url).pathname : (event.event?.cron ?? '');

  console.log(`\n■ ${when}  ${outcome}${took}${cpu}  ${path}`);

  for (const log of event.logs ?? []) {
    const text = (log.message ?? []).map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ');
    console.log(`   [${log.level}] ${text.slice(0, 400)}`);
  }
  for (const problem of event.exceptions ?? []) {
    console.log(`   💥 ${problem.name}: ${problem.message}`);
    if (problem.stack) {
      for (const at of String(problem.stack).split('\n').slice(0, 6)) console.log(`      ${at.trim()}`);
    }
  }
}
console.log('```\n');

const bad = events.filter((event) => event.outcome && event.outcome !== 'ok');
console.log(`記録 **${events.length}** 件／うまくいかなかったもの **${bad.length}** 件`);
if (bad.length === 0) {
  console.log('\nすべて ok で返せています。Discord 側に届くまでの間で落ちている可能性があります。');
}
