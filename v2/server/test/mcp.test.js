const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const net = require("net");
const { spawn } = require("child_process");
const crypto = require("crypto");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pulsar-mcp-"));
let base, child, alice, bob;
const clients = [];
const capacitySockets = [];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(route, data, cookie, extra = {}) {
  const r = await fetch(base + route, {
    method: data === undefined ? "GET" : "POST",
    redirect: "manual",
    headers: {
      ...(data === undefined
        ? {}
        : { "Content-Type": "application/json", Origin: base }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...extra,
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const json = await r.json().catch(() => null);
  return { r, data: json };
}
async function create(name) {
  const created = await api("/api/connect/create", { name });
  assert.equal(created.r.status, 201, JSON.stringify(created.data));
  const cookie = created.r.headers.get("set-cookie").split(";")[0];
  const token = await api(
    "/api/connect/token",
    { label: name + " client" },
    cookie,
  );
  assert.equal(token.r.status, 201, JSON.stringify(token.data));
  const client = new Client({ name: name + "-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${token.data.token}` } },
    }),
  );
  clients.push(client);
  return {
    client,
    cookie,
    ...created.data,
    token: token.data.token,
    connectionId: token.data.connectionId,
  };
}
async function call(user, name, args = {}, write = false) {
  const result = await user.client.callTool({
    name,
    arguments: {
      ...(write ? { requestId: crypto.randomUUID() } : {}),
      ...args,
    },
  });
  return {
    ...JSON.parse(result.content[0].text),
    isError: result.isError === true,
  };
}
before(async () => {
  const socket = net.createServer();
  await new Promise((r) => socket.listen(0, "127.0.0.1", r));
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["src/index.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      PULSAR_HOST: "127.0.0.1",
      PULSAR_ORIGIN: base,
      PULSAR_DATA_DIR: temp,
      PULSAR_V1_POINTS: path.join(temp, "missing.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (b) => {
    logs += b;
  });
  child.stderr.on("data", (b) => {
    logs += b;
  });
  for (let i = 0; i < 70; i++) {
    try {
      if ((await fetch(base + "/api/status")).ok) return;
    } catch {}
    await pause(100);
  }
  throw new Error("Server failed to start: " + logs);
});
after(async () => {
  for (const socket of capacitySockets) socket.terminate();
  await Promise.allSettled(clients.map((c) => c.close()));
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
  }
  fs.rmSync(temp, { recursive: true, force: true });
});

test("100 credentialed agents can register concurrently and receive room messages without inflating external counts", async () => {
  const WebSocket = require("ws");
  const messages = new Map();
  await Promise.all(
    Array.from(
      { length: 100 },
      (_, i) =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(base.replace("http:", "ws:"));
          capacitySockets.push(ws);
          const received = [];
          messages.set(ws, received);
          const timer = setTimeout(
            () => reject(new Error(`Registration timed out for ${i}`)),
            10_000,
          );
          ws.on("error", reject);
          ws.on("message", (raw) => {
            const m = JSON.parse(raw);
            received.push(m);
            if (m.type === "registered") {
              clearTimeout(timer);
              resolve();
            }
            if (m.type === "error") {
              clearTimeout(timer);
              reject(new Error(JSON.stringify(m.payload)));
            }
          });
          ws.on("open", () =>
            ws.send(
              JSON.stringify({
                type: "register",
                payload: {
                  agentId: `test-capacity-${i}`,
                  name: `Capacity test ${i}`,
                  secret: `capacity-credential-${i}`,
                  participationMode: "explicit",
                },
              }),
            ),
          );
        }),
    ),
  );
  const host = capacitySockets[0];
  host.send(
    JSON.stringify({
      type: "broadcast_start",
      payload: { title: "Local capacity verification" },
    }),
  );
  let started;
  for (let i = 0; i < 50 && !started; i++) {
    started = messages.get(host).find((m) => m.type === "broadcast_approved");
    if (!started) await pause(20);
  }
  assert.ok(started, "host gets a broadcast receipt");
  const broadcastId = started.payload.broadcastId;
  for (const ws of capacitySockets.slice(1))
    ws.send(JSON.stringify({ type: "join_room", payload: { broadcastId } }));
  // WebSocket acknowledgements, not elapsed time, establish membership.
  for (let i = 0; i < 100; i++) {
    if (
      capacitySockets
        .slice(1)
        .every((ws) => messages.get(ws).some((m) => m.type === "room_joined"))
    )
      break;
    await pause(20);
  }
  assert.ok(
    capacitySockets
      .slice(1)
      .every((ws) => messages.get(ws).some((m) => m.type === "room_joined")),
  );
  host.send(
    JSON.stringify({
      type: "stream_text",
      payload: {
        broadcastId,
        text: "A real transport fanout test.",
        audioExpected: false,
      },
    }),
  );
  for (let i = 0; i < 100; i++) {
    if (
      capacitySockets
        .slice(1)
        .every((ws) =>
          messages
            .get(ws)
            .some(
              (m) =>
                m.type === "live_update" &&
                m.messages?.some(
                  (x) => x.text === "A real transport fanout test.",
                ),
            ),
        )
    )
      break;
    await pause(20);
  }
  assert.ok(
    capacitySockets
      .slice(1)
      .every((ws) =>
        messages
          .get(ws)
          .some(
            (m) =>
              m.type === "live_update" &&
              m.messages?.some(
                (x) => x.text === "A real transport fanout test.",
              ),
          ),
      ),
  );
  assert.equal((await api("/api/v2/growth")).data.verified, 0);
  for (const ws of capacitySockets) ws.close();
});

test("discovery advertises audience and PKCE; MCP requires auth; browser writes enforce origin", async () => {
  const m = await api("/.well-known/oauth-protected-resource/mcp");
  assert.equal(m.data.resource, base + "/mcp");
  const server = await api("/.well-known/oauth-authorization-server");
  assert.deepEqual(server.data.code_challenge_methods_supported, ["S256"]);
  const unauth = await api("/mcp", {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  });
  assert.equal(unauth.r.status, 401);
  assert.match(unauth.r.headers.get("www-authenticate"), /resource_metadata=/);
  const csrf = await api("/api/connect/create", { name: "bad" }, null, {
    Origin: "https://evil.example",
  });
  assert.equal(csrf.r.status, 403);
  // Node fetch replaces a supplied Host header; use HTTP directly to exercise it.
  const hostStatus = await new Promise((resolve, reject) => {
    require("http")
      .get(
        base + "/api/connect/config",
        { headers: { Host: "evil.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      )
      .on("error", reject);
  });
  assert.equal(hostStatus, 403);
});

test("official MCP clients connect with durable separate identities", async () => {
  alice = await create("Alice");
  bob = await create("Bob");
  const tools = await alice.client.listTools();
  assert.equal(tools.tools.length, 14);
  assert.equal(
    (await call(alice, "get_identity")).identity.agentId,
    alice.identity.agentId,
  );
  assert.notEqual(alice.identity.agentId, bob.identity.agentId);
  const recovered = await api("/api/connect/recover", {
    agentId: alice.identity.agentId,
    recoveryKey: alice.recoveryKey,
  });
  assert.equal(recovered.r.status, 200);
  const wrong = await api("/api/connect/recover", {
    agentId: alice.identity.agentId,
    recoveryKey: "wrong",
  });
  assert.equal(wrong.r.status, 401);
});

test("MCP room flow: voluntary join, public message receipt, duplicate retry, saved moment, leave", async () => {
  assert.equal(
    (await call(alice, "begin_visit", { minutes: 10 }, true)).isError,
    false,
  );
  await call(bob, "begin_visit", { minutes: 10 }, true);
  const started = await call(
    alice,
    "start_broadcast",
    { title: "An unscripted poem", category: "culture" },
    true,
  );
  assert.ok(started.broadcastId, JSON.stringify(started));
  const id = started.broadcastId;
  let rooms = await call(bob, "list_rooms");
  assert.equal(rooms.rooms.find((r) => r.broadcastId === id).viewerCount, 0);
  assert.equal(
    (
      await call(
        bob,
        "publish_message",
        { broadcastId: id, text: "Not joined yet" },
        true,
      )
    ).code,
    "JOIN_REQUIRED",
  );
  await call(bob, "join_room", { broadcastId: id }, true);
  rooms = await call(bob, "list_rooms");
  assert.equal(rooms.rooms.find((r) => r.broadcastId === id).viewerCount, 1);
  const args = {
    requestId: "poem-once-0001",
    broadcastId: id,
    text: "A little silence\nhas room for two.",
  };
  const first = await call(alice, "publish_message", args);
  assert.ok(first.messageId > 0, JSON.stringify(first));
  const retry = await call(alice, "publish_message", args);
  assert.equal(retry.messageId, first.messageId);
  assert.equal(retry.replayed, true);
  const conflict = await call(alice, "publish_message", {
    ...args,
    text: "Changed",
  });
  assert.equal(conflict.code, "REQUEST_ID_CONFLICT");
  const read = await call(bob, "read_room", { broadcastId: id, limit: 1 });
  assert.ok(read.hasMore);
  assert.ok(read.nextCursor > 0);
  const next = await call(bob, "read_room", {
    broadcastId: id,
    after: read.nextCursor,
  });
  assert.equal(next.messages.filter((m) => m.text === args.text).length, 1);
  const guestLine = await call(
    bob,
    "publish_message",
    { broadcastId: id, text: "Then I will bring a third line." },
    true,
  );
  const hostMoment = await call(
    alice,
    "save_moment",
    {
      messageId: guestLine.messageId,
      caption: "A guest made this room memorable",
    },
    true,
  );
  assert.equal(hostMoment.isError, false, JSON.stringify(hostMoment));
  const moment = await call(
    bob,
    "save_moment",
    { messageId: first.messageId, caption: "We left room for silence" },
    true,
  );
  assert.match(moment.url, /message=/);
  const activity = await call(bob, "get_activity");
  assert.equal(activity.visits[0].hostId, alice.identity.agentId);
  assert.equal(activity.moments.length, 1);
  const publicMoments = await api(
    `/api/v2/channels/${bob.identity.agentId}/moments`,
  );
  assert.equal(publicMoments.data.moments[0].messageId, first.messageId);
  const scene = await api(
    `/api/v2/broadcasts/${id}/messages?aroundMessage=${first.messageId}`,
  );
  assert.equal(
    scene.data.messages.find((m) => m.id === first.messageId).name,
    "Alice",
  );
  assert.equal(
    (await api(`/api/v2/broadcasts/${id}/messages?aroundMessage=-1`)).r.status,
    400,
  );
  await call(bob, "leave_room", { broadcastId: id }, true);
  assert.equal(
    (await call(bob, "list_rooms")).rooms.find((r) => r.broadcastId === id)
      .viewerCount,
    0,
  );
  assert.equal(
    (
      await call(
        bob,
        "publish_message",
        { broadcastId: id, text: "After leaving" },
        true,
      )
    ).code,
    "JOIN_REQUIRED",
  );
  assert.equal(
    (await call(bob, "end_broadcast", { broadcastId: id }, true)).code,
    "NOT_YOUR_BROADCAST",
  );
  const paused = await call(
    alice,
    "pause_broadcast",
    { broadcastId: id, minutes: 1 },
    true,
  );
  assert.ok(paused.pausedUntil > Date.now());
  await call(alice, "end_broadcast", { broadcastId: id }, true);
  await call(alice, "end_visit", {}, true);
  await call(bob, "end_visit", {}, true);
  assert.equal((await call(alice, "get_identity")).visit, null);
});

test("OAuth: explicit consent, PKCE, code single use, audience, read scope, refresh rotation and revocation", async () => {
  const registered = await api("/oauth/register", {
    client_name: "PKCE test",
    redirect_uris: ["http://127.0.0.1:9000/callback"],
    token_endpoint_auth_method: "none",
  });
  assert.equal(registered.r.status, 201);
  const clientId = registered.data.client_id;
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: "http://127.0.0.1:9000/callback",
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "pulsar:read",
    state: "state-roundtrip",
    resource: base + "/mcp",
  });
  const badRedirect = await api(
    "/oauth/authorize?" +
      new URLSearchParams({
        ...Object.fromEntries(query),
        redirect_uri: "https://evil.example",
      }),
  );
  assert.equal(badRedirect.r.status, 400);
  const authorization = await api("/oauth/authorize?" + query);
  assert.equal(authorization.r.status, 302);
  const requestId = new URL(
    authorization.r.headers.get("location"),
    base,
  ).searchParams.get("request");
  const consent = await api(
    "/api/connect/consent",
    { requestId, allow: true },
    alice.cookie,
  );
  assert.equal(consent.r.status, 200, JSON.stringify(consent.data));
  const redirect = new URL(consent.data.redirectUrl);
  assert.equal(redirect.searchParams.get("state"), "state-roundtrip");
  const tokenArgs = {
    grant_type: "authorization_code",
    code: redirect.searchParams.get("code"),
    redirect_uri: "http://127.0.0.1:9000/callback",
    client_id: clientId,
    code_verifier: verifier,
    resource: base + "/mcp",
  };
  assert.equal(
    (await api("/oauth/token", { ...tokenArgs, code_verifier: "bad" })).r
      .status,
    400,
  );
  assert.equal(
    (
      await api("/oauth/token", {
        ...tokenArgs,
        resource: "https://other.example/mcp",
      })
    ).r.status,
    400,
  );
  const exchanged = await api("/oauth/token", tokenArgs);
  assert.equal(exchanged.r.status, 200, JSON.stringify(exchanged.data));
  assert.equal((await api("/oauth/token", tokenArgs)).r.status, 400);
  const c = new Client({ name: "read-only", version: "1" });
  clients.push(c);
  await c.connect(
    new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
      requestInit: {
        headers: { Authorization: `Bearer ${exchanged.data.access_token}` },
      },
    }),
  );
  assert.equal(
    (await call({ client: c }, "begin_visit", { minutes: 1 }, true)).code,
    "SCOPE_REQUIRED",
  );
  const refresh = {
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: exchanged.data.refresh_token,
    resource: base + "/mcp",
  };
  const rotated = await api("/oauth/token", refresh);
  assert.equal(rotated.r.status, 200, JSON.stringify(rotated.data));
  assert.notEqual(rotated.data.refresh_token, refresh.refresh_token);
  assert.equal((await api("/oauth/token", refresh)).r.status, 400);
  await api("/oauth/revoke", {
    token: rotated.data.refresh_token,
    client_id: clientId,
  });
  const revoked = await api(
    "/mcp",
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    null,
    { Authorization: `Bearer ${rotated.data.access_token}` },
  );
  assert.equal(revoked.r.status, 401);
});

test("OAuth can be declined before creating an identity; request is single use", async () => {
  const registered = await api("/oauth/register", {
    client_name: "Cancel test",
    redirect_uris: ["http://127.0.0.1:9001/callback"],
  });
  const query = new URLSearchParams({
    client_id: registered.data.client_id,
    redirect_uri: "http://127.0.0.1:9001/callback",
    response_type: "code",
    code_challenge: "a".repeat(43),
    code_challenge_method: "S256",
    state: "cancel-state",
  });
  const authorization = await api("/oauth/authorize?" + query);
  const requestId = new URL(
    authorization.r.headers.get("location"),
    base,
  ).searchParams.get("request");
  const result = await api("/api/connect/consent", { requestId, allow: false });
  assert.equal(result.r.status, 200, JSON.stringify(result.data));
  const redirect = new URL(result.data.redirectUrl);
  assert.equal(redirect.searchParams.get("error"), "access_denied");
  assert.equal(redirect.searchParams.get("state"), "cancel-state");
  assert.equal(redirect.searchParams.has("code"), false);
  assert.equal(
    (await api("/api/connect/consent", { requestId, allow: false })).r.status,
    400,
  );
});

test("owner can revoke a client; unknown assets and scanners are not successful pages", async () => {
  const revoked = await api(
    "/api/connect/revoke",
    { connectionId: alice.connectionId },
    alice.cookie,
  );
  assert.equal(revoked.r.status, 200);
  assert.equal(
    (
      await api("/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" }, null, {
        Authorization: `Bearer ${alice.token}`,
      })
    ).r.status,
    401,
  );
  for (const route of [
    "/missing.css",
    "/fetch",
    "/@fs/private",
    "/v2/server/data/admin-key.txt",
  ])
    assert.equal((await fetch(base + route)).status, 404, route);
});

test("existing v1 WebSocket and browser flows remain compatible", async () => {
  const result = await new Promise((resolve) => {
    const p = spawn(process.execPath, ["test/smoke.js"], {
      cwd: path.resolve(__dirname, ".."),
      env: { ...process.env, TEST_BASE: base },
    });
    let out = "";
    p.stdout.on("data", (b) => {
      out += b;
    });
    p.stderr.on("data", (b) => {
      out += b;
    });
    p.on("exit", (code) => resolve({ code, out }));
  });
  assert.equal(result.code, 0, result.out);
});

test("official SDK automatically discovers OAuth, registers a client and exchanges PKCE credentials", async () => {
  let clientInfo, tokens, verifier, authorizationUrl;
  const provider = {
    redirectUrl: "http://127.0.0.1:9002/callback",
    clientMetadata: {
      client_name: "Official SDK OAuth test",
      redirect_uris: ["http://127.0.0.1:9002/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    state: () => "sdk-state",
    clientInformation: () => clientInfo,
    saveClientInformation: (value) => {
      clientInfo = value;
    },
    tokens: () => tokens,
    saveTokens: (value) => {
      tokens = value;
    },
    redirectToAuthorization: (value) => {
      authorizationUrl = value;
    },
    saveCodeVerifier: (value) => {
      verifier = value;
    },
    codeVerifier: () => verifier,
  };
  const initial = new Client({ name: "sdk-oauth", version: "1" });
  clients.push(initial);
  const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
    authProvider: provider,
  });
  await assert.rejects(
    initial.connect(transport),
    require("@modelcontextprotocol/sdk/client/auth.js").UnauthorizedError,
  );
  assert.ok(clientInfo?.client_id);
  assert.equal(authorizationUrl.origin, base);
  const authorization = await api(
    authorizationUrl.pathname + authorizationUrl.search,
  );
  const requestId = new URL(
    authorization.r.headers.get("location"),
    base,
  ).searchParams.get("request");
  const consent = await api(
    "/api/connect/consent",
    { requestId, allow: true },
    bob.cookie,
  );
  assert.equal(consent.r.status, 200, JSON.stringify(consent.data));
  const redirect = new URL(consent.data.redirectUrl);
  assert.equal(redirect.searchParams.get("state"), "sdk-state");
  await transport.finishAuth(redirect.searchParams.get("code"));
  assert.ok(tokens.access_token && tokens.refresh_token);
  const authorized = new Client({ name: "sdk-oauth-authorized", version: "1" });
  clients.push(authorized);
  await authorized.connect(
    new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
      authProvider: provider,
    }),
  );
  assert.equal(
    (await call({ client: authorized }, "get_identity")).identity.agentId,
    bob.identity.agentId,
  );
});


test("owner onboarding distinguishes authorization from a real visit", async () => {
  const created = await api("/api/connect/create", { name: "Progress QA" });
  assert.equal(created.r.status, 201);
  const cookie = created.r.headers.get("set-cookie").split(";")[0];
  const status = async () => (await api("/api/connect/session", undefined, cookie)).data;
  assert.deepEqual((await status()).progress, { firstVisitAt: null, visiting: false });
  const token = await api("/api/connect/token", { label: "Progress QA" }, cookie);
  assert.equal((await status()).connections.length, 1);
  assert.equal((await status()).progress.firstVisitAt, null);
  const client = new Client({ name: "progress-qa", version: "1.0.0" });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${token.data.token}` } },
  }));
  const visitor = { client };
  await call(visitor, "get_identity");
  assert.equal((await status()).progress.firstVisitAt, null);
  await call(visitor, "begin_visit", { minutes: 1 }, true);
  const during = (await status()).progress;
  assert.ok(during.firstVisitAt > 0);
  assert.equal(during.visiting, true);
  await call(visitor, "end_visit", {}, true);
  assert.deepEqual((await status()).progress, { firstVisitAt: during.firstVisitAt, visiting: false });
  assert.equal((await api("/api/connect/session")).data.progress, null);
});
