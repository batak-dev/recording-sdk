import { describe, it, expect } from 'vitest';
import { createHmac, createHash } from 'node:crypto';
import {
  generateRSAKeyPair,
  exportPublicKeyToPEM,
  decryptSalt,
  signChunk
} from '../src/crypto';

describe('RSA salt encryption round-trip', () => {
  it('generates a usable key pair and exports a PEM public key', async () => {
    const pair = await generateRSAKeyPair();
    const pem = await exportPublicKeyToPEM(pair.publicKey);
    expect(pem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(pem).toMatch(/-----END PUBLIC KEY-----$/);
  });

  it('decrypts a salt that was encrypted with the matching public key', async () => {
    const pair = await generateRSAKeyPair();
    const salt = 'super-secret-salt-1234567890';

    const encrypted = await crypto.subtle.encrypt(
      { name: 'RSA-OAEP' },
      pair.publicKey,
      new TextEncoder().encode(salt)
    );
    const encryptedBase64 = btoa(String.fromCharCode(...new Uint8Array(encrypted)));

    const decrypted = await decryptSalt(encryptedBase64, pair.privateKey);
    expect(decrypted).toBe(salt);
  });
});

describe('signChunk (HMAC-SHA256)', () => {
  it('matches an independent Node HMAC implementation', async () => {
    const salt = 'the-salt';
    const chunkIndex = 7;
    const pathIdentifier = 'rec-abc';
    const webm = new Uint8Array([1, 2, 3, 4, 5]);

    const actual = await signChunk(salt, chunkIndex, pathIdentifier, webm);

    // Reproduce the documented signing scheme with Node's crypto.
    const blobHashHex = createHash('sha256').update(Buffer.from(webm)).digest('hex');
    const message = `${salt}:${chunkIndex}:${pathIdentifier}:${blobHashHex}`;
    const expected = createHmac('sha256', salt).update(message).digest('hex');

    expect(actual).toBe(expected);
    expect(actual).toHaveLength(64);
  });

  it('is deterministic and content-sensitive', async () => {
    const a = await signChunk('s', 1, 'p', new Uint8Array([1]));
    const aAgain = await signChunk('s', 1, 'p', new Uint8Array([1]));
    const b = await signChunk('s', 1, 'p', new Uint8Array([2]));
    expect(a).toBe(aAgain);
    expect(a).not.toBe(b);
  });
});
