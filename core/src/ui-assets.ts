/** Shared, importable static assets: Node and Workers use this exact registry. */
import { files } from '../.build/ui-content.js';
import type { Authenticator } from './ports.js';
export interface UiAsset { readonly content: string; readonly contentType: string; readonly cacheControl: string }
export const uiAssets: Readonly<Record<string, UiAsset>> = Object.freeze(Object.fromEntries([
  ['/', 'index.html', 'text/html; charset=utf-8'],
  ['/assets/main.js', 'assets/main.js', 'text/javascript; charset=utf-8'],
  ['/assets/workspace.js', 'assets/workspace.js', 'text/javascript; charset=utf-8'],
  ['/assets/cases.js', 'assets/cases.js', 'text/javascript; charset=utf-8'],
  ['/assets/workspace.css', 'assets/workspace.css', 'text/css; charset=utf-8'],
].map(([path, name, contentType]) => {
  const content = files[name!];
  if (content === undefined) throw new Error('Build workspace assets before starting');
  return [path!, Object.freeze({ content, contentType: contentType!, cacheControl: 'no-store' })];
})));
export const uiSecurityHeaders = Object.freeze({
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
});
const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** null delegates every API route unchanged. No filesystem or Workers asset binding. */
export async function serveUi(request: Request, options: { origin: string; authenticator: Authenticator }): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return null;
  const headers = { ...uiSecurityHeaders, 'cache-control': 'no-store' };
  const host = request.headers.get('host');
  if (url.origin !== options.origin || (host !== null && host.toLowerCase() !== new URL(options.origin).host.toLowerCase())
    || (request.headers.has('origin') && request.headers.get('origin') !== options.origin)) {
    return new Response('表示できません', { status: 403, headers });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('この操作は利用できません', { status: 405, headers: { ...headers, allow: 'GET, HEAD' } });
  }
  const asset = uiAssets[url.pathname] ?? (!url.pathname.startsWith('/assets/') && !url.pathname.split('/').at(-1)?.includes('.') ? uiAssets['/'] : undefined);
  if (!asset) return new Response(request.method === 'HEAD' ? null : '見つかりません', { status: 404, headers });
  let content = asset.content;
  if (asset.contentType.startsWith('text/html')) {
    const principal = await options.authenticator.authenticate(request);
    // Only two validated, non-secret IDs; never role, account login, email, credential or token.
    // They select what to display, while the existing API rechecks all authorization.
    const context = principal?.active === true && id.test(principal.workspace_id) && id.test(principal.member_id)
      ? `<meta name="deskly-workspace" content="${principal.workspace_id}"><meta name="deskly-member" content="${principal.member_id}">` : '';
    content = content.replace('<!-- deskly:context -->', context);
  }
  return new Response(request.method === 'HEAD' ? null : content, { headers: {
    ...headers, 'content-type': asset.contentType, 'cache-control': asset.cacheControl,
    ...(asset.contentType.startsWith('text/html') ? { vary: 'Cookie, Authorization, Cf-Access-Jwt-Assertion' } : {}),
  } });
}
