// Personal deployment only. The company service and its SQLite ledger are separate.
const noStore = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" };
let cachedKeys = null;
let keysExpireAt = 0;

function json(value, status = 200) {
  return Response.json(value, { status, headers: noStore });
}
function problem(error, status) { return json({ error }, status); }
function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid_token");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}
function tokenPart(value) {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
}
function settings(env) {
  const origin = new URL(env.PUBLIC_ORIGIN);
  const team = new URL(env.ACCESS_TEAM_DOMAIN);
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash ||
      team.protocol !== "https:" || !/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(team.hostname) ||
      team.pathname !== "/" || !env.ACCESS_AUD || !env.OWNER_EMAIL || !env.DB || !env.ASSETS) {
    throw new Error("invalid_configuration");
  }
  return { origin: origin.origin, team: team.origin };
}
async function jwks(team, refresh = false) {
  if (!refresh && cachedKeys && Date.now() < keysExpireAt) return cachedKeys;
  const response = await fetch(`${team}/cdn-cgi/access/certs`, { cf: { cacheTtl: 60 } });
  if (!response.ok) throw new Error("access_certs_unavailable");
  const body = await response.json();
  if (!Array.isArray(body.keys)) throw new Error("invalid_access_certs");
  cachedKeys = body.keys;
  keysExpireAt = Date.now() + 60_000;
  return cachedKeys;
}
async function verifyToken(raw, env, team) {
  if (!raw || raw.length > 8192) throw new Error("unauthorized");
  const parts = raw.split(".");
  if (parts.length !== 3) throw new Error("unauthorized");
  const header = tokenPart(parts[0]);
  const payload = tokenPart(parts[1]);
  if (header.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length > 128 ||
      header.typ && header.typ !== "JWT") throw new Error("unauthorized");
  let key = (await jwks(team)).find((item) => item.kid === header.kid && item.kty === "RSA");
  if (!key) key = (await jwks(team, true)).find((item) => item.kid === header.kid && item.kty === "RSA");
  if (!key) throw new Error("unauthorized");
  const cryptoKey = await crypto.subtle.importKey("jwk", key,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey,
    decodeBase64Url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  const now = Math.floor(Date.now() / 1000);
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!valid || payload.iss !== team || !audience.includes(env.ACCESS_AUD) ||
      typeof payload.exp !== "number" || payload.exp <= now ||
      typeof payload.iat !== "number" || payload.iat > now + 60 ||
      payload.nbf !== undefined && (typeof payload.nbf !== "number" || payload.nbf > now) ||
      typeof payload.sub !== "string" || !payload.sub ||
      typeof payload.email !== "string" || payload.email.toLowerCase() !== env.OWNER_EMAIL.toLowerCase()) {
    throw new Error("unauthorized");
  }
  return { subject: payload.sub, email: payload.email };
}
function text(value, max, required = false) {
  if (typeof value !== "string") throw new Error("invalid_fields");
  const cleaned = value.trim();
  if (cleaned.length > max || required && !cleaned) throw new Error("invalid_fields");
  return cleaned;
}
function fields(body, names) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).sort().join() !== [...names].sort().join()) throw new Error("invalid_fields");
}
function repositoryUrl(value) {
  const cleaned = text(value, 512);
  if (!cleaned) return "";
  let url;
  try { url = new URL(cleaned); } catch { throw new Error("invalid_repository_url"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("invalid_repository_url");
  return url.href;
}
function checkDate(value) {
  const date = text(value, 10);
  const parsed = date ? new Date(`${date}T00:00:00Z`) : null;
  if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !parsed ||
      Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date)) {
    throw new Error("invalid_date");
  }
  return date;
}
function version(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("invalid_version");
  return value;
}
const states = ["未確認", "進行中", "待ち", "完了", "保留"];
async function milestoneId(db, value, projectId) {
  if (value === "") return null;
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value)) throw new Error("invalid_milestone");
  const row = await db.prepare("SELECT id FROM milestones WHERE id=? AND project_id=?")
    .bind(value, projectId).first();
  if (!row) throw new Error("invalid_milestone");
  return value;
}
async function bodyJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "") ||
      Number(request.headers.get("content-length") || 0) > 16_384) throw new Error("invalid_body");
  const raw = await request.text();
  if (raw.length > 16_384) throw new Error("invalid_body");
  try { return JSON.parse(raw); } catch { throw new Error("invalid_body"); }
}
async function api(request, env, actor, path) {
  if (request.method === "GET" && path === "/api/me") return json({ email: actor.email });
  if (request.method === "GET" && path === "/api/projects") {
    const rows = await env.DB.prepare(`SELECT p.id,p.name,p.purpose,p.repository_url,p.scope,p.version,
      p.created_at,p.updated_at,COUNT(w.id) AS item_count,
      SUM(CASE WHEN w.state <> '完了' THEN 1 ELSE 0 END) AS open_count
      FROM projects p LEFT JOIN work_items w ON w.project_id=p.id
      GROUP BY p.id ORDER BY p.updated_at DESC,p.id`).all();
    return json({ projects: rows.results });
  }
  if (request.method === "POST" && path === "/api/projects") {
    const body = await bodyJson(request);
    fields(body, ["name", "purpose", "repository_url", "scope"]);
    const name = text(body.name, 160, true);
    const purpose = text(body.purpose, 2000);
    const repository = repositoryUrl(body.repository_url);
    if (!["personal", "hybrid"].includes(body.scope)) throw new Error("invalid_scope");
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO projects(id,name,purpose,repository_url,scope,created_at,updated_at,updated_by)
      VALUES(?,?,?,?,?,?,?,?)`).bind(id, name, purpose, repository, body.scope, now, now, actor.subject).run();
    return json({ id, version: 1 }, 201);
  }
  const project = path.match(/^\/api\/projects\/([0-9a-f-]{36})$/i);
  if (request.method === "PATCH" && project) {
    const body = await bodyJson(request);
    fields(body, ["name", "purpose", "repository_url", "scope", "expected_version"]);
    const name = text(body.name, 160, true);
    const purpose = text(body.purpose, 2000);
    const repository = repositoryUrl(body.repository_url);
    if (!["personal", "hybrid"].includes(body.scope)) throw new Error("invalid_scope");
    const expected = version(body.expected_version);
    const result = await env.DB.prepare(`UPDATE projects SET name=?,purpose=?,repository_url=?,scope=?,
      version=version+1,updated_at=?,updated_by=? WHERE id=? AND version=?`)
      .bind(name, purpose, repository, body.scope, new Date().toISOString(), actor.subject, project[1], expected).run();
    return result.meta.changes === 1 ? json({ id: project[1], version: expected + 1 }) : problem("version_conflict", 409);
  }
  const milestones = path.match(/^\/api\/projects\/([0-9a-f-]{36})\/milestones$/i);
  if (request.method === "GET" && milestones) {
    const parent = await env.DB.prepare("SELECT id FROM projects WHERE id=?").bind(milestones[1]).first();
    if (!parent) return problem("not_found", 404);
    const rows = await env.DB.prepare(`SELECT id,project_id,goal,acceptance,check_date,state,version,created_at,updated_at
      FROM milestones WHERE project_id=? ORDER BY CASE WHEN state='完了' THEN 1 ELSE 0 END,check_date,id`)
      .bind(milestones[1]).all();
    return json({ milestones: rows.results });
  }
  if (request.method === "POST" && milestones) {
    const body = await bodyJson(request);
    fields(body, ["goal", "acceptance", "check_date", "state"]);
    const goal = text(body.goal, 240, true);
    const acceptance = text(body.acceptance, 2000);
    const date = checkDate(body.check_date);
    if (!states.includes(body.state)) throw new Error("invalid_state");
    const parent = await env.DB.prepare("SELECT id FROM projects WHERE id=?").bind(milestones[1]).first();
    if (!parent) return problem("not_found", 404);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO milestones(id,project_id,goal,acceptance,check_date,state,created_at,updated_at,updated_by)
      VALUES(?,?,?,?,?,?,?,?,?)`).bind(id, milestones[1], goal, acceptance, date, body.state, now, now, actor.subject).run();
    return json({ id, version: 1 }, 201);
  }
  const milestone = path.match(/^\/api\/milestones\/([0-9a-f-]{36})$/i);
  if (request.method === "PATCH" && milestone) {
    const body = await bodyJson(request);
    fields(body, ["goal", "acceptance", "check_date", "state", "expected_version"]);
    const goal = text(body.goal, 240, true);
    const acceptance = text(body.acceptance, 2000);
    const date = checkDate(body.check_date);
    if (!states.includes(body.state)) throw new Error("invalid_state");
    const expected = version(body.expected_version);
    const result = await env.DB.prepare(`UPDATE milestones SET goal=?,acceptance=?,check_date=?,state=?,
      version=version+1,updated_at=?,updated_by=? WHERE id=? AND version=?`)
      .bind(goal, acceptance, date, body.state, new Date().toISOString(), actor.subject, milestone[1], expected).run();
    return result.meta.changes === 1 ? json({ id: milestone[1], version: expected + 1 }) : problem("version_conflict", 409);
  }
  const items = path.match(/^\/api\/projects\/([0-9a-f-]{36})\/items$/i);
  if (request.method === "GET" && items) {
    const parent = await env.DB.prepare("SELECT id FROM projects WHERE id=?").bind(items[1]).first();
    if (!parent) return problem("not_found", 404);
    const rows = await env.DB.prepare(`SELECT id,project_id,milestone_id,title,next_action,check_date,state,version,created_at,updated_at
      FROM work_items WHERE project_id=? ORDER BY CASE WHEN state='完了' THEN 1 ELSE 0 END,check_date,id`)
      .bind(items[1]).all();
    return json({ items: rows.results });
  }
  if (request.method === "POST" && items) {
    const body = await bodyJson(request);
    fields(body, ["title", "next_action", "check_date", "state", "milestone_id"]);
    const title = text(body.title, 240, true);
    const next = text(body.next_action, 2000);
    const date = checkDate(body.check_date);
    if (!states.includes(body.state)) throw new Error("invalid_state");
    const parent = await env.DB.prepare("SELECT id FROM projects WHERE id=?").bind(items[1]).first();
    if (!parent) return problem("not_found", 404);
    const linkedMilestone = await milestoneId(env.DB, body.milestone_id, items[1]);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO work_items(id,project_id,milestone_id,title,next_action,check_date,state,created_at,updated_at,updated_by)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(id, items[1], linkedMilestone, title, next, date, body.state, now, now, actor.subject).run();
    return json({ id, version: 1 }, 201);
  }
  const item = path.match(/^\/api\/items\/([0-9a-f-]{36})$/i);
  if (request.method === "PATCH" && item) {
    const body = await bodyJson(request);
    fields(body, ["title", "next_action", "check_date", "state", "milestone_id", "expected_version"]);
    const title = text(body.title, 240, true);
    const next = text(body.next_action, 2000);
    const date = checkDate(body.check_date);
    if (!states.includes(body.state)) throw new Error("invalid_state");
    const expected = version(body.expected_version);
    const before = await env.DB.prepare("SELECT project_id FROM work_items WHERE id=?").bind(item[1]).first();
    if (!before) return problem("not_found", 404);
    const linkedMilestone = await milestoneId(env.DB, body.milestone_id, before.project_id);
    const result = await env.DB.prepare(`UPDATE work_items SET milestone_id=?,title=?,next_action=?,check_date=?,state=?,
      version=version+1,updated_at=?,updated_by=? WHERE id=? AND version=?`)
      .bind(linkedMilestone, title, next, date, body.state, new Date().toISOString(), actor.subject, item[1], expected).run();
    return result.meta.changes === 1 ? json({ id: item[1], version: expected + 1 }) : problem("version_conflict", 409);
  }
  if (request.method === "GET" && path === "/api/events") {
    const rows = await env.DB.prepare(`SELECT id,entity_type,entity_id,operation,actor,at_utc,before_json,after_json
      FROM events ORDER BY id DESC LIMIT 100`).all();
    return json({ events: rows.results });
  }
  if (request.method === "GET" && path === "/api/export") {
    const [projects, milestones, items, events] = await env.DB.batch([
      env.DB.prepare("SELECT * FROM projects ORDER BY id"),
      env.DB.prepare("SELECT * FROM milestones ORDER BY id"),
      env.DB.prepare("SELECT * FROM work_items ORDER BY id"),
      env.DB.prepare("SELECT * FROM events ORDER BY id")]);
    return json({ format: "deskly-personal-d1-v2", exported_at: new Date().toISOString(),
      projects: projects.results, milestones: milestones.results,
      work_items: items.results, events: events.results });
  }
  return problem("not_found", 404);
}

export default {
  async fetch(request, env) {
    let config;
    try { config = settings(env); } catch { return problem("server_not_configured", 503); }
    const url = new URL(request.url);
    if (url.origin !== config.origin) return problem("wrong_origin", 403);
    if (!["GET", "HEAD", "POST", "PATCH"].includes(request.method)) return problem("method_not_allowed", 405);
    if (["POST", "PATCH"].includes(request.method) && request.headers.get("origin") !== config.origin) {
      return problem("invalid_origin", 403);
    }
    let actor;
    try { actor = await verifyToken(request.headers.get("Cf-Access-Jwt-Assertion"), env, config.team); }
    catch { return problem("unauthorized", 401); }
    if (url.pathname.startsWith("/api/")) {
      try { return await api(request, env, actor, url.pathname); }
      catch (error) {
        const code = error instanceof Error ? error.message : "internal_error";
        if (["invalid_body", "invalid_fields", "invalid_repository_url", "invalid_date",
          "invalid_version", "invalid_scope", "invalid_state", "invalid_milestone"].includes(code)) return problem(code, 400);
        return problem("internal_error", 500);
      }
    }
    if (request.method !== "GET" && request.method !== "HEAD") return problem("method_not_allowed", 405);
    const assetPath = url.pathname === "/" ? "/index.html" : url.pathname;
    if (!["/index.html", "/app.js", "/app.css"].includes(assetPath)) return problem("not_found", 404);
    const assetUrl = new URL(assetPath, config.origin);
    const response = await env.ASSETS.fetch(new Request(assetUrl, request));
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(noStore)) headers.set(key, value);
    headers.set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    return new Response(response.body, { status: response.status, headers });
  },
};
