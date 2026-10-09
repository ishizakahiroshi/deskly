/**
 * Sending-app authentication: a Bearer token is hashed (SHA-256) and compared
 * with every configured key hash without stopping at the first match, then the
 * deployment environment and the client address are checked. Any failure is
 * the same null (HTTP 401); the reason is never reported. The token itself is
 * never stored, logged or returned. Web Crypto only, so Node and Workers share it.
 */
import { ipInRange, parseIpAddress, parseIpRange } from './app-config.js';
import type { AppConfig, IpRange } from './app-config.js';
import type { AppAuthenticator, AppPrincipal } from './ports.js';

/** Resolves the client address from trusted transport data; null when unknown. */
export type ClientAddress = (request: Request) => string | null;
export interface AppAuthOptions {
  config: AppConfig;
  /** This deployment's environment name; an app is accepted only if listed in its envs. */
  environment: string;
  clientAddress: ClientAddress;
}

/** Tokens shorter than this are refused outright: a short token is guessable from its hash. */
export const MIN_TOKEN_LENGTH = 32;
const MAX_TOKEN_LENGTH = 512;
const BEARER = /^Bearer ([\x21-\x7e]+)$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;

interface CompiledApp {
  readonly principal: AppPrincipal;
  readonly hashes: readonly Uint8Array[];
  readonly envs: readonly string[];
  readonly ranges: readonly IpRange[];
}
function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from({ length: hex.length / 2 }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));
}
/** Same work for equal and unequal inputs of the fixed digest length. */
function equalDigests(a: Uint8Array, b: Uint8Array): boolean {
  let difference = a.length ^ b.length;
  for (let index = 0; index < a.length; index++) difference |= a[index]! ^ (b[index] ?? 0);
  return difference === 0;
}

export function createAppAuthenticator(options: AppAuthOptions): AppAuthenticator {
  const { config, environment, clientAddress } = options;
  if (typeof environment !== 'string' || !environment) throw new Error('App authentication requires the deployment environment name');
  if (typeof clientAddress !== 'function') throw new Error('App authentication requires a client address resolver');
  const apps: CompiledApp[] = config.apps.map(app => {
    const scope = config.scopes.find(entry => entry.app === app.name);
    if (!scope) throw new Error('App settings were not validated');
    return {
      principal: { kind: 'app', workspace_id: scope.workspace_id, app: app.name, sources: [...scope.source], tenants: [...scope.tenant] },
      hashes: app.keys_sha256.map(hexBytes),
      envs: [...app.envs],
      ranges: app.allow_ips.map(range => {
        const parsed = parseIpRange(range);
        if (!parsed) throw new Error('App settings were not validated');
        return parsed;
      }),
    };
  });
  return { async authenticate(request) {
    const match = BEARER.exec(request.headers.get('authorization') ?? '');
    const token = match?.[1];
    if (!token || token.length < MIN_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH) return null;
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
    // Compare against every key of every app; never return early on a match.
    let found: CompiledApp | null = null;
    for (const app of apps) {
      let matched = false;
      for (const hash of app.hashes) matched = equalDigests(digest, hash) || matched;
      if (matched) found = app;
    }
    if (!found || !found.envs.includes(environment)) return null;
    const text = clientAddress(request);
    const address = typeof text === 'string' ? parseIpAddress(text) : null;
    if (!address || !found.ranges.some(range => ipInRange(address, range))) return null;
    return structuredClone(found.principal);
  } };
}

/**
 * Client address from one header set by a trusted front (for example a reverse
 * proxy's single-address header, or CF-Connecting-IP on Cloudflare). A missing
 * header, a list of addresses or anything that is not one address is unknown.
 * Use only when every request reaches the service through that front.
 */
export function headerClientAddress(name: string): ClientAddress {
  if (!HEADER_NAME.test(name)) throw new Error('Invalid client address header name');
  return request => {
    const value = request.headers.get(name)?.trim();
    return value && parseIpAddress(value) ? value : null;
  };
}
