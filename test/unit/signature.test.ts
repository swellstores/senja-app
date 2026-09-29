import { describe, it, expect } from 'vitest';
import { hmacSha256Hex, verifySenjaSignature } from '../../functions/lib/signature';

const secret = 'test-secret';

describe('hmacSha256Hex', () => {
  it('matches a known HMAC-SHA256 hex digest', async () => {
    // echo -n 'hello' | openssl dgst -sha256 -hmac 'test-secret'
    expect(await hmacSha256Hex(secret, 'hello')).toBe(
      'bcc889a40667cab715e1dc22ad280692cf4bf1c3a280eeeca60d8dbcd8e4b993',
    );
  });
});

describe('verifySenjaSignature', () => {
  const body = { type: 'testimonial_created', data: { new: { id: 't1' } } };

  it('accepts a signature over the raw body', async () => {
    const raw = JSON.stringify(body);
    const signature = await hmacSha256Hex(secret, raw);
    expect(await verifySenjaSignature(secret, raw, signature)).toBe(true);
  });

  it('accepts a signature over JSON.stringify(body) when the raw body is formatted differently', async () => {
    const raw = JSON.stringify(body, null, 2);
    const signature = await hmacSha256Hex(secret, JSON.stringify(body));
    expect(await verifySenjaSignature(secret, raw, signature)).toBe(true);
  });

  it('ignores case and surrounding whitespace in the header', async () => {
    const raw = JSON.stringify(body);
    const signature = (await hmacSha256Hex(secret, raw)).toUpperCase();
    expect(await verifySenjaSignature(secret, raw, ` ${signature} `)).toBe(true);
  });

  it('rejects a signature made with another secret', async () => {
    const raw = JSON.stringify(body);
    const signature = await hmacSha256Hex('other-secret', raw);
    expect(await verifySenjaSignature(secret, raw, signature)).toBe(false);
  });

  it('rejects a tampered body', async () => {
    const signature = await hmacSha256Hex(secret, JSON.stringify(body));
    const tampered = JSON.stringify({ ...body, type: 'testimonial_deleted' });
    expect(await verifySenjaSignature(secret, tampered, signature)).toBe(false);
  });

  it('rejects missing signature, secret or body, and invalid JSON', async () => {
    const raw = JSON.stringify(body);
    const signature = await hmacSha256Hex(secret, raw);
    expect(await verifySenjaSignature(secret, raw, null)).toBe(false);
    expect(await verifySenjaSignature('', raw, signature)).toBe(false);
    expect(await verifySenjaSignature(secret, '', signature)).toBe(false);
    expect(await verifySenjaSignature(secret, 'not json', await hmacSha256Hex(secret, 'not json'))).toBe(false);
  });
});
