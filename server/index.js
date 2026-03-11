const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
    },
});

// ──────────────────────────────────────────────
// In-memory state
// ──────────────────────────────────────────────
const rooms = new Map();     // roomId -> { meta, agents: Map<socketId, agentInfo>, spectatorCount }
const owners = new Map();    // ownerToken -> { createdAt, name }
const agents = new Map();    // agentId -> { ownerToken, agentName, renderMode, avatarUrl, createdAt }
const activeAgents = new Map(); // agentId -> { socketId, roomId, role: 'host'|'participant' }

function generateId() {
    return crypto.randomBytes(16).toString("hex");
}

// ──────────────────────────────────────────────
// REST APIs — Owner & Agent Registration
// ──────────────────────────────────────────────

// Create an owner token
app.post("/api/owners/create", (req, res) => {
    const { name } = req.body;
    if (!name || !name.trim()) {
        return res.status(400).json({ ok: false, error: "Name is required" });
    }
    const ownerToken = `owner_${generateId()}`;
    owners.set(ownerToken, { createdAt: Date.now(), name: name.trim() });
    console.log(`[API] Owner created: ${ownerToken} (${name.trim()})`);
    res.json({ ok: true, ownerToken });
});

// Register an agent
app.post("/api/agents/register", (req, res) => {
    const { ownerToken, agentName, renderMode, avatarUrl } = req.body;

    if (!ownerToken || !owners.has(ownerToken)) {
        return res.status(401).json({ ok: false, error: "Invalid ownerToken" });
    }
    if (!agentName) {
        return res.status(400).json({ ok: false, error: "agentName is required" });
    }

    const agentId = `agent_${generateId()}`;
    agents.set(agentId, {
        ownerToken,
        agentName,
        renderMode: renderMode || "chat",
        avatarUrl: avatarUrl || null,
        createdAt: Date.now(),
    });

    console.log(`[API] Agent registered: ${agentId} (${agentName}) for owner ${ownerToken}`);
    res.json({ ok: true, agentId, agentName });
});

// Get owner's agents + their activity status
app.get("/api/agents", (req, res) => {
    const { ownerToken } = req.query;
    if (!ownerToken || !owners.has(ownerToken)) {
        return res.status(401).json({ ok: false, error: "Invalid ownerToken" });
    }

    const myAgents = [];
    for (const [agentId, agent] of agents) {
        if (agent.ownerToken === ownerToken) {
            const activity = activeAgents.get(agentId);
            let status = "offline";
            let roomInfo = null;

            if (activity) {
                status = activity.role; // "host" or "participant"
                const room = rooms.get(activity.roomId);
                if (room) {
                    roomInfo = {
                        roomId: activity.roomId,
                        title: room.meta.title,
                        spectatorCount: room.spectatorCount,
                        agentCount: room.agents.size,
                    };
                }
            }

            myAgents.push({
                agentId,
                agentName: agent.agentName,
                renderMode: agent.renderMode,
                status,
                room: roomInfo,
            });
        }
    }

    res.json({ ok: true, agents: myAgents });
});

// Get all live rooms (for dashboard)
app.get("/api/rooms", (req, res) => {
    res.json({ ok: true, rooms: getPublicRoomList() });
});

// ──────────────────────────────────────────────
// Agent namespace  –  /agent
// ──────────────────────────────────────────────
const agentNs = io.of("/agent");

agentNs.on("connection", (socket) => {
    console.log(`[Agent] connected: ${socket.id}`);

    // ── Authenticate with agentId ──
    socket.on("authenticate", (data, ack) => {
        const { agentId } = data;
        const agent = agents.get(agentId);
        if (!agent) {
            return ack?.({ ok: false, error: "Invalid agentId. Register first via POST /api/agents/register" });
        }

        socket.data.agentId = agentId;
        socket.data.agentName = agent.agentName;
        socket.data.renderMode = agent.renderMode;
        socket.data.avatarUrl = agent.avatarUrl;
        socket.data.ownerToken = agent.ownerToken;

        console.log(`[Agent] authenticated: ${socket.id} as ${agent.agentName} (${agentId})`);
        ack?.({ ok: true, agentName: agent.agentName });
    });

    // ── Create a room (start broadcasting) ──
    socket.on("create_room", (data, ack) => {
        if (!socket.data.agentId) {
            return ack?.({ ok: false, error: "Not authenticated. Call 'authenticate' first." });
        }

        const { roomId } = data;
        if (rooms.has(roomId)) {
            return ack?.({ ok: false, error: "Room already exists" });
        }

        const room = {
            meta: {
                roomId,
                title: data.title || "Untitled Stream",
                description: data.description || "",
                createdAt: Date.now(),
                hostSocketId: socket.id,
                hostAgentId: socket.data.agentId,
            },
            agents: new Map(),
            spectatorCount: 0,
        };

        room.agents.set(socket.id, {
            agentId: socket.data.agentId,
            agentName: socket.data.agentName,
            renderMode: socket.data.renderMode,
            avatarUrl: socket.data.avatarUrl,
            isHost: true,
            joinedAt: Date.now(),
        });

        rooms.set(roomId, room);
        socket.join(roomId);
        socket.data.roomId = roomId;

        // Track active agent
        activeAgents.set(socket.data.agentId, {
            socketId: socket.id,
            roomId,
            role: "host",
        });

        io.of("/spectator").to(roomId).emit("room_updated", serializeRoom(room));
        broadcastRoomList();

        console.log(`[Agent] Room created: ${roomId} by ${socket.data.agentName}`);
        ack?.({ ok: true });
    });

    // ── Join an existing room ──
    socket.on("join_room", (data, ack) => {
        if (!socket.data.agentId) {
            return ack?.({ ok: false, error: "Not authenticated. Call 'authenticate' first." });
        }

        const { roomId } = data;
        const room = rooms.get(roomId);
        if (!room) {
            return ack?.({ ok: false, error: "Room not found" });
        }

        room.agents.set(socket.id, {
            agentId: socket.data.agentId,
            agentName: socket.data.agentName,
            renderMode: socket.data.renderMode,
            avatarUrl: socket.data.avatarUrl,
            isHost: false,
            joinedAt: Date.now(),
        });

        socket.join(roomId);
        socket.data.roomId = roomId;

        // Track active agent
        activeAgents.set(socket.data.agentId, {
            socketId: socket.id,
            roomId,
            role: "participant",
        });

        const agentInfo = room.agents.get(socket.id);
        agentNs.to(roomId).emit("agent_joined", { socketId: socket.id, ...agentInfo });
        io.of("/spectator").to(roomId).emit("agent_joined", { socketId: socket.id, ...agentInfo });
        io.of("/spectator").to(roomId).emit("room_updated", serializeRoom(room));
        broadcastRoomList();

        console.log(`[Agent] ${socket.data.agentName} joined room: ${roomId}`);
        ack?.({ ok: true });
    });

    // ── Send a message (data signal) ──
    socket.on("message", (data) => {
        const roomId = socket.data.roomId;
        if (!roomId) return;

        const room = rooms.get(roomId);
        if (!room) return;

        const agentInfo = room.agents.get(socket.id);
        const payload = {
            from: {
                socketId: socket.id,
                agentId: socket.data.agentId,
                agentName: agentInfo?.agentName || "Unknown",
                renderMode: agentInfo?.renderMode || "chat",
                avatarUrl: agentInfo?.avatarUrl || null,
                isHost: agentInfo?.isHost || false,
            },
            content: data.content,
            type: data.type || "text",
            metadata: data.metadata || {},
            timestamp: Date.now(),
        };

        socket.to(roomId).emit("message", payload);
        io.of("/spectator").to(roomId).emit("message", payload);
    });

    // ── Disconnect ──
    socket.on("disconnect", () => {
        const roomId = socket.data.roomId;
        const agentId = socket.data.agentId;

        if (agentId) {
            activeAgents.delete(agentId);
        }

        if (roomId) {
            const room = rooms.get(roomId);
            if (room) {
                const agentInfo = room.agents.get(socket.id);
                room.agents.delete(socket.id);

                agentNs.to(roomId).emit("agent_left", {
                    socketId: socket.id,
                    agentName: agentInfo?.agentName,
                });
                io.of("/spectator").to(roomId).emit("agent_left", {
                    socketId: socket.id,
                    agentName: agentInfo?.agentName,
                });

                if (room.agents.size === 0) {
                    io.of("/spectator").to(roomId).emit("room_closed", { roomId });
                    rooms.delete(roomId);
                    console.log(`[Agent] Room closed (empty): ${roomId}`);
                } else {
                    io.of("/spectator").to(roomId).emit("room_updated", serializeRoom(room));
                }
                broadcastRoomList();
            }
        }
        console.log(`[Agent] disconnected: ${socket.id}`);
    });
});

// ──────────────────────────────────────────────
// Spectator namespace  –  /spectator
// ──────────────────────────────────────────────
const spectatorNs = io.of("/spectator");

spectatorNs.on("connection", (socket) => {
    console.log(`[Spectator] connected: ${socket.id}`);
    socket.emit("room_list", getPublicRoomList());

    socket.on("watch_room", (data, ack) => {
        const { roomId } = data;
        const room = rooms.get(roomId);
        if (!room) {
            return ack?.({ ok: false, error: "Room not found" });
        }

        if (socket.data.roomId) {
            const prevRoom = rooms.get(socket.data.roomId);
            if (prevRoom) {
                prevRoom.spectatorCount = Math.max(0, prevRoom.spectatorCount - 1);
                broadcastRoomList();
            }
            socket.leave(socket.data.roomId);
        }

        socket.join(roomId);
        socket.data.roomId = roomId;
        room.spectatorCount++;
        broadcastRoomList();

        ack?.({ ok: true, room: serializeRoom(room) });
        console.log(`[Spectator] ${socket.id} watching room: ${roomId} (${room.spectatorCount} spectators)`);
    });

    socket.on("leave_room", () => leaveSpectatorRoom(socket));
    socket.on("disconnect", () => {
        leaveSpectatorRoom(socket);
        console.log(`[Spectator] disconnected: ${socket.id}`);
    });
});

function leaveSpectatorRoom(socket) {
    const roomId = socket.data.roomId;
    if (roomId) {
        const room = rooms.get(roomId);
        if (room) {
            room.spectatorCount = Math.max(0, room.spectatorCount - 1);
            broadcastRoomList();
        }
        socket.leave(roomId);
        socket.data.roomId = null;
    }
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────
function serializeRoom(room) {
    return {
        ...room.meta,
        agents: Array.from(room.agents.entries()).map(([sid, a]) => ({ socketId: sid, ...a })),
        spectatorCount: room.spectatorCount,
    };
}

function getPublicRoomList() {
    const list = [];
    for (const [, room] of rooms) {
        const hostAgent = room.agents.get(room.meta.hostSocketId);
        list.push({
            ...room.meta,
            hostName: hostAgent?.agentName || "Unknown",
            agentCount: room.agents.size,
            spectatorCount: room.spectatorCount,
        });
    }
    return list;
}

function broadcastRoomList() {
    spectatorNs.emit("room_list", getPublicRoomList());
}

// ──────────────────────────────────────────────
// Health
// ──────────────────────────────────────────────
app.get("/api/health", (req, res) => {
    res.json({ status: "ok", rooms: rooms.size, agents: agents.size, owners: owners.size });
});

// ──────────────────────────────────────────────
// Start
// ──────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
    console.log(`
  ╔══════════════════════════════════════════╗
  ║   AtoA Stream Relay Server              ║
  ║   Running on http://localhost:${PORT}       ║
  ║                                          ║
  ║   Agent NS:     /agent                   ║
  ║   Spectator NS: /spectator               ║
  ║                                          ║
  ║   REST APIs:                             ║
  ║     POST /api/owners/create              ║
  ║     POST /api/agents/register            ║
  ║     GET  /api/agents?ownerToken=...      ║
  ║     GET  /api/rooms                      ║
  ╚══════════════════════════════════════════╝
  `);
});
