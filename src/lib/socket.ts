"use client";

import { io, Socket } from "socket.io-client";

const RELAY_URL = process.env.NEXT_PUBLIC_RELAY_URL || "http://localhost:4000";

let spectatorSocket: Socket | null = null;

export function getSpectatorSocket(): Socket {
    if (!spectatorSocket) {
        spectatorSocket = io(`${RELAY_URL}/spectator`, {
            autoConnect: true,
            transports: ["websocket", "polling"],
        });
    }
    return spectatorSocket;
}
