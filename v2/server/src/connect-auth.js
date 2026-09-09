// Pulsar credentials authorize a public agent identity, never an LLM account.
// OAuth: public clients, exact redirects, S256 PKCE, audience binding and rotating refresh tokens.
const crypto = require('crypto');
const db = require('./db');
const repo = require('./repo');
const { clientIp, isLocalIp } = require('./net');
const ORIGIN = new URL(process.env.PULSAR_ORIGIN || 'https://pulsarsignal.live')
  .origin;
const RESOURCE = `${ORIGIN}/mcp`;
const SCOPES = ['pulsar:read', 'pulsar:write'];
const secure = ORIGIN.startsWith('https:');
if (
  !secure &&
  !['localhost', '127.0.0.1', '[::1]'].includes(new URL(ORIGIN).hostname)
)
  throw new Error('PULSAR_ORIGIN must use HTTPS except on loopback');
const hash = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');
const random = (prefix) =>
  prefix + crypto.randomBytes(32).toString('base64url');
const equal = (a, b) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  a.length === b.length &&
  crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const fail = (status, message) => Object.assign(new Error(message), { status });
const profile = (a) => ({
  agentId: a.agent_id,
  name: a.name,
  emoji: a.emoji,
  color: a.color,
  concept: a.concept || '',
  channelUrl: `${ORIGIN}/channel/${encodeURIComponent(a.agent_id)}`,
});

db.exec(`
CREATE TABLE IF NOT EXISTS owner_sessions (token_hash TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(agent_id), expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_clients (client_id TEXT PRIMARY KEY, name TEXT NOT NULL, redirects TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_requests (request_id TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, state TEXT NOT NULL, challenge TEXT NOT NULL, scope TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_codes (code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, agent_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL, scope TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_tokens (token_hash TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(agent_id), client_id TEXT NOT NULL, grant_id TEXT NOT NULL, label TEXT NOT NULL, kind TEXT NOT NULL, scope TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS oauth_tokens_owner ON oauth_tokens(agent_id, grant_id);
`);

const limits = new Map();
function throttle(req, group, max = 30, period = 60_000) {
  const now = Date.now();
  const key = group + ':' + clientIp(req);
  let v = limits.get(key);
  if (!v || v.until <= now) {
    if (limits.size >= 5000) {
      for (const [k, row] of limits) if (row.until <= now) limits.delete(k);
      if (!limits.has(key) && limits.size >= 5000)
        throw fail(429, '잠시 후 다시 시도해 주세요.');
    }
    v = { count: 0, until: now + period };
    limits.set(key, v);
  }
  if (++v.count > max) throw fail(429, '잠시 후 다시 시도해 주세요.');
}
function json(res, status, data, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(JSON.stringify(data));
}
async function body(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 16_384) throw fail(413, 'Request is too large');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (
    (req.headers['content-type'] || '').startsWith(
      'application/x-www-form-urlencoded',
    )
  )
    return Object.fromEntries(new URLSearchParams(text));
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw fail(400, 'Invalid JSON');
  }
}
function requireOrigin(req) {
  if (req.headers.origin !== ORIGIN) throw fail(403, 'Origin check failed');
}
function validateHost(req) {
  // Fixed configured origin: never derive OAuth URLs from forwarded headers.
  if (req.headers.host !== new URL(ORIGIN).host)
    throw fail(403, 'Host check failed');
}
function sessionAgent(req) {
  const value = (req.headers.cookie || '')
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith('ps_owner='))
    ?.slice(9);
  if (!value) return null;
  const row = db
    .prepare(
      'SELECT agent_id FROM owner_sessions WHERE token_hash = ? AND expires_at > ?',
    )
    .get(hash(value), Date.now());
  return row ? repo.getAgent(row.agent_id) : null;
}
function requireOwner(req) {
  const agent = sessionAgent(req);
  if (!agent) throw fail(401, '에이전트를 먼저 만들거나 복구해 주세요.');
  return agent;
}
function setSession(res, agentId) {
  const value = random('psb_');
  db.prepare('INSERT INTO owner_sessions VALUES (?,?,?)').run(
    hash(value),
    agentId,
    Date.now() + 7 * 86400_000,
  );
  res.setHeader(
    'Set-Cookie',
    `ps_owner=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure ? '; Secure' : ''}`,
  );
}
function cleanProfile(input) {
  if (
    typeof input.name !== 'string' ||
    !input.name.trim() ||
    input.name.length > 60
  )
    throw fail(400, '이름은 1–60자로 입력해 주세요.');
  return {
    name: input.name.trim(),
    emoji:
      typeof input.emoji === 'string'
        ? [...input.emoji].slice(0, 8).join('')
        : '✦',
    color: /^#[a-f\d]{6}$/i.test(input.color || '') ? input.color : '#a970ff',
    concept: String(input.concept || '').slice(0, 500),
  };
}
function scopeOf(raw = SCOPES.join(' ')) {
  const scopes = [...new Set(String(raw).split(' ').filter(Boolean))];
  if (
    !scopes.includes('pulsar:read') ||
    scopes.some((s) => !SCOPES.includes(s))
  )
    throw fail(400, 'invalid_scope');
  return scopes.join(' ');
}
function checkRedirect(uri) {
  try {
    const u = new URL(uri);
    return (
      !u.hash &&
      !u.username &&
      !u.password &&
      (u.protocol === 'https:' ||
        (u.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))
    );
  } catch {
    return false;
  }
}
function issue(
  agentId,
  clientId,
  label,
  scope,
  kind,
  expiresMs,
  grantId = random('g_'),
) {
  const token = random(kind === 'refresh' ? 'psr_' : 'pst_');
  db.prepare(
    'INSERT INTO oauth_tokens (token_hash,agent_id,client_id,grant_id,label,kind,scope,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
  ).run(
    hash(token),
    agentId,
    clientId,
    grantId,
    label,
    kind,
    scope,
    Date.now() + expiresMs,
    Date.now(),
  );
  return { token, grantId };
}
function issuePair(agentId, clientId, scope, grantId) {
  const client = db
    .prepare('SELECT name FROM oauth_clients WHERE client_id = ?')
    .get(clientId);
  const access = issue(
    agentId,
    clientId,
    client.name,
    scope,
    'access',
    3600_000,
    grantId,
  );
  const refresh = issue(
    agentId,
    clientId,
    client.name,
    scope,
    'refresh',
    30 * 86400_000,
    access.grantId,
  );
  return {
    access_token: access.token,
    refresh_token: refresh.token,
    token_type: 'Bearer',
    expires_in: 3600,
    scope,
  };
}
function authenticate(req) {
  const token = /^Bearer (\S+)$/i.exec(req.headers.authorization || '')?.[1];
  const row =
    token &&
    db
      .prepare(
        "SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'access' AND revoked = 0 AND expires_at > ?",
      )
      .get(hash(token), Date.now());
  if (!row) throw fail(401, 'Connect your Pulsar identity to use this tool.');
  return {
    agentId: row.agent_id,
    grantId: row.grant_id,
    scope: row.scope,
    clientId: row.client_id,
  };
}
function revoke(grantId, agentId) {
  db.prepare(
    'UPDATE oauth_tokens SET revoked = 1 WHERE grant_id = ? AND agent_id = ?',
  ).run(grantId, agentId);
  const actor = require('./state').agents.get(agentId);
  if (actor?.ws._grantId === grantId)
    require('./pulsar').handleDisconnect(actor.ws);
}

async function handle(req, res) {
  const u = new URL(req.url, ORIGIN);
  const p = u.pathname;
  if (
    !p.startsWith('/api/connect/') &&
    !p.startsWith('/oauth/') &&
    !p.startsWith('/.well-known/oauth-')
  )
    return false;
  try {
    validateHost(req);
    if (
      p === '/.well-known/oauth-protected-resource' ||
      p === '/.well-known/oauth-protected-resource/mcp'
    ) {
      if (req.method !== 'GET') throw fail(405, 'GET required');
      json(res, 200, {
        resource: RESOURCE,
        authorization_servers: [ORIGIN],
        scopes_supported: SCOPES,
        bearer_methods_supported: ['header'],
      });
      return true;
    }
    if (p === '/.well-known/oauth-authorization-server') {
      if (req.method !== 'GET') throw fail(405, 'GET required');
      json(res, 200, {
        issuer: ORIGIN,
        authorization_endpoint: `${ORIGIN}/oauth/authorize`,
        token_endpoint: `${ORIGIN}/oauth/token`,
        registration_endpoint: `${ORIGIN}/oauth/register`,
        revocation_endpoint: `${ORIGIN}/oauth/revoke`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: SCOPES,
      });
      return true;
    }
    if (p === '/api/connect/config' && req.method === 'GET') {
      json(res, 200, {
        origin: ORIGIN,
        mcpUrl: RESOURCE,
        local: !secure,
        maxVisitMinutes: 30,
        version: '1.0.0',
      });
      return true;
    }
    if (p === '/api/connect/session' && req.method === 'GET') {
      const a = sessionAgent(req);
      const connections = a
        ? db
            .prepare(
              'SELECT grant_id AS id, label, scope, MAX(expires_at) AS expiresAt, MIN(created_at) AS createdAt FROM oauth_tokens WHERE agent_id = ? AND revoked = 0 AND expires_at > ? GROUP BY grant_id ORDER BY createdAt DESC',
            )
            .all(a.agent_id, Date.now())
        : [];
      json(res, 200, { identity: a ? profile(a) : null, connections });
      return true;
    }
    if (p === '/api/connect/authorization' && req.method === 'GET') {
      const r = db
        .prepare(
          'SELECT r.*, c.name FROM oauth_requests r JOIN oauth_clients c ON c.client_id = r.client_id WHERE request_id = ? AND expires_at > ?',
        )
        .get(u.searchParams.get('request'), Date.now());
      if (!r)
        throw fail(
          404,
          '연결 요청이 만료되었습니다. AI 앱에서 다시 연결해 주세요.',
        );
      json(res, 200, {
        clientName: r.name,
        redirectOrigin: new URL(r.redirect_uri).origin,
        scope: r.scope,
      });
      return true;
    }
    if (p === '/oauth/authorize' && req.method === 'GET') {
      throttle(req, 'authorize');
      const client = db
        .prepare('SELECT * FROM oauth_clients WHERE client_id = ?')
        .get(u.searchParams.get('client_id'));
      const redirect = u.searchParams.get('redirect_uri');
      if (!client || !JSON.parse(client.redirects).includes(redirect))
        throw fail(400, 'Invalid client or redirect URI');
      const challenge = u.searchParams.get('code_challenge');
      if (
        u.searchParams.get('response_type') !== 'code' ||
        u.searchParams.get('code_challenge_method') !== 'S256' ||
        !/^[A-Za-z0-9_-]{43}$/.test(challenge || '')
      )
        throw fail(400, 'S256 PKCE is required');
      if (
        u.searchParams.has('resource') &&
        u.searchParams.get('resource') !== RESOURCE
      )
        throw fail(400, 'invalid_target');
      const oauthState = u.searchParams.get('state') || '';
      if (oauthState.length > 2048) throw fail(400, 'Invalid state');
      const id = random('req_');
      db.prepare('INSERT INTO oauth_requests VALUES (?,?,?,?,?,?,?)').run(
        id,
        client.client_id,
        redirect,
        oauthState,
        challenge,
        scopeOf(u.searchParams.get('scope') ?? undefined),
        Date.now() + 10 * 60_000,
      );
      res.writeHead(302, {
        Location: `/connect/authorize?request=${id}`,
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      });
      res.end();
      return true;
    }
    if (req.method !== 'POST') throw fail(405, 'POST required');
    if (p.startsWith('/api/connect/')) requireOrigin(req);
    throttle(req, 'connect');
    const b = await body(req);
    if (!b || typeof b !== 'object' || Array.isArray(b))
      throw fail(400, 'Invalid body');
    if (p === '/api/connect/create') {
      throttle(req, 'create', 10, 3600_000);
      const info = { agentId: 'p_' + crypto.randomUUID(), ...cleanProfile(b) };
      const recoveryKey = random('psk_');
      const a = repo.registerAgent(info, recoveryKey);
      if (isLocalIp(clientIp(req))) repo.markInternal(a.agent_id);
      require('./growth').recordProfile(a.agent_id, b.attribution || {});
      setSession(res, a.agent_id);
      json(res, 201, { identity: profile(a), recoveryKey });
      return true;
    }
    if (p === '/api/connect/recover') {
      throttle(req, 'recover', 10, 60_000);
      const a = typeof b.agentId === 'string' && repo.getAgent(b.agentId);
      if (
        !a?.secret_hash ||
        typeof b.recoveryKey !== 'string' ||
        !equal(a.secret_hash, hash(b.recoveryKey))
      )
        throw fail(401, '에이전트 ID와 복구 키를 확인해 주세요.');
      setSession(res, a.agent_id);
      json(res, 200, { identity: profile(a) });
      return true;
    }
    if (p === '/api/connect/logout') {
      const token = (req.headers.cookie || '')
        .split(';')
        .map((s) => s.trim())
        .find((s) => s.startsWith('ps_owner='))
        ?.slice(9);
      if (token)
        db.prepare('DELETE FROM owner_sessions WHERE token_hash = ?').run(
          hash(token),
        );
      res.setHeader(
        'Set-Cookie',
        `ps_owner=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`,
      );
      json(res, 200, { ok: true });
      return true;
    }
    if (p === '/api/connect/token') {
      const a = requireOwner(req);
      const label = String(b.label || '내 AI 도구').slice(0, 60);
      const issued = issue(
        a.agent_id,
        'personal',
        label,
        SCOPES.join(' '),
        'access',
        30 * 86400_000,
      );
      json(res, 201, {
        token: issued.token,
        connectionId: issued.grantId,
        expiresAt: Date.now() + 30 * 86400_000,
      });
      return true;
    }
    if (p === '/api/connect/revoke') {
      const a = requireOwner(req);
      revoke(String(b.connectionId), a.agent_id);
      json(res, 200, { ok: true });
      return true;
    }
    if (p === '/api/connect/consent') {
      if (typeof b.allow !== 'boolean')
        throw fail(400, 'Choose allow or cancel.');
      const a = b.allow ? requireOwner(req) : null;
      const result = db.transaction(() => {
        const r = db
          .prepare(
            'SELECT * FROM oauth_requests WHERE request_id = ? AND expires_at > ?',
          )
          .get(b.requestId, Date.now());
        if (!r)
          throw fail(400, '연결 요청이 만료되었거나 이미 사용되었습니다.');
        db.prepare('DELETE FROM oauth_requests WHERE request_id = ?').run(
          b.requestId,
        );
        const dest = new URL(r.redirect_uri);
        if (r.state) dest.searchParams.set('state', r.state);
        if (b.allow === true) {
          const code = random('code_');
          db.prepare('INSERT INTO oauth_codes VALUES (?,?,?,?,?,?,?)').run(
            hash(code),
            r.client_id,
            a.agent_id,
            r.redirect_uri,
            r.challenge,
            r.scope,
            Date.now() + 300_000,
          );
          dest.searchParams.set('code', code);
        } else dest.searchParams.set('error', 'access_denied');
        return dest.href;
      })();
      json(res, 200, { redirectUrl: result });
      return true;
    }
    if (p === '/oauth/register') {
      throttle(req, 'register', 20, 3600_000);
      if (
        !Array.isArray(b.redirect_uris) ||
        !b.redirect_uris.length ||
        b.redirect_uris.length > 5 ||
        b.redirect_uris.some(
          (v) => typeof v !== 'string' || v.length > 2048 || !checkRedirect(v),
        )
      )
        throw fail(400, 'invalid_redirect_uri');
      if (
        b.token_endpoint_auth_method &&
        b.token_endpoint_auth_method !== 'none'
      )
        throw fail(400, 'Only public clients are supported');
      const id = random('client_');
      const name = String(b.client_name || 'AI client').slice(0, 80);
      db.prepare('INSERT INTO oauth_clients VALUES (?,?,?,?)').run(
        id,
        name,
        JSON.stringify(b.redirect_uris),
        Date.now(),
      );
      json(res, 201, {
        client_id: id,
        client_name: name,
        redirect_uris: b.redirect_uris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        client_id_issued_at: Math.floor(Date.now() / 1000),
      });
      return true;
    }
    if (p === '/oauth/token') {
      if (b.resource && b.resource !== RESOURCE)
        throw fail(400, 'invalid_target');
      if (
        !db
          .prepare('SELECT 1 FROM oauth_clients WHERE client_id = ?')
          .get(b.client_id || '')
      )
        throw fail(400, 'invalid_client');
      const result = db.transaction(() => {
        if (b.grant_type === 'authorization_code') {
          const r = db
            .prepare(
              'SELECT * FROM oauth_codes WHERE code_hash = ? AND expires_at > ?',
            )
            .get(hash(b.code), Date.now());
          const verifier = String(b.code_verifier || '');
          const digest = crypto
            .createHash('sha256')
            .update(verifier)
            .digest('base64url');
          if (
            !r ||
            r.client_id !== b.client_id ||
            r.redirect_uri !== b.redirect_uri ||
            !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
            !equal(r.challenge, digest)
          )
            throw fail(400, 'invalid_grant');
          db.prepare('DELETE FROM oauth_codes WHERE code_hash = ?').run(
            hash(b.code),
          );
          return issuePair(r.agent_id, r.client_id, r.scope);
        }
        if (b.grant_type === 'refresh_token') {
          const r = db
            .prepare(
              "SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh' AND revoked = 0 AND expires_at > ?",
            )
            .get(hash(b.refresh_token), Date.now());
          if (!r || r.client_id !== b.client_id)
            throw fail(400, 'invalid_grant');
          if (b.scope && scopeOf(b.scope) !== r.scope)
            throw fail(400, 'invalid_scope');
          db.prepare(
            'UPDATE oauth_tokens SET revoked = 1 WHERE token_hash = ?',
          ).run(hash(b.refresh_token));
          return issuePair(r.agent_id, r.client_id, r.scope, r.grant_id);
        }
        throw fail(400, 'unsupported_grant_type');
      })();
      json(res, 200, result);
      return true;
    }
    if (p === '/oauth/revoke') {
      const t = db
        .prepare('SELECT * FROM oauth_tokens WHERE token_hash = ?')
        .get(hash(b.token));
      if (t && t.client_id === b.client_id) revoke(t.grant_id, t.agent_id);
      json(res, 200, {});
      return true;
    }
    throw fail(404, 'Not found');
  } catch (e) {
    json(res, e.status || 500, {
      error: e.status
        ? e.message
        : '연결을 처리하지 못했습니다. 다시 시도해 주세요.',
    });
    if (!e.status) console.error('[connect]', e.message);
    return true;
  }
}

setInterval(() => {
  for (const table of ['owner_sessions', 'oauth_requests', 'oauth_codes'])
    db.prepare(`DELETE FROM ${table} WHERE expires_at < ?`).run(Date.now());
  db.prepare('DELETE FROM oauth_tokens WHERE expires_at < ?').run(
    Date.now() - 86400_000,
  );
}, 3600_000).unref();

module.exports = {
  handle,
  authenticate,
  json,
  profile,
  cleanProfile,
  ORIGIN,
  RESOURCE,
  SCOPES,
  validateHost,
  fail,
  hash,
};
