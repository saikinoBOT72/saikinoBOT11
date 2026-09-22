import { CallbackType, MessageFlags } from './constants.js';

export function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(init.headers ?? {}) },
  });
}

export const pong = () => json({ type: CallbackType.PONG });

/** 新しいメッセージで返す（既定では本人にしか見えない）。 */
export const reply = (data, { ephemeral = true } = {}) =>
  json({
    type: CallbackType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: ephemeral ? { ...data, flags: MessageFlags.EPHEMERAL } : data,
  });

/** 押されたメッセージを書き換える。 */
export const update = (data) => json({ type: CallbackType.UPDATE_MESSAGE, data });

/**
 * 「受け取った」とだけ先に返す（見た目は変わらない）。
 *
 * Discord は3秒以内に何か返さないと「応答しませんでした」になる。
 * 重い処理はこれを返したあとに回し、終わったら
 * editOriginalResponse でメッセージを書き換える（15分の猶予がある）。
 */
export const deferUpdate = () => json({ type: CallbackType.DEFERRED_UPDATE_MESSAGE });

/** 入力フォームを開く。 */
export const modalResponse = (data) => json({ type: CallbackType.MODAL, data });
