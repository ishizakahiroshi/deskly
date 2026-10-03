/** Owner-only deployment boundary. Never provisions or migrates a database. */
import { accessKeyLoader, createAccessAuthenticator, trustedOrigin } from './access.js';
import type { AccessIdentity } from './access.js';
import { createWorker } from './worker.js';
import type { WorkerBindings, WorkerDependencies } from './worker.js';
export interface PersonalBindings extends WorkerBindings { REVISION: string }
const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
export function createPersonalWorker(dependencies: WorkerDependencies = {}) {
  return { async fetch(request: Request, env: PersonalBindings): Promise<Response> {
    try {
      const origin = trustedOrigin(env.PUBLIC_ORIGIN);
      const issuer = trustedOrigin(env.ACCESS_ISSUER);
      const url = new URL(request.url);
      const host = request.headers.get('host');
      if (url.origin !== origin || (host !== null && host.toLowerCase() !== new URL(origin).host.toLowerCase()) ||
        (request.headers.has('origin') && request.headers.get('origin') !== origin)) {
        return Response.json({ error: 'forbidden' }, { status: 403, headers });
      }
      const identities = JSON.parse(env.ACCESS_IDENTITIES) as AccessIdentity[];
      if (!Array.isArray(identities) || identities.length !== 1 || identities[0]?.principal?.role !== 'owner' ||
        identities[0].principal.active !== true || !env.DB || typeof env.CONFIRMATION_SECRET !== 'string' ||
        new TextEncoder().encode(env.CONFIRMATION_SECRET).length < 32 ||
        typeof env.REVISION !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(env.REVISION) ||
        env.APPS_CONFIG !== undefined) throw new Error('Invalid personal deployment');
      // The same key snapshot serves the boundary and delegated API check.
      const load = dependencies.loadKeys ? () => dependencies.loadKeys!(issuer) : accessKeyLoader(issuer);
      let keys: ReturnType<typeof load> | undefined;
      const loadKeys = () => keys ??= load();
      const authenticator = createAccessAuthenticator({ issuer, audience: env.ACCESS_AUD, identities, loadKeys,
        ...(dependencies.now ? { now: dependencies.now } : {}) });
      if (!await authenticator.authenticate(request)) return Response.json({ error: 'unauthorized' }, { status: 401, headers });
      if (url.pathname === '/healthz') {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          return Response.json({ error: 'method_not_allowed' }, { status: 405, headers: { ...headers, allow: 'GET, HEAD' } });
        }
        return new Response(request.method === 'HEAD' ? null : JSON.stringify({ revision: env.REVISION }),
          { headers: { ...headers, 'content-type': 'application/json; charset=utf-8' } });
      }
      return await createWorker({ ...dependencies, loadKeys }).fetch(request, env);
    } catch {
      return Response.json({ error: 'worker_unavailable' }, { status: 503, headers });
    }
  } };
}
export default createPersonalWorker();
