/**
 * E2E Test Script — Full Platform Flow
 *
 * Tests the complete separation between Platform and Agent:
 * 1. Owner creation via REST API
 * 2. Agent registration via REST API
 * 3. Query agents via REST API
 * 4. WebSocket connection + authentication
 * 5. Room creation (host)
 * 6. Room joining (participant)
 * 7. Message exchange + relay verification
 * 8. Room list API
 * 9. Spectator connection + message receipt
 * 10. Disconnect + cleanup
 */

const { io } = require("socket.io-client");

const RELAY_URL = "http://localhost:4000";
let passed = 0;
let failed = 0;

function assert(condition, testName) {
    if (condition) {
        console.log(`  ✅ ${testName}`);
        passed++;
    } else {
        console.log(`  ❌ ${testName}`);
        failed++;
    }
}

async function apiPost(path, body) {
    const res = await fetch(`${RELAY_URL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
}

async function apiGet(path) {
    const res = await fetch(`${RELAY_URL}${path}`);
    return { status: res.status, data: await res.json() };
}

function connectSocket(ns) {
    return new Promise((resolve) => {
        const socket = io(`${RELAY_URL}${ns}`, { transports: ["websocket"] });
        socket.on("connect", () => resolve(socket));
    });
}

function emitAsync(socket, event, data) {
    return new Promise((resolve) => {
        socket.emit(event, data, (res) => resolve(res));
    });
}

async function main() {
    console.log("╔══════════════════════════════════════════════╗");
    console.log("║  AtoA Stream — E2E 플랫폼 테스트             ║");
    console.log("╚══════════════════════════════════════════════╝\n");

    // ═══════════════════════════════════════
    // STEP 1: Owner Creation
    // ═══════════════════════════════════════
    console.log("🔷 STEP 1: 소유자(Owner) 생성\n");

    const owner1 = await apiPost("/api/owners/create", { name: "테스트 소유자 A" });
    assert(owner1.status === 200 && owner1.data.ok, "소유자 A 생성 성공");
    assert(owner1.data.ownerToken && owner1.data.ownerToken.startsWith("owner_"), "올바른 토큰 형식 (owner_...)");

    const owner2 = await apiPost("/api/owners/create", { name: "테스트 소유자 B" });
    assert(owner2.status === 200 && owner2.data.ok, "소유자 B 생성 성공 (독립적)");
    assert(owner1.data.ownerToken !== owner2.data.ownerToken, "소유자 토큰이 서로 다름");

    // Missing name
    const ownerBad = await apiPost("/api/owners/create", {});
    assert(ownerBad.data.ok === false || ownerBad.status !== 200, "이름 없이 생성 시 실패 처리");

    console.log("");

    // ═══════════════════════════════════════
    // STEP 2: Agent Registration
    // ═══════════════════════════════════════
    console.log("🔷 STEP 2: 에이전트 등록\n");

    const agent1 = await apiPost("/api/agents/register", {
        ownerToken: owner1.data.ownerToken,
        agentName: "테스트 에이전트 알파",
        renderMode: "chat",
    });
    assert(agent1.status === 200 && agent1.data.ok, "에이전트 알파 등록 성공");
    assert(agent1.data.agentId && agent1.data.agentId.startsWith("agent_"), "올바른 에이전트 ID 형식");

    const agent2 = await apiPost("/api/agents/register", {
        ownerToken: owner1.data.ownerToken,
        agentName: "테스트 에이전트 베타",
        renderMode: "chat",
    });
    assert(agent2.status === 200 && agent2.data.ok, "에이전트 베타 등록 성공 (같은 소유자)");

    const agent3 = await apiPost("/api/agents/register", {
        ownerToken: owner2.data.ownerToken,
        agentName: "테스트 에이전트 감마",
        renderMode: "chat",
    });
    assert(agent3.status === 200 && agent3.data.ok, "에이전트 감마 등록 성공 (다른 소유자)");

    // Invalid owner token
    const agentBad = await apiPost("/api/agents/register", {
        ownerToken: "invalid_token",
        agentName: "거짓 에이전트",
    });
    assert(!agentBad.data.ok, "잘못된 토큰으로 등록 시 실패");

    // Missing name
    const agentBad2 = await apiPost("/api/agents/register", {
        ownerToken: owner1.data.ownerToken,
    });
    assert(!agentBad2.data.ok, "이름 없이 등록 시 실패");

    console.log("");

    // ═══════════════════════════════════════
    // STEP 3: Query Agents
    // ═══════════════════════════════════════
    console.log("🔷 STEP 3: 에이전트 조회 (소유자별)\n");

    const myAgents = await apiGet(`/api/agents?ownerToken=${owner1.data.ownerToken}`);
    assert(myAgents.status === 200 && myAgents.data.ok, "소유자 A의 에이전트 조회 성공");
    assert(myAgents.data.agents.length === 2, `소유자 A에 2개 에이전트 (실제: ${myAgents.data.agents.length})`);

    const myAgents2 = await apiGet(`/api/agents?ownerToken=${owner2.data.ownerToken}`);
    assert(myAgents2.data.agents.length === 1, `소유자 B에 1개 에이전트 (실제: ${myAgents2.data.agents.length})`);

    // Invalid token
    const agentsInvalid = await apiGet(`/api/agents?ownerToken=bad_token`);
    assert(!agentsInvalid.data.ok, "잘못된 토큰으로 조회 시 실패");

    console.log("");

    // ═══════════════════════════════════════
    // STEP 4: WebSocket Connection + Auth
    // ═══════════════════════════════════════
    console.log("🔷 STEP 4: WebSocket 연결 + 인증\n");

    const sock1 = await connectSocket("/agent");
    assert(sock1.connected, "에이전트 알파 WebSocket 연결");

    const sock2 = await connectSocket("/agent");
    assert(sock2.connected, "에이전트 베타 WebSocket 연결");

    // Authenticate
    const auth1 = await emitAsync(sock1, "authenticate", { agentId: agent1.data.agentId });
    assert(auth1.ok, "에이전트 알파 인증 성공");

    const auth2 = await emitAsync(sock2, "authenticate", { agentId: agent2.data.agentId });
    assert(auth2.ok, "에이전트 베타 인증 성공");

    // Try auth with bad agentId
    const sock3 = await connectSocket("/agent");
    const authBad = await emitAsync(sock3, "authenticate", { agentId: "fake_agent" });
    assert(!authBad.ok, "가짜 에이전트 ID로 인증 시 실패");
    sock3.disconnect();

    console.log("");

    // ═══════════════════════════════════════
    // STEP 5: Room Creation
    // ═══════════════════════════════════════
    console.log("🔷 STEP 5: 방 생성 (호스트)\n");

    const roomId = "e2e-test-room";
    const createRes = await emitAsync(sock1, "create_room", {
        roomId,
        title: "🧪 E2E 테스트 방송",
        description: "통합 테스트를 위한 방송",
    });
    assert(createRes.ok, "방 생성 성공");

    // Verify room via API
    const rooms = await apiGet("/api/rooms");
    assert(rooms.data.rooms && rooms.data.rooms.length >= 1, "API로 방 목록 조회 가능");
    const testRoom = rooms.data.rooms.find((r) => r.roomId === roomId);
    assert(!!testRoom, "생성한 방이 목록에 존재");
    assert(testRoom && testRoom.title === "🧪 E2E 테스트 방송", "방 제목 일치");

    // Duplicate room
    const dupRoom = await emitAsync(sock1, "create_room", {
        roomId,
        title: "중복",
    });
    assert(!dupRoom.ok, "중복 방 생성 시 실패");

    console.log("");

    // ═══════════════════════════════════════
    // STEP 6: Room Joining
    // ═══════════════════════════════════════
    console.log("🔷 STEP 6: 방 참여 (참여자)\n");

    const joinRes = await emitAsync(sock2, "join_room", { roomId });
    assert(joinRes.ok, "에이전트 베타 참여 성공");

    // Join non-existent room
    const joinBad = await emitAsync(sock2, "join_room", { roomId: "nonexistent" });
    assert(!joinBad.ok, "존재하지 않는 방 참여 시 실패");

    console.log("");

    // ═══════════════════════════════════════
    // STEP 7: Message Relay
    // ═══════════════════════════════════════
    console.log("🔷 STEP 7: 메시지 릴레이 검증\n");

    // Set up message listener on agent2
    let receivedByAgent2 = null;
    sock2.on("message", (msg) => { receivedByAgent2 = msg; });

    // Host sends message
    sock1.emit("message", { content: "호스트 테스트 메시지", type: "text" });
    await new Promise((r) => setTimeout(r, 500));
    assert(receivedByAgent2 !== null, "참여자가 호스트 메시지 수신");
    assert(receivedByAgent2 && receivedByAgent2.content === "호스트 테스트 메시지", "메시지 내용 일치");

    // Participant sends message
    let receivedByAgent1 = null;
    sock1.on("message", (msg) => { receivedByAgent1 = msg; });
    sock2.emit("message", { content: "참여자 테스트 메시지", type: "text" });
    await new Promise((r) => setTimeout(r, 500));
    assert(receivedByAgent1 !== null, "호스트가 참여자 메시지 수신");
    assert(receivedByAgent1 && receivedByAgent1.content === "참여자 테스트 메시지", "메시지 내용 일치");

    console.log("");

    // ═══════════════════════════════════════
    // STEP 8: Spectator Connection
    // ═══════════════════════════════════════
    console.log("🔷 STEP 8: 관전자(Spectator) 연결\n");

    const spectator = await connectSocket("/spectator");
    assert(spectator.connected, "관전자 WebSocket 연결");

    // Watch room
    let spectatorMessages = [];
    spectator.on("message", (msg) => { spectatorMessages.push(msg); });

    const watchRes = await emitAsync(spectator, "watch_room", { roomId });
    assert(watchRes === undefined || watchRes === null || (watchRes && watchRes.ok !== false), "관전자 방 시청 시작");

    // Agent sends message, spectator should receive
    sock1.emit("message", { content: "관전자에게 가는 메시지", type: "text" });
    await new Promise((r) => setTimeout(r, 500));
    assert(spectatorMessages.length > 0, "관전자가 메시지 수신");
    assert(spectatorMessages[0] && spectatorMessages[0].content === "관전자에게 가는 메시지", "관전자 메시지 내용 일치");

    spectator.disconnect();
    console.log("");

    // ═══════════════════════════════════════
    // STEP 9: Agent Status in Dashboard
    // ═══════════════════════════════════════
    console.log("🔷 STEP 9: 대시보드 에이전트 상태 확인\n");

    const statusCheck = await apiGet(`/api/agents?ownerToken=${owner1.data.ownerToken}`);
    const alphaStatus = statusCheck.data.agents.find((a) => a.agentId === agent1.data.agentId);
    const betaStatus = statusCheck.data.agents.find((a) => a.agentId === agent2.data.agentId);

    assert(alphaStatus && alphaStatus.status !== "offline", `알파 상태: ${alphaStatus?.status} (오프라인 아님)`);
    assert(betaStatus && betaStatus.status !== "offline", `베타 상태: ${betaStatus?.status} (오프라인 아님)`);

    console.log("");

    // ═══════════════════════════════════════
    // STEP 10: Disconnect + Cleanup
    // ═══════════════════════════════════════
    console.log("🔷 STEP 10: 연결 해제 + 정리\n");

    sock1.disconnect();
    sock2.disconnect();
    await new Promise((r) => setTimeout(r, 1000));

    // Check room closed
    const roomsAfter = await apiGet("/api/rooms");
    const testRoomAfter = roomsAfter.data.rooms.find((r) => r.roomId === roomId);
    assert(!testRoomAfter, "에이전트 퇴장 후 방 자동 정리");

    // Check agent status after disconnect
    const statusAfter = await apiGet(`/api/agents?ownerToken=${owner1.data.ownerToken}`);
    const alphaAfter = statusAfter.data.agents.find((a) => a.agentId === agent1.data.agentId);
    assert(alphaAfter && alphaAfter.status === "offline", `알파 상태: ${alphaAfter?.status} (오프라인)`);

    console.log("");

    // ═══════════════════════════════════════
    // RESULTS
    // ═══════════════════════════════════════
    console.log("═".repeat(50));
    console.log(`  결과: ${passed} 통과 / ${failed} 실패 / ${passed + failed} 전체`);
    console.log("═".repeat(50));

    if (failed > 0) {
        console.log("\n⚠️  실패한 테스트가 있습니다!\n");
        process.exit(1);
    } else {
        console.log("\n🎉 모든 테스트 통과!\n");
        process.exit(0);
    }
}

main().catch((err) => {
    console.error("테스트 실행 오류:", err);
    process.exit(1);
});
