/** Access JWT validation is host-specific; authorization remains in the service. */
import type { Authenticator, Principal, MachineReadAuthenticator } from '../../ports.js';
export interface AccessKey extends JsonWebKey { kid?: string }
export interface AccessIdentity {
  /** Issuer-scoped Access subject, never a display name or client actor field. */
  subject: string;
  email: string;
  principal: Principal;
}
export interface AccessConfig {
  issuer: string;
  audience: string;
  identities: readonly AccessIdentity[];
  loadKeys: () => Promise<readonly AccessKey[]>;
  now?: () => number;
}
export interface MachineReadScope {
  client_id: string;
  workspace_id: string;
  project_ids: readonly string[];
}
const stableId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Missing means disabled; malformed configuration never falls back to owner access. */
export function parseMachineReadScopes(text: string | undefined): readonly MachineReadScope[] {
  if (text === undefined) return [];
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error('Invalid machine read configuration');
  const clients = new Set<string>();
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
      Object.keys(item).sort().join(',') !== 'client_id,project_ids,workspace_id' ||
      !validText(item.client_id) || item.client_id.length > 256 || !/^[\x21-\x7e]+$/.test(item.client_id) ||
      clients.has(item.client_id) || typeof item.workspace_id !== 'string' || !stableId.test(item.workspace_id) ||
      !Array.isArray(item.project_ids) || !item.project_ids.length ||
      !item.project_ids.every((id: unknown) => typeof id === 'string' && stableId.test(id)) ||
      new Set(item.project_ids).size !== item.project_ids.length) throw new Error('Invalid machine read configuration');
    clients.add(item.client_id);
  }
  return structuredClone(parsed) as MachineReadScope[];
}
const validText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.trim() === value;
export function trustedOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) throw new Error('Invalid trusted origin');
  return url.origin;
}
function bytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new Error('Invalid token encoding');
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')), c => c.charCodeAt(0));
}
function part(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes(value)));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid token');
  return parsed as Record<string, unknown>;
}
export function createAccessAuthenticator(config: AccessConfig): Authenticator {
  if (!validText(config.audience) || !Array.isArray(config.identities) || !config.identities.length) throw new Error('Invalid Access configuration');
  const identities = structuredClone(config.identities);
  const subjects = new Set<string>();
  for (const identity of identities) {
    const p = identity?.principal;
    if (!validText(identity?.subject) || !validText(identity?.email) || subjects.has(identity.subject) || !p ||
      !validText(p.workspace_id) || !validText(p.member_id) || !validText(p.account_subject) ||
      !['owner', 'member'].includes(p.role) || typeof p.active !== 'boolean') throw new Error('Invalid Access identity mapping');
    subjects.add(identity.subject);
  }
  const verify = verifiedPayload(config);
  return { async authenticate(request) {
    const payload = await verify(request);
    if (!payload || !validText(payload.sub) || !validText(payload.email)) return null;
    const identity = identities.find(item => item.subject === payload.sub && item.email.toLowerCase() === (payload.email as string).toLowerCase());
    return identity?.principal.active === true ? structuredClone(identity.principal) : null;
  } };
}
export function createMachineReadAuthenticator(config: Omit<AccessConfig, 'identities'> & { scopes: readonly MachineReadScope[] }): MachineReadAuthenticator {
  // Revalidate programmatic callers too; no unchecked principal construction.
  const scopes = parseMachineReadScopes(JSON.stringify(config.scopes));
  const verify = verifiedPayload(config);
  if (!scopes.length) return { async authenticate() { return null; } };
  return { async authenticate(request) {
    const payload = await verify(request);
    if (!payload || payload.type !== 'app' || payload.sub !== '' || payload.email !== undefined || !validText(payload.common_name)) return null;
    const scope = scopes.find(item => item.client_id === payload.common_name);
    return scope ? { kind: 'machine-read', service_id: scope.client_id, workspace_id: scope.workspace_id, project_ids: [...scope.project_ids] } : null;
  } };
}
function verifiedPayload(config: Omit<AccessConfig, 'identities'>): (request: Request) => Promise<Record<string, unknown> | null> {
  const issuer = trustedOrigin(config.issuer);
  if (!validText(config.audience)) throw new Error('Invalid Access configuration');
  return async (request: Request): Promise<Record<string, unknown> | null> => {
    try {
      const raw = request.headers.get('Cf-Access-Jwt-Assertion');
      if (!raw || raw.length > 8192) return null;
      const parts = raw.split('.');
      if (parts.length !== 3) return null;
      const header = part(parts[0]!);
      const payload = part(parts[1]!);
      if (header.alg !== 'RS256' || !validText(header.kid) || header.kid.length > 128 ||
        (header.typ !== undefined && header.typ !== 'JWT') || header.crit !== undefined || header.b64 !== undefined) return null;
      const now = (config.now ?? (() => Date.now() / 1000))();
      const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!Number.isFinite(now) || payload.iss !== issuer || !audience.every(validText) || !audience.includes(config.audience) ||
        typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= now ||
        typeof payload.iat !== 'number' || !Number.isFinite(payload.iat) || payload.iat > now + 60 || payload.iat >= payload.exp ||
        (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || !Number.isFinite(payload.nbf) || payload.nbf > now))) return null;
      const matching = (await config.loadKeys()).filter(key => key.kid === header.kid && key.kty === 'RSA' &&
        (key.alg === undefined || key.alg === 'RS256') && (key.use === undefined || key.use === 'sig') &&
        (key.key_ops === undefined || key.key_ops.includes('verify')) && key.d === undefined);
      if (matching.length !== 1) return null;
      const key = await crypto.subtle.importKey('jwk', matching[0]!, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
      const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, bytes(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
      return valid ? payload : null;
    } catch { return null; } // Malformed tokens, unavailable keys and import failures all fail closed.
  };
}
/** The trusted issuer alone selects the key endpoint; JWT jku/x5u are never used. */
export function accessKeyLoader(issuer: string, fetcher: typeof fetch = fetch): () => Promise<readonly AccessKey[]> {
  const endpoint = `${trustedOrigin(issuer)}/cdn-cgi/access/certs`;
  return async () => {
    // Workers does not implement redirect:'error'. Manual plus !ok rejects
    // every redirect without following an untrusted key endpoint.
    const response = await fetcher(endpoint, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Access keys unavailable');
    const result: unknown = await response.json();
    if (!result || typeof result !== 'object' || !('keys' in result) || !Array.isArray(result.keys)) throw new Error('Invalid Access keys');
    return result.keys as AccessKey[];
  };
}
