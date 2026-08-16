import crypto from 'node:crypto';

// ASN.1/DER wrapper for a raw Ed25519 seed -> PKCS#8 (RFC 8410).
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * Polymarket US secret keys decode to 64 bytes in libsodium "secret key"
 * layout: 32-byte Ed25519 seed || 32-byte public key. node:crypto only
 * needs the seed, DER-wrapped as PKCS#8.
 */
export function privateKeyFromSecret(secretB64: string): crypto.KeyObject {
  const raw = Buffer.from(secretB64, 'base64');
  if (raw.length !== 64 && raw.length !== 32) {
    throw new Error(`PMUS_SECRET must base64-decode to 32 or 64 bytes, got ${raw.length}`);
  }
  const seed = raw.subarray(0, 32);
  return crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

/**
 * Signature message is `${timestampMs}${METHOD}${path}`.
 * `path` must EXCLUDE the query string: signing "/v1/x?limit=5" -> 401,
 * signing "/v1/x" for a request to "/v1/x?limit=5" -> 200 (verified live).
 */
export function signRequest(
  key: crypto.KeyObject,
  timestampMs: string,
  method: string,
  path: string,
): string {
  const msg = Buffer.from(`${timestampMs}${method.toUpperCase()}${path}`);
  return crypto.sign(null, msg, key).toString('base64');
}

export function authHeaders(
  keyId: string,
  key: crypto.KeyObject,
  method: string,
  path: string,
): Record<string, string> {
  const ts = Date.now().toString();
  return {
    'X-PM-Access-Key': keyId,
    'X-PM-Timestamp': ts,
    'X-PM-Signature': signRequest(key, ts, method, path),
  };
}
