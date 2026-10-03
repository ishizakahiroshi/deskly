/** One Web-standard handler for every frozen OpenAPI path; no host-specific APIs. */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppAuthenticator, AppPrincipal, Authenticator, CasePrincipal, Principal } from './ports.js';
import { ServiceError } from './ports.js';
import type { WorkspaceService } from './service.js';

export interface HttpDependencies {
  service: WorkspaceService;
  authenticator: Authenticator;
  /**
   * Sending-app authentication (createAppAuthenticator), consulted only on case
   * routes and only when no member was authenticated.
   */
  appAuthenticator?: AppAuthenticator;
  /** Canonical public origin from trusted deployment configuration, never a header. */
  origin: string;
}
type Environment = { Variables: { principal: Principal | undefined; app: AppPrincipal | undefined } };
const CASE_ROUTE = /^\/api\/v1\/workspaces\/[^/]+\/cases(?:\/|$)/;
const MAX_BODY_BYTES = 1_048_576;
/** JSON.parse plus duplicate-key/depth rejection, matching Python's strict loader. */
function strictJson(source: string): unknown {
  const parsed: unknown = JSON.parse(source);
  const stack: { object: boolean; key: boolean; keys: Set<string> }[] = [];
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === '"') {
      const start = index++;
      while (index < source.length && source[index] !== '"') {
        if (source[index] === '\\') index++;
        index++;
      }
      const context = stack.at(-1);
      if (context?.object && context.key) {
        const key: string = JSON.parse(source.slice(start, index + 1));
        if (context.keys.has(key)) throw new ServiceError('invalid_json');
        context.keys.add(key);
        context.key = false;
      }
    } else if (character === '{' || character === '[') {
      if (stack.length >= 128) throw new ServiceError('invalid_json');
      stack.push({ object: character === '{', key: character === '{', keys: new Set() });
    } else if (character === '}' || character === ']') stack.pop();
    else if (character === ',') {
      const context = stack.at(-1);
      if (context?.object) context.key = true;
    }
  }
  return parsed;
}
async function input(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new ServiceError('invalid_content_type');
  }
  // Bound chunked bodies too; Content-Length is an untrusted hint.
  if (!request.body) throw new ServiceError('invalid_json');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new ServiceError('request_too_large');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return strictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ServiceError('invalid_json'); }
}
export function createHttpHandler({ service, authenticator, appAuthenticator, origin }: HttpDependencies): (request: Request) => Promise<Response> {
  const publicUrl = new URL(origin);
  if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.origin !== origin) throw new Error('Invalid public origin');
  const app = new Hono<Environment>();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    const url = new URL(c.req.url);
    const host = c.req.header('Host');
    const requestOrigin = c.req.header('Origin');
    const fetchSite = c.req.header('Sec-Fetch-Site');
    const mutation = c.req.method !== 'GET' && c.req.method !== 'HEAD';
    if (url.origin !== origin || (host !== undefined && host.toLowerCase() !== publicUrl.host.toLowerCase())) {
      throw new ServiceError('forbidden', 403);
    }
    const browser = !((mutation || requestOrigin !== undefined) && requestOrigin !== origin)
      && !(fetchSite !== undefined && fetchSite.toLowerCase() !== 'same-origin');
    const caseRoute = CASE_ROUTE.test(url.pathname);
    // A failed browser check never reaches member authentication (cookies are ambient).
    const principal = browser ? await authenticator.authenticate(c.req.raw) : null;
    // An app is never a member: it is tried only on case routes, after members.
    // A server-to-server Bearer call carries no browser Origin / Sec-Fetch-Site, so
    // those checks are waived only for a Bearer request that authenticates as an app;
    // any other request failing them is still 403.
    const bearer = /^Bearer /.test(c.req.header('Authorization') ?? '');
    const sender = !principal && appAuthenticator && caseRoute && (browser || bearer)
      ? await appAuthenticator.authenticate(c.req.raw) : null;
    if (!browser && !sender) throw new ServiceError('forbidden', 403);
    if (!principal && !sender) throw new ServiceError('unauthorized', 401);
    c.set('principal', principal ?? undefined);
    c.set('app', sender ?? undefined);
    await next();
  });
  const p = (c: Context<Environment>): Principal => {
    const principal = c.get('principal');
    if (!principal) throw new ServiceError('unauthorized', 401);
    return principal;
  };
  const caller = (c: Context<Environment>): CasePrincipal => {
    const principal = c.get('principal') ?? c.get('app');
    if (!principal) throw new ServiceError('unauthorized', 401);
    return principal;
  };
  const w = (c: Context<Environment>): string => c.req.param('workspace_id') ?? '';
  const project = (c: Context<Environment>): string => c.req.param('project_id') ?? '';
  const base = '/api/v1/workspaces/:workspace_id';
  const query = (c: Context<Environment>, allowed: readonly string[], repeated: readonly string[] = []): URLSearchParams => {
    const params = new URL(c.req.url).searchParams;
    for (const key of params.keys()) {
      if (!allowed.includes(key) || (!repeated.includes(key) && params.getAll(key).length !== 1)) throw new ServiceError('invalid_query');
    }
    return params;
  };
  const flag = (params: URLSearchParams, name: string): boolean | undefined => {
    const value = params.get(name);
    if (value === null) return undefined;
    if (value !== 'true' && value !== 'false') throw new ServiceError('invalid_query');
    return value === 'true';
  };

  app.get('/api/v1/accounts/me', async c => c.json(await service.account(p(c))));
  app.get(base, async c => c.json(await service.workspace(p(c), w(c))));
  app.get(`${base}/projects`, async c => c.json(await service.projects(p(c), w(c))));
  app.get(`${base}/projects/:project_id`, async c => c.json(await service.project(p(c), w(c), project(c))));
  app.get(`${base}/projects/:project_id/milestones`, async c => c.json(await service.milestones(p(c), w(c), project(c))));
  app.get(`${base}/projects/:project_id/milestones/:milestone_id`, async c => c.json(await service.milestone(p(c), w(c), project(c), c.req.param('milestone_id'))));
  app.get(`${base}/projects/:project_id/work-items`, async c => c.json(await service.workItems(p(c), w(c), project(c))));
  app.get(`${base}/projects/:project_id/work-items/:work_item_id`, async c => c.json(await service.workItem(p(c), w(c), project(c), c.req.param('work_item_id'))));
  app.get(`${base}/projects/:project_id/events`, async c => c.json(await service.events(p(c), w(c), project(c))));
  app.get(`${base}/projects/:project_id/sources/:source_id/contacts/:contact_id`, async c => c.json(await service.linkedContact(p(c), w(c), project(c), c.req.param('source_id'), c.req.param('contact_id'))));
  app.get(`${base}/project-roles/me`, async c => {
    query(c, []);
    return c.json(await service.projectRoles(p(c), w(c)));
  });
  const ledger = `${base}/sources/:source_id`;
  const source = (c: Context<Environment>): string => c.req.param('source_id') ?? '';
  app.get(`${ledger}/contacts`, async c => {
    const params = query(c, ['state', 'project', 'q'], ['state']);
    const options = { ...(params.has('state') ? { state: params.getAll('state') } : {}),
      ...(params.has('project') ? { project: params.get('project')! } : {}),
      ...(params.has('q') ? { q: params.get('q')! } : {}) };
    return c.json({ items: await service.contactLedger.list(p(c), w(c), source(c), options) });
  });
  app.get(`${ledger}/waiting`, async c => {
    const params = query(c, ['include_all', 'include_summaries', 'today']);
    const all = flag(params, 'include_all');
    const summaries = flag(params, 'include_summaries');
    return c.json({ items: await service.contactLedger.waiting(p(c), w(c), source(c), {
      ...(all === undefined ? {} : { include_all: all }),
      ...(summaries === undefined ? {} : { include_summaries: summaries }),
      ...(params.has('today') ? { today: params.get('today')! } : {}),
    }) });
  });
  app.get(`${ledger}/contacts/:contact_id`, async c => {
    query(c, []);
    return c.json(await service.contactLedger.read(p(c), w(c), source(c), c.req.param('contact_id')));
  });
  app.get(`${ledger}/contacts/:contact_id/history`, async c => {
    query(c, []);
    return c.json({ events: await service.contactLedger.history(p(c), w(c), source(c), c.req.param('contact_id')) });
  });
  app.get(`${ledger}/contacts/:contact_id/body`, async c => {
    query(c, []);
    return c.json(await service.contactLedger.exportBody(p(c), w(c), source(c), c.req.param('contact_id')));
  });
  app.post(`${ledger}/contacts/commands/preview`, async c => {
    query(c, []);
    return c.json(await service.contactLedger.previewCommand(p(c), w(c), source(c), await input(c.req.raw)));
  });
  app.post(`${ledger}/contacts/commands/apply`, async c => {
    query(c, []);
    return c.json(await service.contactLedger.applyCommand(p(c), w(c), source(c), await input(c.req.raw)));
  });
  const cases = `${base}/cases`;
  const number = (c: Context<Environment>): string => c.req.param('number') ?? '';
  app.get(cases, async c => {
    query(c, []);
    return c.json({ items: await service.cases.list(caller(c), w(c)) });
  });
  app.post(cases, async c => {
    query(c, []);
    return c.json(await service.cases.create(caller(c), w(c), await input(c.req.raw)));
  });
  // Registered before /:number; "panels" is never a valid case number.
  app.get(`${cases}/panels`, async c => {
    query(c, []);
    return c.json(await service.cases.panels(caller(c), w(c)));
  });
  // Also before /:number; "settings" is never a valid case number. Owner only.
  app.get(`${cases}/settings`, async c => {
    query(c, []);
    return c.json(await service.cases.settingsView(caller(c), w(c)));
  });
  // Member scopes (C8-5), also before /:number; "member-scopes" is never a valid case number.
  // Only while [member_access] is enabled; otherwise 404 member_access_not_enabled.
  const scopes = `${cases}/member-scopes`;
  app.get(scopes, async c => {
    query(c, []);
    return c.json(await service.cases.memberScopes(caller(c), w(c)));
  });
  app.get(`${scopes}/me`, async c => {
    query(c, []);
    return c.json(await service.cases.myMemberScope(caller(c), w(c)));
  });
  app.put(`${scopes}/:member_id`, async c => {
    query(c, []);
    return c.json(await service.cases.setMemberScope(caller(c), w(c), c.req.param('member_id') ?? '', await input(c.req.raw)));
  });
  app.get(`${cases}/:number`, async c => {
    query(c, []);
    return c.json(await service.cases.read(caller(c), w(c), number(c)));
  });
  app.patch(`${cases}/:number`, async c => {
    query(c, []);
    return c.json(await service.cases.update(caller(c), w(c), number(c), await input(c.req.raw)));
  });
  app.post(`${cases}/:number/people`, async c => {
    query(c, []);
    return c.json(await service.cases.addPerson(caller(c), w(c), number(c), await input(c.req.raw)));
  });
  app.post(`${cases}/:number/replies`, async c => {
    query(c, []);
    return c.json(await service.cases.addReply(caller(c), w(c), number(c), await input(c.req.raw)));
  });
  app.post(`${cases}/:number/links`, async c => {
    query(c, []);
    return c.json(await service.cases.addLink(caller(c), w(c), number(c), await input(c.req.raw)));
  });
  app.get(`${base}/memberships`, async c => c.json(await service.memberships(p(c), w(c))));
  app.put(`${base}/projects/:project_id/memberships/:member_id`, async c => c.json(await service.setProjectMembership(p(c), w(c), project(c), c.req.param('member_id'), await input(c.req.raw))));
  app.put(`${base}/sources/:source_id/memberships/:member_id`, async c => c.json(await service.setSourceMembership(p(c), w(c), c.req.param('source_id'), c.req.param('member_id'), await input(c.req.raw))));
  app.post(`${base}/commands/preview`, async c => c.json(await service.preview(p(c), w(c), await input(c.req.raw))));
  app.post(`${base}/commands/apply`, async c => c.json(await service.apply(p(c), w(c), await input(c.req.raw))));
  app.notFound(c => c.json({ error: 'not_found' }, 404));
  app.onError((error, c) => error instanceof ServiceError
    ? c.json({ error: error.code }, error.status)
    : c.json({ error: 'internal_error' }, 500));
  return async request => app.fetch(request);
}
