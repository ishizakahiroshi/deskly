import type { ConfirmationSigner } from './ports.js';
export { canonical } from './service-validation.js';
const hex = (value: ArrayBuffer): string => Array.from(new Uint8Array(value), b => b.toString(16).padStart(2, '0')).join('');
const bytes = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);
/** Web Crypto only. Inject the same server-owned key on every host/instance. */
export async function createConfirmationSigner(secret: Uint8Array<ArrayBuffer>): Promise<ConfirmationSigner> {
  if (secret.byteLength < 32) throw new Error('Confirmation key must contain at least 32 bytes');
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  return {
    sign: async payload => hex(await crypto.subtle.sign('HMAC', key, bytes(payload))),
    verify: async (payload, signature) => {
      if (!/^[0-9a-f]{64}$/.test(signature)) return false;
      const signatureBytes = Uint8Array.from(signature.match(/../g) ?? [], byte => Number.parseInt(byte, 16));
      return crypto.subtle.verify('HMAC', key, signatureBytes, bytes(payload));
    },
    digest: async payload => hex(await crypto.subtle.digest('SHA-256', bytes(payload))),
  };
}
