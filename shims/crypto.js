// Browser shim for Node's `crypto`. @here-wallet/core imports it for a hash
// helper; the Web Crypto API is present in every browser this page supports.
// This module exposes only what the wallet code actually calls.
export function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export const webcrypto = globalThis.crypto;

export default { randomBytes, webcrypto };
