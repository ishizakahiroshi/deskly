/** Workers composition root. Provision/migrate DB separately; fetch never runs DDL. */
import { createAppAuthenticator, headerClientAddress } from '../../app-auth.js';
import { parseAppConfigText, parseCaseSettingsText } from '../../app-config.js';
import type { CaseSettings } from '../../case-settings.js';
import { createConfirmationSigner } from '../../confirmation.js';
import { createHttpHandler } from '../../http.js';
import { serveUi } from '../../ui-assets.js';
import type { AppAuthenticator, Store } from '../../ports.js';
import { WorkspaceService } from '../../service.js';
import type { D1Driver } from '../d1/driver.js';
import { D1Store } from '../d1/store.js';
import { accessKeyLoader, createAccessAuthenticator, trustedOrigin } from './access.js';
import type { AccessIdentity, AccessKey } from './access.js';
export interface WorkerBindings {
  DB: D1Driver;
  PUBLIC_ORIGIN: string;
  ACCESS_ISSUER: string;
  ACCESS_AUD: string;
  ACCESS_IDENTITIES: string;
  /** Secret binding, stable across instances; at least 32 UTF-8 bytes. */
  CONFIRMATION_SECRET: string;
  /** Case settings (TOML or JSON text). Without it every case operation fails closed. */
  CASE_SETTINGS?: string;
  /** Sending-app settings ([[apps]] and [[scopes]], TOML or JSON text). Needs the three bindings below. */
  APPS_CONFIG?: string;
  /** This deployment's environment name, matched against each app's envs. */
  APP_ENVIRONMENT?: string;
  /** Header Cloudflare sets to the client address (normally CF-Connecting-IP). Required with APPS_CONFIG. */
  CLIENT_IP_HEADER?: string;
}
export interface WorkerDependencies {
  store?: (env: WorkerBindings) => Store;
  loadKeys?: (issuer: string) => Promise<readonly AccessKey[]>;
  now?: () => number;
}
interface CaseConfig { caseSettings?: CaseSettings; appAuthenticator?: AppAuthenticator }
/** Validate case and app bindings; any problem makes the Worker unavailable rather than open. */
function caseConfig(env: WorkerBindings): CaseConfig {
  const text = (value: unknown, name: string): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid ${name} binding`);
    return value;
  };
  const settingsText = text(env.CASE_SETTINGS, 'CASE_SETTINGS');
  const appsText = text(env.APPS_CONFIG, 'APPS_CONFIG');
  const environment = text(env.APP_ENVIRONMENT, 'APP_ENVIRONMENT');
  const header = text(env.CLIENT_IP_HEADER, 'CLIENT_IP_HEADER');
  if (appsText !== undefined && (settingsText === undefined || environment === undefined || header === undefined)) {
    throw new Error('APPS_CONFIG requires CASE_SETTINGS, APP_ENVIRONMENT and CLIENT_IP_HEADER');
  }
  return {
    ...(settingsText === undefined ? {} : { caseSettings: parseCaseSettingsText(settingsText) }),
    ...(appsText === undefined ? {} : { appAuthenticator: createAppAuthenticator({ config: parseAppConfigText(appsText),
      environment: environment!, clientAddress: headerClientAddress(header!) }) }),
  };
}
export function createWorker(dependencies: WorkerDependencies = {}) {
  return { async fetch(request: Request, env: WorkerBindings): Promise<Response> {
    try {
      const origin = trustedOrigin(env.PUBLIC_ORIGIN);
      const issuer = trustedOrigin(env.ACCESS_ISSUER);
      if (!env.DB || typeof env.CONFIRMATION_SECRET !== 'string') throw new Error('Invalid bindings');
      const identities = JSON.parse(env.ACCESS_IDENTITIES) as AccessIdentity[];
      const authenticator = createAccessAuthenticator({ issuer, audience: env.ACCESS_AUD, identities,
        loadKeys: dependencies.loadKeys ? () => dependencies.loadKeys!(issuer) : accessKeyLoader(issuer),
        ...(dependencies.now ? { now: dependencies.now } : {}) });
      const cases = caseConfig(env);
      const ui = await serveUi(request, { origin, authenticator });
      if (ui) return ui;
      const store = dependencies.store?.(env) ?? new D1Store(env.DB);
      const signer = await createConfirmationSigner(new TextEncoder().encode(env.CONFIRMATION_SECRET));
      const service = new WorkspaceService({ store, signer,
        clock: { now: () => new Date((dependencies.now?.() ?? Date.now() / 1000) * 1000).toISOString() },
        ids: { next: () => crypto.randomUUID() }, route: 'dashboard',
        ...(cases.caseSettings ? { caseSettings: cases.caseSettings } : {}) });
      return await createHttpHandler({ service, authenticator, origin,
        ...(cases.appAuthenticator ? { appAuthenticator: cases.appAuthenticator } : {}) })(request);
    } catch {
      return Response.json({ error: 'worker_unavailable' }, { status: 503, headers: { 'cache-control': 'no-store' } });
    }
  } };
}
export default createWorker();
