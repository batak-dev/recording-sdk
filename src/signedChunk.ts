/**
 * Signed Chunk Format Utilities
 * 
 * File format:
 * [Header: 8 bytes "RECSIG\n\n"]
 * [Signature: 64 bytes hex string (HMAC-SHA256)]
 * [Metadata: JSON string terminated by newline]
 * [WebM data: rest of file]
 * 
 * This self-contained format allows backend to validate without external metadata.
 */

const SIGNATURE_HEADER = 'RECSIG\n\n'; // 8 bytes
const SIGNATURE_LENGTH = 64; // HMAC-SHA256 hex = 64 chars

export interface SignedChunkMetadata {
  chunkIndex: number;
  pathIdentifier: string;
  timestamp: number;
  // 1-based interview question active when this chunk was produced. Drives
  // server-side segmentation (one question = one segment). Not covered by the
  // signature (which protects only the WebM bytes), so older chunks decode to 0.
  questionOrder: number;
}

/**
 * Create a signed chunk file with embedded signature and metadata
 */
export function createSignedChunkBlob(
  webmData: Uint8Array,
  signature: string,
  metadata: SignedChunkMetadata
): Blob {
  if (signature.length !== SIGNATURE_LENGTH) {
    throw new Error(`Invalid signature length: ${signature.length}, expected ${SIGNATURE_LENGTH}`);
  }
  
  // Encode components
  const headerBytes = new TextEncoder().encode(SIGNATURE_HEADER);
  const signatureBytes = new TextEncoder().encode(signature);
  const metadataJson = JSON.stringify(metadata) + '\n';
  const metadataBytes = new TextEncoder().encode(metadataJson);
  
  // Calculate total size
  const totalSize = headerBytes.length + signatureBytes.length + metadataBytes.length + webmData.length;
  
  // Create combined buffer
  const combined = new Uint8Array(totalSize);
  let offset = 0;
  
  // Write header
  combined.set(headerBytes, offset);
  offset += headerBytes.length;
  
  // Write signature
  combined.set(signatureBytes, offset);
  offset += signatureBytes.length;
  
  // Write metadata
  combined.set(metadataBytes, offset);
  offset += metadataBytes.length;
  
  // Write WebM data
  combined.set(webmData, offset);
  
  return new Blob([combined], { type: 'application/octet-stream' });
}

/**
 * Parse a signed chunk file (for testing/validation)
 */
export function parseSignedChunkBlob(blob: Blob): Promise<{
  signature: string;
  metadata: SignedChunkMetadata;
  webmData: Uint8Array;
}> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    
    reader.onload = () => {
      try {
        const buffer = new Uint8Array(reader.result as ArrayBuffer);
        let offset = 0;
        
        // Read header
        const headerLength = SIGNATURE_HEADER.length;
        const header = new TextDecoder().decode(buffer.slice(offset, offset + headerLength));
        
        if (header !== SIGNATURE_HEADER) {
          throw new Error(`Invalid header: expected "${SIGNATURE_HEADER}", got "${header}"`);
        }
        offset += headerLength;
        
        // Read signature
        const signature = new TextDecoder().decode(buffer.slice(offset, offset + SIGNATURE_LENGTH));
        offset += SIGNATURE_LENGTH;
        
        // Read metadata (JSON terminated by newline)
        let metadataEnd = offset;
        while (metadataEnd < buffer.length && buffer[metadataEnd] !== 10) { // 10 = '\n'
          metadataEnd++;
        }
        
        const metadataJson = new TextDecoder().decode(buffer.slice(offset, metadataEnd));
        const metadata = JSON.parse(metadataJson);
        offset = metadataEnd + 1; // Skip newline
        
        // Read WebM data
        const webmData = buffer.slice(offset);
        
        resolve({ signature, metadata, webmData });
      } catch (error) {
        reject(error);
      }
    };
    
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/**
 * Get file format documentation for backend implementation
 */
export function getSignedChunkFormatSpec(): string {
  return `
Signed Chunk File Format (*.rchunk)
===================================

Binary format with embedded signature for self-contained validation.

Structure:
----------
[Header: 8 bytes]     "RECSIG\\n\\n" (ASCII)
[Signature: 64 bytes] HMAC-SHA256 hex string (lowercase)
[Metadata: variable]  JSON string + newline
[Data: rest]          WebM video data

Metadata JSON fields:
---------------------
{
  "chunkIndex": number,       // Chunk sequence number (1-based)
  "pathIdentifier": string,   // Recording identifier
  "timestamp": number,        // Unix timestamp (milliseconds)
  "questionOrder": number     // 1-based question active for this chunk (segmentation)
}

Signature Calculation:
----------------------
1. Extract WebM data (everything after metadata newline)
2. Compute: blobHash = SHA256(webmData)
3. Get salt from database using pathIdentifier
4. Compute: message = "{salt}:{chunkIndex}:{pathIdentifier}:{blobHash}"
5. Compute: signature = HMAC-SHA256(salt, message)
6. Compare with embedded signature (constant-time)

Example Validation (Python):
-----------------------------
import hmac
import hashlib
import json

def validate_signed_chunk(file_path):
    with open(file_path, 'rb') as f:
        # Read header
        header = f.read(8)
        assert header == b'RECSIG\\n\\n', "Invalid header"
        
        # Read signature
        signature = f.read(64).decode('ascii')
        
        # Read metadata (until newline)
        metadata_bytes = b''
        while True:
            char = f.read(1)
            if char == b'\\n':
                break
            metadata_bytes += char
        
        metadata = json.loads(metadata_bytes.decode('utf-8'))
        
        # Read WebM data
        webm_data = f.read()
    
    # Validate signature
    salt = get_salt_from_db(metadata['pathIdentifier'])
    blob_hash = hashlib.sha256(webm_data).hexdigest()
    message = f"{salt}:{metadata['chunkIndex']}:{metadata['pathIdentifier']}:{blob_hash}"
    expected_sig = hmac.new(
        salt.encode('utf-8'),
        message.encode('utf-8'),
        hashlib.sha256
    ).hexdigest()
    
    if not hmac.compare_digest(expected_sig, signature):
        raise ValueError("Signature validation failed")
    
    return metadata, webm_data

Advantages:
-----------
✓ Self-contained: All validation data in one file
✓ No external metadata required
✓ Simpler API: Just upload file
✓ Tamper-evident: Can't modify without invalidating signature
✓ Forward-compatible: Header allows version detection
`.trim();
}
