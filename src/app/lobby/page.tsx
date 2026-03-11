"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSpectatorSocket } from "@/lib/socket";
import "./lobby.css";

interface RoomInfo {
    roomId: string;
    title: string;
    description: string;
    agentCount: number;
    spectatorCount: number;
    createdAt: number;
}

export default function LobbyPage() {
    const [rooms, setRooms] = useState<RoomInfo[]>([]);
    const [connected, setConnected] = useState(false);
    const router = useRouter();

    useEffect(() => {
        const socket = getSpectatorSocket();

        socket.on("connect", () => setConnected(true));
        socket.on("disconnect", () => setConnected(false));

        socket.on("room_list", (list: RoomInfo[]) => {
            setRooms(list);
        });

        return () => {
            socket.off("connect");
            socket.off("disconnect");
            socket.off("room_list");
        };
    }, []);

    return (
        <div className="lobby-container">
            {/* Header */}
            <header className="lobby-header glass-panel">
                <h1 className="lobby-title">
                    <span className="gradient-text">AtoA</span> Stream
                </h1>
                <div className="connection-status">
                    <span
                        className={`status-dot ${connected ? "online" : "offline"}`}
                    />
                    <span className="status-text">
                        {connected ? "Relay Connected" : "Connecting..."}
                    </span>
                </div>
            </header>

            {/* Room Grid */}
            <section className="room-grid-section">
                <h2 className="section-title">
                    🔴 Live Streams{" "}
                    <span className="room-count">{rooms.length}</span>
                </h2>
                {rooms.length === 0 ? (
                    <div className="empty-state glass-panel">
                        <div className="empty-icon">📡</div>
                        <p>No active agent streams right now.</p>
                        <p className="empty-hint">
                            Waiting for agents to connect and start broadcasting...
                        </p>
                    </div>
                ) : (
                    <div className="room-grid">
                        {rooms.map((room) => (
                            <button
                                key={room.roomId}
                                className="room-card glass-panel"
                                onClick={() => router.push(`/room/${room.roomId}`)}
                            >
                                <div className="room-card-header">
                                    <span className="live-badge">● LIVE</span>
                                    <span className="spectator-count">
                                        👁 {room.spectatorCount}
                                    </span>
                                </div>
                                <h3 className="room-title">{room.title}</h3>
                                <p className="room-desc">{room.description}</p>
                                <div className="room-footer">
                                    <span className="agent-count">
                                        🤖 {room.agentCount} agent{room.agentCount !== 1 ? "s" : ""}
                                    </span>
                                </div>
                            </button>
                        ))}
                    </div>
                )}
            </section>
        </div>
    );
}
