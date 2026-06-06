// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import {
  createSignedChunkBlob,
  parseSignedChunkBlob,
  getSignedChunkFormatSpec,
  type SignedChunkMetadata
} from '../src/signedChunk';

const sig = 'a'.repeat(64); // valid 64-char HMAC-SHA256 hex placeholder

describe('signed chunk format', () => {
  it('round-trips signature, metadata, and webm payload', async () => {
    const webm = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x1a, 0x45]);
    const metadata: SignedChunkMetadata = {
      chunkIndex: 3,
      pathIdentifier: 'rec-xyz',
      timestamp: 1_700_000_000_000,
      questionOrder: 2
    };

    const blob = createSignedChunkBlob(webm, sig, metadata);
    const parsed = await parseSignedChunkBlob(blob);

    expect(parsed.signature).toBe(sig);
    expect(parsed.metadata).toEqual(metadata);
    expect(Array.from(parsed.webmData)).toEqual(Array.from(webm));
  });

  it('rejects a signature of the wrong length', () => {
    expect(() =>
      createSignedChunkBlob(new Uint8Array([1]), 'tooshort', {
        chunkIndex: 1,
        pathIdentifier: 'p',
        timestamp: 0,
        questionOrder: 1
      })
    ).toThrow(/Invalid signature length/);
  });

  it('rejects a blob with a corrupt header', async () => {
    const bad = new Blob([new TextEncoder().encode('NOTRECSIG').buffer]);
    await expect(parseSignedChunkBlob(bad)).rejects.toThrow(/Invalid header/);
  });

  it('exposes a format spec for backend implementers', () => {
    expect(getSignedChunkFormatSpec()).toContain('Signed Chunk File Format');
  });
});
