import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { authHeaders, privateKeyFromSecret, signRequest } from '../src/pmus/sign.js';

/**
 * Generates a throwaway Ed25519 keypair per call. The JWK export of the
 * private key carries the raw 32-byte seed (`d`) and public key (`x`) as
 * base64url; the Polymarket US secret format is the libsodium-style 64-byte
 * concatenation seed||pub, base64-encoded. NEVER a real credential.
 */
function throwawayKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' }) as { d?: string; x?: string };
  const seed = Buffer.from(jwk.d!, 'base64url');
  const pub = Buffer.from(jwk.x!, 'base64url');
  expect(seed.length).toBe(32);
  expect(pub.length).toBe(32);
  const secretB64 = Buffer.concat([seed, pub]).toString('base64');
  return { secretB64, seed, publicKey };
}

const PATH = '/v1/portfolio/positions';
const TS = '1705420800000';

describe('privateKeyFromSecret', () => {
  it('accepts a 64-byte libsodium-style secret (seed||pub)', () => {
    const { secretB64 } = throwawayKeypair();
    const key = privateKeyFromSecret(secretB64);
    expect(key.asymmetricKeyType).toBe('ed25519');
  });

  it('accepts a bare 32-byte seed and derives the same signing key', () => {
    const { secretB64, seed } = throwawayKeypair();
    const key64 = privateKeyFromSecret(secretB64);
    const key32 = privateKeyFromSecret(seed.toString('base64'));
    // Ed25519 is deterministic: identical keys sign identically.
    expect(signRequest(key32, TS, 'GET', PATH)).toBe(signRequest(key64, TS, 'GET', PATH));
  });

  it('rejects a secret that decodes to 33 bytes', () => {
    const bogus = Buffer.alloc(33).toString('base64');
    expect(() => privateKeyFromSecret(bogus)).toThrow(/32 or 64 bytes/);
  });
});

describe('signRequest', () => {
  it('signs `${timestamp}${METHOD}${path}` verifiably with the public key', () => {
    const { secretB64, publicKey } = throwawayKeypair();
    const key = privateKeyFromSecret(secretB64);
    const sig = signRequest(key, TS, 'GET', PATH);
    const msg = Buffer.from('1705420800000GET/v1/portfolio/positions');
    expect(crypto.verify(null, msg, publicKey, Buffer.from(sig, 'base64'))).toBe(true);
  });

  it('upper-cases the method before signing', () => {
    const { secretB64, publicKey } = throwawayKeypair();
    const key = privateKeyFromSecret(secretB64);
    const sig = signRequest(key, TS, 'get', PATH);
    const msg = Buffer.from(`${TS}GET${PATH}`);
    expect(crypto.verify(null, msg, publicKey, Buffer.from(sig, 'base64'))).toBe(true);
  });

  it('does not verify against a different message', () => {
    const { secretB64, publicKey } = throwawayKeypair();
    const key = privateKeyFromSecret(secretB64);
    const sig = signRequest(key, TS, 'GET', PATH);
    const wrong = Buffer.from(`${TS}POST${PATH}`);
    expect(crypto.verify(null, wrong, publicKey, Buffer.from(sig, 'base64'))).toBe(false);
  });
});

describe('authHeaders', () => {
  it('emits the three X-PM-* headers with a fresh ms timestamp and a valid signature', () => {
    const { secretB64, publicKey } = throwawayKeypair();
    const key = privateKeyFromSecret(secretB64);

    const before = Date.now();
    const headers = authHeaders('test-key-id', key, 'GET', PATH);
    const after = Date.now();

    expect(Object.keys(headers).sort()).toEqual([
      'X-PM-Access-Key',
      'X-PM-Signature',
      'X-PM-Timestamp',
    ]);
    expect(headers['X-PM-Access-Key']).toBe('test-key-id');

    expect(headers['X-PM-Timestamp']).toMatch(/^\d{13}$/);
    const ts = Number(headers['X-PM-Timestamp']);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);

    // The signature must bind the exact timestamp emitted in the header.
    const msg = Buffer.from(`${headers['X-PM-Timestamp']}GET${PATH}`);
    expect(
      crypto.verify(null, msg, publicKey, Buffer.from(headers['X-PM-Signature'], 'base64')),
    ).toBe(true);
  });
});
