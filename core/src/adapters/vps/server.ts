/** Minimal Node/VPS composition root. Production identity is supplied by the host. */
import { serve } from '@hono/node-server';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createConfirmationSigner } from '../../confirmation.js';
import { createHttpHandler } from '../../http.js';
import { serveUi } from '../../ui-assets.js';
import type { AppAuthenticator, Authenticator, ConfirmationSigner, Principal } from '../../ports.js';
import { createAppAuthenticator, headerClientAddress } from '../../app-auth.js';
import type { ClientAddress } from '../../app-auth.js';
import { parseAppConfigText, parseCaseSettingsText } from '../../app-config.js';
import type { CaseSettings } from '../../case-settings.js';
import { WorkspaceService } from '../../service.js';
import { SQLiteStore } from '../sqlite/store.js';

export const version: string = (JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
export interface ServerConfig {
  databasePath: string;
  origin: string;
  hostname?: string;
  port?: number;
  /** Case settings file (TOML or JSON). Without it every case operation fails closed. */
  caseSettingsPath?: string;
  /** Sending-app settings file ([[apps]] and [[scopes]], TOML or JSON). Needs appEnvironment and caseSettingsPath. */
  appsConfigPath?: string;
  /** This deployment's environment name, matched against each app's envs. */
  appEnvironment?: string;
  /**
   * Header a trusted reverse proxy sets to the single client address. Unset means
   * the TCP peer address. Set it only when every request passes that proxy.
   */
  clientIpHeader?: string;
}
interface LoadedCaseConfig {
  caseSettings?: CaseSettings;
  appAuthenticator?: AppAuthenticator;
}
function readText(path: string, what: string): string {
  // The path is operator configuration; the content is never echoed.
  try { return readFileSync(path, 'utf8'); } catch { throw new Error(`Cannot read the ${what} file`); }
}
/** Read and validate case and app settings once, before the database is opened. */
function loadCaseConfig(config: ServerConfig, clientAddress: ClientAddress): LoadedCaseConfig {
  if (config.appsConfigPath !== undefined) {
    if (!config.appEnvironment) throw new Error('DESKLY_APP_ENVIRONMENT is required with DESKLY_APPS_CONFIG_PATH');
    if (config.caseSettingsPath === undefined) throw new Error('DESKLY_CASE_SETTINGS_PATH is required with DESKLY_APPS_CONFIG_PATH');
  }
  const caseSettings = config.caseSettingsPath === undefined ? undefined
    : parseCaseSettingsText(readText(config.caseSettingsPath, 'case settings'));
  const appAuthenticator = config.appsConfigPath === undefined ? undefined : createAppAuthenticator({
    config: parseAppConfigText(readText(config.appsConfigPath, 'app settings')),
    environment: config.appEnvironment!,
    clientAddress: config.clientIpHeader === undefined ? clientAddress : headerClientAddress(config.clientIpHeader),
  });
  return { ...(caseSettings ? { caseSettings } : {}), ...(appAuthenticator ? { appAuthenticator } : {}) };
}
/** No built-in user, password or token. This implementation must be explicitly opted into. */
export function createDevelopmentAuthenticator(token: string, principal: Principal, mode: string | undefined): Authenticator {
  if (mode !== 'development' || token.length < 16 || /[\r\n]/.test(token)) {
    throw new Error('Fixed-token authentication requires NODE_ENV=development and a token of at least 16 characters');
  }
  const expected = createHash('sha256').update(`Bearer ${token}`).digest();
  const identity = structuredClone(principal);
  return { async authenticate(request) {
    const actual = createHash('sha256').update(request.headers.get('authorization') ?? '').digest();
    return timingSafeEqual(expected, actual) ? structuredClone(identity) : null;
  } };
}
export function configFromEnvironment(env: NodeJS.ProcessEnv): ServerConfig {
  const databasePath = env.DESKLY_SQLITE_PATH;
  if (!databasePath?.trim()) throw new Error('DESKLY_SQLITE_PATH is required');
  const portText = env.DESKLY_PORT ?? '3000';
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid DESKLY_PORT');
  const optional = (name: string): string | undefined => {
    const value = env[name];
    if (value === undefined) return undefined;
    if (!value.trim()) throw new Error(`${name} must not be blank`);
    return value;
  };
  const caseSettingsPath = optional('DESKLY_CASE_SETTINGS_PATH');
  const appsConfigPath = optional('DESKLY_APPS_CONFIG_PATH');
  const appEnvironment = optional('DESKLY_APP_ENVIRONMENT');
  const clientIpHeader = optional('DESKLY_CLIENT_IP_HEADER');
  return { databasePath, origin: env.DESKLY_PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`,
    hostname: env.DESKLY_HOST ?? '127.0.0.1', port,
    ...(caseSettingsPath === undefined ? {} : { caseSettingsPath }),
    ...(appsConfigPath === undefined ? {} : { appsConfigPath }),
    ...(appEnvironment === undefined ? {} : { appEnvironment }),
    ...(clientIpHeader === undefined ? {} : { clientIpHeader }) };
}
export async function startServer(config: ServerConfig, dependencies: { authenticator: Authenticator; signer: ConfirmationSigner }) {
  const publicUrl = new URL(config.origin);
  if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.origin !== config.origin) throw new Error('Invalid public origin');
  // The TCP peer of each request, kept beside the exact Request object the handler sees.
  const peers = new WeakMap<Request, string>();
  const loaded = loadCaseConfig(config, request => peers.get(request) ?? null);
  const store = await SQLiteStore.open(config.databasePath);
  try {
    const service = new WorkspaceService({ store, signer: dependencies.signer,
      clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID }, route: 'dashboard',
      ...(loaded.caseSettings ? { caseSettings: loaded.caseSettings } : {}) });
    const sharedHandler = createHttpHandler({ service, authenticator: dependencies.authenticator, origin: config.origin,
      ...(loaded.appAuthenticator ? { appAuthenticator: loaded.appAuthenticator } : {}) });
    const server = serve({ hostname: config.hostname ?? '127.0.0.1', port: config.port ?? 3000,
      fetch: async (request, env) => {
        const url = new URL(request.url);
        if (url.pathname === '/healthz' && (request.method === 'GET' || request.method === 'HEAD')) {
          return new Response(request.method === 'HEAD' ? null : JSON.stringify({ version }),
            { headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
        }
        // TLS may terminate at a reverse proxy. It must preserve the public Host.
        // Only substitute the configured scheme, never trust forwarded host/proto.
        if (url.host === publicUrl.host) url.protocol = publicUrl.protocol;
        const normalized = new Request(url, request);
        const peer = env.incoming.socket.remoteAddress;
        if (peer) peers.set(normalized, peer);
        return await serveUi(normalized, { origin: config.origin, authenticator: dependencies.authenticator })
          ?? sharedHandler(normalized);
      },
    });
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    return { server, store, async close(): Promise<void> {
      try { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
      finally { await store.close(); }
    } };
  } catch (error) { await store.close(); throw error; }
}

/** CLI is deliberately development-only until a production authenticator is provided. */
export async function startFromEnvironment(env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV !== 'development') throw new Error('Inject a production Authenticator via startServer; the CLI only supports development');
  const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (!id.test(env.DESKLY_DEV_WORKSPACE_ID ?? '') || !id.test(env.DESKLY_DEV_MEMBER_ID ?? '')) {
    throw new Error('Development workspace and member IDs must be canonical UUIDs');
  }
  const authenticator = createDevelopmentAuthenticator(env.DESKLY_DEV_TOKEN ?? '', {
    workspace_id: env.DESKLY_DEV_WORKSPACE_ID!, member_id: env.DESKLY_DEV_MEMBER_ID!, role: 'owner', active: true,
  }, env.NODE_ENV);
  // Development previews expire on restart; production supplies a stable signer.
  const signer = await createConfirmationSigner(new Uint8Array(randomBytes(32)));
  return startServer(configFromEnvironment(env), { authenticator, signer });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const running = await startFromEnvironment();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
    void running.close().catch(() => { process.exitCode = 1; });
  });
}
