export interface DeviceIdentity {
  privateKey: CryptoKey;
  publicKeyBase64: string;
}

const deviceIdentityCache = new Map<string, Promise<DeviceIdentity>>();

function privateKeyStorageKey(userId: string) {
  return `privKey_${userId}`;
}

function isStoredPrivateKey(jwk: JsonWebKey): jwk is JsonWebKey & {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  d: string;
} {
  return jwk.kty === 'EC'
    && jwk.crv === 'P-256'
    && typeof jwk.x === 'string'
    && typeof jwk.y === 'string'
    && typeof jwk.d === 'string';
}

async function importPublicKeyFromPrivateJwk(jwk: JsonWebKey) {
  if (!isStoredPrivateKey(jwk)) {
    throw new Error('Stored secure messaging identity is invalid.');
  }

  return window.crypto.subtle.importKey(
    'jwk',
    {
      kty: jwk.kty,
      crv: jwk.crv,
      x: jwk.x,
      y: jwk.y,
      ext: true,
    },
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  );
}

async function loadDeviceIdentity(userId: string): Promise<DeviceIdentity> {
  if (typeof window === 'undefined') {
    throw new Error('Secure messaging is only available in a browser.');
  }

  const storedJwk = window.localStorage.getItem(privateKeyStorageKey(userId));
  if (storedJwk) {
    let parsedJwk: JsonWebKey;
    try {
      parsedJwk = JSON.parse(storedJwk) as JsonWebKey;
    } catch {
      throw new Error('Stored secure messaging identity is invalid.');
    }

    if (!isStoredPrivateKey(parsedJwk)) {
      throw new Error('Stored secure messaging identity is invalid.');
    }

    const privateKey = await importPrivateKey(parsedJwk);
    const publicKey = await importPublicKeyFromPrivateJwk(parsedJwk);
    return { privateKey, publicKeyBase64: await exportPublicKey(publicKey) };
  }

  const keyPair = await generateKeyPair();
  const privateJwk = await exportPrivateKey(keyPair.privateKey);
  // Persist only the private JWK. The public half is safe to sync separately,
  // while the private key remains browser-local for the device lifetime.
  window.localStorage.setItem(privateKeyStorageKey(userId), JSON.stringify(privateJwk));
  return { privateKey: keyPair.privateKey, publicKeyBase64: await exportPublicKey(keyPair.publicKey) };
}

/**
 * Load one stable device identity per signed-in user for this browser tab.
 * A rejected promise is evicted so a transient storage failure can be retried;
 * an invalid stored identity is never silently replaced with a new key.
 */
export function getDeviceIdentity(userId: string): Promise<DeviceIdentity> {
  const cached = deviceIdentityCache.get(userId);
  if (cached) return cached;

  const identityPromise = loadDeviceIdentity(userId).catch((error: unknown) => {
    deviceIdentityCache.delete(userId);
    throw error;
  });
  deviceIdentityCache.set(userId, identityPromise);
  return identityPromise;
}

// Generate an ECDH keypair for the user's session
export async function generateKeyPair(): Promise<CryptoKeyPair> {
    return await window.crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveKey", "deriveBits"]
    );
  }
  
  // Convert public CryptoKey to Base64 string for storage in Supabase
  export async function exportPublicKey(key: CryptoKey): Promise<string> {
    const exported = await window.crypto.subtle.exportKey("spki", key);
    return btoa(String.fromCharCode(...new Uint8Array(exported)));
  }
  
  // Derive shared secret AES-GCM key using local private key + partner's public key
  export async function deriveSharedKey(
    privateKey: CryptoKey, 
    recipientPublicKeyBase64: string
  ): Promise<CryptoKey> {
    const binaryDer = Uint8Array.from(atob(recipientPublicKeyBase64), c => c.charCodeAt(0));
    const importedPublicKey = await window.crypto.subtle.importKey(
      "spki",
      binaryDer,
      { name: "ECDH", namedCurve: "P-256" },
      true,
      []
    );
  
    return await window.crypto.subtle.deriveKey(
      { name: "ECDH", public: importedPublicKey },
      privateKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }
  
  // Encrypt plain text using the shared key
  export async function encryptMessage(text: string, sharedKey: CryptoKey) {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(text);
    const ciphertextBuffer = await window.crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      sharedKey,
      encoded
    );
  
    return {
      ciphertext: btoa(String.fromCharCode(...new Uint8Array(ciphertextBuffer))),
      iv: btoa(String.fromCharCode(...iv))
    };
  }
  
  // Decrypt base64 ciphertext using shared key
  export async function decryptMessage(
    ciphertextBase64: string, 
    ivBase64: string, 
    sharedKey: CryptoKey
  ): Promise<string> {
    const cipherArray = Uint8Array.from(atob(ciphertextBase64), c => c.charCodeAt(0));
    const iv = Uint8Array.from(atob(ivBase64), c => c.charCodeAt(0));
  
    const decryptedBuffer = await window.crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      sharedKey,
      cipherArray
    );
  
    return new TextDecoder().decode(decryptedBuffer);
  }
  // Export Private Key to JSON format for browser storage
export async function exportPrivateKey(key: CryptoKey): Promise<JsonWebKey> {
    return await window.crypto.subtle.exportKey("jwk", key);
  }
  
  // Import Private Key from JSON format back into a CryptoKey
  export async function importPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
    return await window.crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveKey", "deriveBits"]
    );
  }
