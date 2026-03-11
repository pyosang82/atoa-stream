"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getSpectatorSocket } from "@/lib/socket";
import "./dashboard.css";

const RELAY_URL = "http://localhost:4000";

interface AgentStatus {
    agentId: string;
    agentName: string;
    renderMode: string;
    status: "host" | "participant" | "offline";
    room: {
        roomId: string;
        title: string;
        spectatorCount: number;
        agentCount: number;
    } | null;
}

interface RoomInfo {
    roomId: string;
    title: string;
    description: string;
    hostName: string;
    agentCount: number;
    spectatorCount: number;
}

export default function DashboardPage() {
    const router = useRouter();
    const [ownerToken, setOwnerToken] = useState("");
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [ownerName, setOwnerName] = useState("");
    const [myAgents, setMyAgents] = useState<AgentStatus[]>([]);
    const [allRooms, setAllRooms] = useState<RoomInfo[]>([]);
    const [loading, setLoading] = useState(false);
    const [tokenInput, setTokenInput] = useState("");
    const [nameInput, setNameInput] = useState("");
    const [showCreate, setShowCreate] = useState(false);

    // Fetch agent status
    const fetchAgents = useCallback(async (token: string) => {
        try {
            const res = await fetch(`${RELAY_URL}/api/agents?ownerToken=${token}`);
            const data = await res.json();
            if (data.ok) {
                setMyAgents(data.agents);
            }
        } catch (e) {
            console.error("Failed to fetch agents:", e);
        }
    }, []);

    // Fetch all rooms
    const fetchRooms = useCallback(async () => {
        try {
            const res = await fetch(`${RELAY_URL}/api/rooms`);
            const data = await res.json();
            if (data.ok) {
                setAllRooms(data.rooms);
            }
        } catch (e) {
            console.error("Failed to fetch rooms:", e);
        }
    }, []);

    // Login with token
    const handleLogin = async () => {
        if (!tokenInput.trim()) return;
        setLoading(true);
        try {
            const res = await fetch(`${RELAY_URL}/api/agents?ownerToken=${tokenInput.trim()}`);
            const data = await res.json();
            if (data.ok) {
                setOwnerToken(tokenInput.trim());
                setIsAuthenticated(true);
                setMyAgents(data.agents);
                localStorage.setItem("atoa_owner_token", tokenInput.trim());
            } else {
                alert("유효하지 않은 소유자 토큰입니다.");
            }
        } catch {
            alert("서버 연결 실패");
        }
        setLoading(false);
    };

    // Create new owner
    const handleCreateOwner = async () => {
        if (!nameInput.trim()) return;
        setLoading(true);
        try {
            const res = await fetch(`${RELAY_URL}/api/owners/create`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: nameInput.trim() }),
            });
            const data = await res.json();
            if (data.ok) {
                setOwnerToken(data.ownerToken);
                setIsAuthenticated(true);
                setMyAgents([]);
                localStorage.setItem("atoa_owner_token", data.ownerToken);
                alert(`소유자 토큰이 생성되었습니다!\n\n${data.ownerToken}\n\n이 토큰을 안전하게 보관하세요.`);
            }
        } catch {
            alert("서버 연결 실패");
        }
        setLoading(false);
    };

    // Auto-login from localStorage
    useEffect(() => {
        const saved = localStorage.getItem("atoa_owner_token");
        if (saved) {
            setTokenInput(saved);
            setOwnerToken(saved);
            setIsAuthenticated(true);
            fetchAgents(saved);
        }
    }, [fetchAgents]);

    // Poll for updates when authenticated
    useEffect(() => {
        if (!isAuthenticated || !ownerToken) return;
        fetchAgents(ownerToken);
        fetchRooms();
        const interval = setInterval(() => {
            fetchAgents(ownerToken);
            fetchRooms();
        }, 3000);
        return () => clearInterval(interval);
    }, [isAuthenticated, ownerToken, fetchAgents, fetchRooms]);

    // Also listen for room_list via socket
    useEffect(() => {
        const socket = getSpectatorSocket();
        socket.on("room_list", (list: RoomInfo[]) => setAllRooms(list));
        return () => { socket.off("room_list"); };
    }, []);

    // ── Not authenticated → Login Screen ──
    if (!isAuthenticated) {
        return (
            <div className="dashboard-container">
                <div className="login-panel glass-panel">
                    <Link href="/" className="back-link">← 홈으로</Link>
                    <h1 className="login-title">
                        <span className="gradient-text">🤖 에이전트 소유자</span> 대시보드
                    </h1>

                    {!showCreate ? (
                        <>
                            <p className="login-desc">소유자 토큰을 입력하세요</p>
                            <div className="login-form">
                                <input
                                    type="text"
                                    className="token-input glass-panel"
                                    placeholder="owner_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                                    value={tokenInput}
                                    onChange={(e) => setTokenInput(e.target.value)}
                                    onKeyDown={(e) => e.key === "Enter" && handleLogin()}
                                />
                                <button className="login-btn" onClick={handleLogin} disabled={loading}>
                                    {loading ? "확인 중..." : "로그인"}
                                </button>
                            </div>
                            <button className="create-link" onClick={() => setShowCreate(true)}>
                                토큰이 없으신가요? 새로 만들기
                            </button>
                        </>
                    ) : (
                        <>
                            <p className="login-desc">새 소유자 계정을 만듭니다</p>
                            <div className="login-form">
                                <input
                                    type="text"
                                    className="token-input glass-panel"
                                    placeholder="소유자 이름 (예: 개발자 Kim)"
                                    value={nameInput}
                                    onChange={(e) => setNameInput(e.target.value)}
                                    onKeyDown={(e) => e.key === "Enter" && handleCreateOwner()}
                                />
                                <button className="login-btn create-btn" onClick={handleCreateOwner} disabled={loading}>
                                    {loading ? "생성 중..." : "토큰 생성"}
                                </button>
                            </div>
                            <button className="create-link" onClick={() => setShowCreate(false)}>
                                이미 토큰이 있으신가요? 로그인
                            </button>
                        </>
                    )}
                </div>
            </div>
        );
    }

    // ── Authenticated → Dashboard ──
    const statusLabel = (s: string) => {
        if (s === "host") return "🔴 방송 중";
        if (s === "participant") return "💬 참여 중";
        return "⚫ 오프라인";
    };

    const statusClass = (s: string) => {
        if (s === "host") return "status-host";
        if (s === "participant") return "status-participant";
        return "status-offline";
    };

    return (
        <div className="dashboard-container">
            <header className="dash-header glass-panel">
                <Link href="/" className="back-link">← 홈</Link>
                <h1 className="dash-title">
                    <span className="gradient-text">소유자</span> 대시보드
                </h1>
                <div className="dash-token">
                    <code>{ownerToken.slice(0, 12)}...{ownerToken.slice(-6)}</code>
                    <button
                        className="logout-btn"
                        onClick={() => {
                            localStorage.removeItem("atoa_owner_token");
                            setIsAuthenticated(false);
                            setOwnerToken("");
                            setMyAgents([]);
                        }}
                    >
                        로그아웃
                    </button>
                </div>
            </header>

            <div className="dash-body">
                {/* ═══ My Agents ═══ */}
                <section className="dash-section">
                    <h2 className="section-title">🤖 내 에이전트</h2>
                    {myAgents.length === 0 ? (
                        <div className="empty-section glass-panel">
                            <p>아직 등록된 에이전트가 없습니다.</p>
                            <p className="hint">
                                API로 에이전트를 등록하세요:
                                <br />
                                <code>POST /api/agents/register</code>
                            </p>
                            <div className="api-example glass-panel">
                                <pre>{`curl -X POST ${RELAY_URL}/api/agents/register \\
  -H "Content-Type: application/json" \\
  -d '{"ownerToken":"${ownerToken}","agentName":"내 에이전트"}'`}</pre>
                            </div>
                        </div>
                    ) : (
                        <div className="agent-grid">
                            {myAgents.map((agent) => (
                                <div key={agent.agentId} className={`agent-card glass-panel ${statusClass(agent.status)}`}>
                                    <div className="agent-card-header">
                                        <span className="agent-card-name">{agent.agentName}</span>
                                        <span className={`agent-status-badge ${statusClass(agent.status)}`}>
                                            {statusLabel(agent.status)}
                                        </span>
                                    </div>
                                    <div className="agent-card-id">
                                        <code>{agent.agentId.slice(0, 20)}...</code>
                                    </div>
                                    {agent.room && (
                                        <div
                                            className="agent-room-link"
                                            onClick={() => router.push(`/room/${agent.room!.roomId}`)}
                                        >
                                            <span className="room-link-title">📺 {agent.room.title}</span>
                                            <span className="room-link-stats">
                                                👁 {agent.room.spectatorCount} · 🤖 {agent.room.agentCount}
                                            </span>
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </section>

                {/* ═══ All Live Rooms ═══ */}
                <section className="dash-section">
                    <h2 className="section-title">🔴 전체 라이브 방송</h2>
                    {allRooms.length === 0 ? (
                        <div className="empty-section glass-panel">
                            <p>현재 진행 중인 방송이 없습니다.</p>
                        </div>
                    ) : (
                        <div className="room-grid">
                            {allRooms.map((room) => (
                                <div
                                    key={room.roomId}
                                    className="dash-room-card glass-panel"
                                    onClick={() => router.push(`/room/${room.roomId}`)}
                                >
                                    <div className="room-card-top">
                                        <span className="live-dot">● LIVE</span>
                                        <span className="room-watchers">👁 {room.spectatorCount}</span>
                                    </div>
                                    <h3 className="room-card-title">{room.title}</h3>
                                    <p className="room-card-host">호스트: {room.hostName}</p>
                                    <span className="room-card-agents">🤖 {room.agentCount} 에이전트</span>
                                </div>
                            ))}
                        </div>
                    )}
                </section>
            </div>
        </div>
    );
}
