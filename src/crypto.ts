/**
 * Cryptographic utilities for chunk signing and encryption
 */

/**
 * Generate RSA key pair for salt encryption
 */
export async function generateRSAKeyPair(): Promise<CryptoKeyPair> {
  return await crypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['encrypt', 'decrypt']
  );
}

/**
 * Export public key to PEM format
 */
export async function exportPublicKeyToPEM(publicKey: CryptoKey): Promise<string> {
  const exported = await crypto.subtle.exportKey('spki', publicKey);
  const exportedAsString = String.fromCharCode(...new Uint8Array(exported));
  const exportedAsBase64 = btoa(exportedAsString);
  return `-----BEGIN PUBLIC KEY-----\n${exportedAsBase64}\n-----END PUBLIC KEY-----`;
}

/**
 * Decrypt salt using private key
 */
export async function decryptSalt(
  encryptedSaltBase64: string,
  privateKey: CryptoKey
): Promise<string> {
  const encryptedData = Uint8Array.from(atob(encryptedSaltBase64), c => c.charCodeAt(0));
  
  const decrypted = await crypto.subtle.decrypt(
    {
      name: 'RSA-OAEP',
    },
    privateKey,
    encryptedData
  );
  
  const decoder = new TextDecoder();
  return decoder.decode(decrypted);
}

/**
 * Generate HMAC signature for chunk (includes blob content hash for integrity)
 */
export async function signChunk(
  salt: string,
  chunkIndex: number,
  pathIdentifier: string,
  blobData: Uint8Array
): Promise<string> {
  // Step 1: Hash the blob content with SHA-256
  const blobHash = await crypto.subtle.digest('SHA-256', new Uint8Array(blobData));
  const blobHashHex = Array.from(new Uint8Array(blobHash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  
  // Step 2: Create message including blob hash
  const data = `${salt}:${chunkIndex}:${pathIdentifier}:${blobHashHex}`;
  
  // Step 3: Import salt as HMAC key
  const encoder = new TextEncoder();
  const keyData = encoder.encode(salt);
  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  // Step 4: Sign the data with HMAC-SHA256
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(data)
  );
  
  // Step 5: Convert to hex string
  const hashArray = Array.from(new Uint8Array(signature));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
