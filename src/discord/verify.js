/**
 * Discord からのリクエストかを Ed25519 署名で確認する。
 * これを通らないリクエストは 401 で弾く（Discord の要件）。
 */
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

async function importKey(publicKey) {
  const raw = hexToBytes(publicKey);
  try {
    return await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
  } catch {
    // 古いランタイム向けの名前
    return crypto.subtle.importKey('raw', raw, { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' }, false, ['verify']);
  }
}

/**
 * 署名に付いている時刻が、いまからどれだけずれていても受け付けるか（秒）。
 * 署名は「時刻＋本文」に付くので、時刻を見れば、盗み見た古いリクエストを
 * あとから送り直されても弾ける。Discord は押された瞬間に送ってくるので、5分あれば十分。
 */
export const MAX_SKEW_SECONDS = 300;

/**
 * @returns {Promise<{valid: boolean, body: string}>}
 */
export async function verifyRequest(request, publicKey, now = Date.now()) {
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  const body = await request.text();

  if (!signature || !timestamp || !publicKey) return { valid: false, body };
  if (!/^[0-9a-f]+$/i.test(signature) || signature.length !== 128) return { valid: false, body };
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > MAX_SKEW_SECONDS) {
    return { valid: false, body };
  }

  try {
    const key = await importKey(publicKey);
    const valid = await crypto.subtle.verify(
      key.algorithm.name === 'NODE-ED25519' ? { name: 'NODE-ED25519' } : { name: 'Ed25519' },
      key,
      hexToBytes(signature),
      new TextEncoder().encode(timestamp + body),
    );
    return { valid, body };
  } catch {
    return { valid: false, body };
  }
}
