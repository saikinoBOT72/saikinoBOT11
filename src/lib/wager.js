import { getBalance } from './economy.js';
import { coins } from './format.js';

/**
 * 賭け金が有効かを確認する。問題があればユーザー向けメッセージを返す。
 * @returns {{ok: true, balance: number} | {ok: false, message: string}}
 */
export function checkBet(guildId, userId, amount, settings) {
  if (!Number.isInteger(amount) || amount <= 0) {
    return { ok: false, message: '賭け金は1以上の整数で指定してください。' };
  }
  if (amount < settings.min_bet) {
    return { ok: false, message: `賭け金は最低 ${coins(settings.min_bet, settings)} からです。` };
  }
  if (settings.max_bet > 0 && amount > settings.max_bet) {
    return { ok: false, message: `賭け金の上限は ${coins(settings.max_bet, settings)} です。` };
  }
  const balance = getBalance(guildId, userId);
  if (balance < amount) {
    return { ok: false, message: `残高が足りません。現在の所持金は ${coins(balance, settings)} です。` };
  }
  return { ok: true, balance };
}
