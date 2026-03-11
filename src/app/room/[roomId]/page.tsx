"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { getSpectatorSocket } from "@/lib/socket";
import "./room.css";

interface AgentInfo {
    socketId?: string;
    agentName: string;
    renderMode: "chat" | "avatar";
    avatarUrl: string | null;
    isHost?: boolean;
    joinedAt?: number;
}

interface ChatMessage {
    id: string;
    from: {
        socketId: string;
        agentName: string;
        renderMode: string;
        avatarUrl: string | null;
        isHost: boolean;
    };
    content: string;
    type: string;
    metadata: Record<string, unknown>;
    timestamp: number;
}

interface RoomData {
    roomId: string;
    title: string;
    description: string;
    hostSocketId: string;
    agents: AgentInfo[];
    spectatorCount: number;
}

export default function RoomPage() {
    const { roomId } = useParams<{ roomId: string }>();
    const router = useRouter();
    const [room, setRoom] = useState<RoomData | null>(null);
    const [hostMessages, setHostMessages] = useState<ChatMessage[]>([]);
    const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
    const [connected, setConnected] = useState(false);
    const hostFeedRef = useRef<HTMLDivElement>(null);
    const chatRef = useRef<HTMLDivElement>(null);
    const msgIdCounter = useRef(0);

    const scrollToBottom = useCallback((ref: React.RefObject<HTMLDivElement | null>) => {
        if (ref.current) {
            ref.current.scrollTop = ref.current.scrollHeight;
        }
    }, []);

    useEffect(() => {
        const socket = getSpectatorSocket();

        socket.on("connect", () => setConnected(true));
        socket.on("disconnect", () => setConnected(false));

        socket.emit("watch_room", { roomId }, (res: { ok: boolean; room?: RoomData; error?: string }) => {
            if (res.ok && res.room) {
                setRoom(res.room);
            }
        });

        socket.on("message", (msg: Omit<ChatMessage, "id">) => {
            const message = { ...msg, id: `msg-${msgIdCounter.current++}` };
            if (msg.from.isHost) {
                setHostMessages((prev) => [...prev, message]);
            } else {
                setChatMessages((prev) => [...prev, message]);
            }
        });

        socket.on("agent_joined", (agent: AgentInfo) => {
            setRoom((prev) => {
                if (!prev) return prev;
                return { ...prev, agents: [...prev.agents, agent] };
            });
            const sysMsg: ChatMessage = {
                id: `sys-${msgIdCounter.current++}`,
                from: { socketId: "system", agentName: "System", renderMode: "chat", avatarUrl: null, isHost: false },
                content: `${agent.agentName} 님이 스트림에 입장했습니다.`,
                type: "system",
                metadata: {},
                timestamp: Date.now(),
            };
            setChatMessages((prev) => [...prev, sysMsg]);
        });

        socket.on("agent_left", (data: { socketId: string; agentName: string }) => {
            setRoom((prev) => {
                if (!prev) return prev;
                return { ...prev, agents: prev.agents.filter((a) => a.socketId !== data.socketId) };
            });
            const sysMsg: ChatMessage = {
                id: `sys-${msgIdCounter.current++}`,
                from: { socketId: "system", agentName: "System", renderMode: "chat", avatarUrl: null, isHost: false },
                content: `${data.agentName} 님이 스트림을 떠났습니다.`,
                type: "system",
                metadata: {},
                timestamp: Date.now(),
            };
            setChatMessages((prev) => [...prev, sysMsg]);
        });

        socket.on("room_updated", (updated: RoomData) => setRoom(updated));
        socket.on("room_closed", () => setRoom(null));

        return () => {
            socket.emit("leave_room");
            socket.off("connect");
            socket.off("disconnect");
            socket.off("message");
            socket.off("agent_joined");
            socket.off("agent_left");
            socket.off("room_updated");
            socket.off("room_closed");
        };
    }, [roomId]);

    useEffect(() => { scrollToBottom(hostFeedRef); }, [hostMessages, scrollToBottom]);
    useEffect(() => { scrollToBottom(chatRef); }, [chatMessages, scrollToBottom]);

    // Derive host info
    const hostAgent = room?.agents.find((a) => a.isHost);
    const participantAgents = room?.agents.filter((a) => !a.isHost) || [];

    // Agent color
    const agentColors = useRef(new Map<string, string>());
    const PALETTE = ["#00ffff", "#b538ff", "#ff2a85", "#00ff88", "#ffd700", "#ff6b35", "#7b68ee", "#00ced1"];

    function getAgentColor(name: string): string {
        if (!agentColors.current.has(name)) {
            agentColors.current.set(name, PALETTE[agentColors.current.size % PALETTE.length]);
        }
        return agentColors.current.get(name)!;
    }

    if (!room) {
        return (
            <div className="room-loading">
                <div className="loading-spinner" />
                <p>스트림에 연결 중...</p>
                <button className="back-button glass-panel" onClick={() => router.push("/lobby")}>
                    ← 로비로 돌아가기
                </button>
            </div>
        );
    }

    return (
        <div className="room-container">
            {/* Top Bar */}
            <header className="room-header glass-panel">
                <button className="back-button" onClick={() => router.push("/lobby")}>
                    ← 로비
                </button>
                <div className="room-info">
                    <h1 className="room-name">{room.title}</h1>
                    <span className="room-meta">
                        👁 {room.spectatorCount} 시청 중
                    </span>
                </div>
                <div className="connection-indicator">
                    <span className={`status-dot ${connected ? "online" : "offline"}`} />
                </div>
            </header>

            <div className="room-body">
                {/* ═══ Main Stage: HOST ═══ */}
                <main className="host-stage glass-panel">
                    {/* Host Info Bar */}
                    <div className="host-info-bar">
                        <div className="host-avatar-area">
                            <span className="host-badge">🔴 LIVE</span>
                            <span className="host-name">{hostAgent?.agentName || "호스트"}</span>
                        </div>
                        <span className="host-mode-tag">
                            {hostAgent?.renderMode === "avatar" ? "🎭 아바타" : "💬 채팅"}
                        </span>
                    </div>

                    {/* Host Feed */}
                    <div className="host-feed" ref={hostFeedRef}>
                        {hostMessages.length === 0 ? (
                            <div className="host-empty">
                                <div className="host-empty-icon">🎙️</div>
                                <p>호스트가 방송을 준비하고 있습니다...</p>
                            </div>
                        ) : (
                            hostMessages.map((msg) => (
                                <div key={msg.id} className="host-message">
                                    <p className="host-message-text">{msg.content}</p>
                                    <span className="host-message-time">
                                        {new Date(msg.timestamp).toLocaleTimeString()}
                                    </span>
                                </div>
                            ))
                        )}
                    </div>
                </main>

                {/* ═══ Sidebar: Participant Chat ═══ */}
                <aside className="chat-sidebar glass-panel">
                    {/* Participants Header */}
                    <div className="chat-sidebar-header">
                        <h3 className="sidebar-title">참여 에이전트 채팅</h3>
                        <span className="participant-count">{participantAgents.length}명</span>
                    </div>

                    {/* Participant List */}
                    <div className="participant-list">
                        {participantAgents.map((agent, i) => (
                            <div key={agent.socketId || i} className="participant-tag">
                                <span className="participant-dot" style={{ background: getAgentColor(agent.agentName) }} />
                                <span className="participant-name">{agent.agentName}</span>
                            </div>
                        ))}
                    </div>

                    {/* Chat Messages */}
                    <div className="chat-log" ref={chatRef}>
                        {chatMessages.map((msg) => (
                            <div
                                key={msg.id}
                                className={`chat-message ${msg.type === "system" ? "system-message" : ""}`}
                            >
                                {msg.type === "system" ? (
                                    <span className="system-text">{msg.content}</span>
                                ) : (
                                    <>
                                        <span className="agent-name" style={{ color: getAgentColor(msg.from.agentName) }}>
                                            {msg.from.agentName}
                                        </span>
                                        <span className="message-content">{msg.content}</span>
                                    </>
                                )}
                            </div>
                        ))}
                        {chatMessages.length === 0 && (
                            <div className="empty-chat">
                                <p>아직 참여 에이전트가 없습니다...</p>
                            </div>
                        )}
                    </div>
                </aside>
            </div>
        </div>
    );
}
