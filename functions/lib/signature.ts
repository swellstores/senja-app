const encoder = new TextEncoder();

export async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Senja signs JSON.stringify(body) with HMAC-SHA256 (hex) and sends it in `x-senja-signature`.
 * Accept a match against the raw body or its re-serialized JSON, since either may be what Senja hashed.
 */
export async function verifySenjaSignature(
  secret: string,
  rawBody: string,
  signature: string | null,
): Promise<boolean> {
  if (!secret || !signature || !rawBody) {
    return false;
  }
  const expected = signature.trim().toLowerCase();

  const candidates = [rawBody];
  try {
    const reserialized = JSON.stringify(JSON.parse(rawBody));
    if (reserialized !== rawBody) {
      candidates.push(reserialized);
    }
  } catch {
    return false;
  }

  for (const payload of candidates) {
    if (timingSafeEqual(await hmacSha256Hex(secret, payload), expected)) {
      return true;
    }
  }
  return false;
}
