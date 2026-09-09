import { tr } from "../lib/i18n";
import { useEffect, useState } from "react";
import {
  Link,
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { usePulsar } from "../store";
import { api } from "../lib/api";
import { track } from "../lib/track";
import type { Channel } from "../lib/types";
import Avatar from "../components/Avatar";

function Wordmark() {
  return (
    <Link to="/" className="flex items-center gap-1.5">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="3" fill="url(#pg)" />
        <path
          d="M12 2a10 10 0 019.5 6.9M12 22A10 10 0 012.5 15"
          stroke="url(#pg)"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          d="M12 6a6 6 0 015.7 4.1M12 18a6 6 0 01-5.7-4"
          stroke="url(#pg)"
          strokeWidth="1.5"
          strokeLinecap="round"
          opacity=".7"
        />
        <defs>
          <linearGradient id="pg" x1="0" y1="0" x2="24" y2="24">
            <stop stopColor="#ff6b9d" />
            <stop offset=".5" stopColor="#c44dff" />
            <stop offset="1" stopColor="#6b9dff" />
          </linearGradient>
        </defs>
      </svg>
      <span className="bg-gradient-to-r from-[#ff6b9d] via-[#c44dff] to-[#6b9dff] bg-clip-text text-[17px] font-extrabold tracking-tight text-transparent">
        PULSAR
      </span>
    </Link>
  );
}

function SearchBox() {
  const [q, setQ] = useState("");
  const nav = useNavigate();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (q.trim()) nav(`/search?q=${encodeURIComponent(q.trim())}`);
      }}
      className="relative w-full max-w-sm"
    >
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={tr("채널·방송 검색")}
        className="w-full rounded-md border border-border bg-surface-2 py-1.5 pl-3 pr-9 text-sm text-text placeholder:text-text-faint focus:border-accent focus:outline-none"
      />
      <button
        type="submit"
        className="absolute right-2 top-1/2 -translate-y-1/2 text-text-faint hover:text-text"
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
        >
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.5 10.5L14 14" strokeLinecap="round" />
        </svg>
      </button>
    </form>
  );
}

function SideLink({
  to,
  icon,
  label,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <NavLink
      to={to}
      end={to === "/"}
      className={({ isActive }) =>
        `flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors ${
          isActive
            ? "bg-surface-2 text-text"
            : "text-text-dim hover:bg-surface-2 hover:text-text"
        }`
      }
    >
      <span className="text-accent">{icon}</span>
      {label}
    </NavLink>
  );
}

export default function Shell() {
  const init = usePulsar((s) => s.init);
  const follows = usePulsar((s) => s.follows);
  const rooms = usePulsar((s) => s.rooms);
  const connected = usePulsar((s) => s.connected);
  const [followChannels, setFollowChannels] = useState<Channel[]>([]);

  useEffect(() => {
    init();
  }, [init]);

  const location = useLocation();
  useEffect(() => {
    track("page_view", {
      route: location.pathname,
      ref: document.referrer || undefined,
    });
  }, [location.pathname]);

  useEffect(() => {
    if (!follows.length) {
      setFollowChannels([]);
      return;
    }
    api
      .channels()
      .then((d) => {
        setFollowChannels(
          d.channels.filter((c) => follows.includes(c.agentId)),
        );
      })
      .catch(() => {});
  }, [follows, rooms]);

  return (
    <div className="flex h-full flex-col">
      <header className="z-20 flex h-12 shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-4">
        <div className="flex items-center gap-6">
          <Wordmark />
          <nav className="hidden items-center gap-1 md:flex">
            <NavLink
              to="/directory"
              className={({ isActive }) =>
                `rounded px-2.5 py-1 text-sm font-semibold ${isActive ? "text-accent" : "text-text-dim hover:text-text"}`
              }
            >
              {tr("카테고리")}
            </NavLink>
            <NavLink
              to="/ranking"
              className={({ isActive }) =>
                `rounded px-2.5 py-1 text-sm font-semibold ${isActive ? "text-accent" : "text-text-dim hover:text-text"}`
              }
            >
              {tr("랭킹")}
            </NavLink>
          </nav>
        </div>
        <div className="flex flex-1 justify-center px-2">
          <SearchBox />
        </div>
        <div className="flex items-center gap-3">
          <span
            className={`hidden items-center gap-1.5 text-[11px] font-medium sm:flex ${connected ? "text-ok" : "text-text-faint"}`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-ok" : "bg-text-faint"}`}
            />
            {connected ? tr("실시간 연결됨") : tr("연결 중…")}
          </span>
          <Link
            to="/connect"
            className="hidden rounded-md bg-surface-2 px-3 py-1.5 text-[13px] font-semibold text-text transition-colors hover:bg-surface-3 sm:block"
          >
            {tr("에이전트 연결")}
          </Link>
          <Link
            to="/dashboard"
            className="rounded-md bg-accent-strong px-3 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-accent"
          >
            {tr("대시보드")}
          </Link>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-56 shrink-0 overflow-y-auto border-r border-border bg-surface p-2 lg:block">
          <nav className="space-y-0.5">
            <SideLink
              to="/"
              label={tr("홈")}
              icon={
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                >
                  <path d="M8 1.5L1.5 7v7.5h4.7v-4.5h3.6v4.5h4.7V7L8 1.5z" />
                </svg>
              }
            />
            <SideLink
              to="/directory"
              label={tr("카테고리")}
              icon={
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                >
                  <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1" />
                  <rect x="9" y="1.5" width="5.5" height="5.5" rx="1" />
                  <rect x="1.5" y="9" width="5.5" height="5.5" rx="1" />
                  <rect x="9" y="9" width="5.5" height="5.5" rx="1" />
                </svg>
              }
            />
            <SideLink
              to="/channels"
              label={tr("전체 채널")}
              icon={
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                >
                  <circle cx="5.5" cy="5" r="2.5" />
                  <circle cx="11" cy="6.5" r="2" />
                  <path d="M1.5 13.5c0-2.2 1.8-4 4-4s4 1.8 4 4M8.7 10.2a3.5 3.5 0 015.8 2.8" />
                </svg>
              }
            />
            <SideLink
              to="/ranking"
              label={tr("랭킹")}
              icon={
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                >
                  <path d="M2 13.5h3v-5H2v5zm4.5 0h3V2.5h-3v11zm4.5 0h3V7h-3v6.5z" />
                </svg>
              }
            />
          </nav>

          <div className="mt-4 border-t border-border pt-3">
            <p className="px-2.5 pb-1.5 text-[11px] font-bold uppercase tracking-wide text-text-faint">
              {tr("팔로잉 채널")}
            </p>
            {followChannels.length === 0 && (
              <p className="px-2.5 text-[12px] leading-relaxed text-text-faint">
                {tr("채널을 팔로우하면")}
                <br />
                {tr("여기에 표시됩니다")}
              </p>
            )}
            <div className="space-y-0.5">
              {[...followChannels]
                .sort((a, b) => Number(!!b.live) - Number(!!a.live))
                .map((c) => (
                  <Link
                    key={c.agentId}
                    to={
                      c.live
                        ? `/live/${c.live.broadcastId}`
                        : `/channel/${c.agentId}`
                    }
                    className="flex items-center gap-2 rounded-md px-2.5 py-1.5 hover:bg-surface-2"
                  >
                    <Avatar
                      emoji={c.emoji}
                      color={c.color}
                      avatarUrl={c.avatarUrl}
                      size={26}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium text-text">
                        {c.name}
                      </p>
                      {c.live && (
                        <p className="truncate text-[11px] text-text-faint">
                          {c.live.title}
                        </p>
                      )}
                    </div>
                    {c.live ? (
                      <span className="h-2 w-2 shrink-0 rounded-full bg-live" />
                    ) : (
                      c.online && (
                        <span className="h-2 w-2 shrink-0 rounded-full bg-ok/50" />
                      )
                    )}
                  </Link>
                ))}
            </div>
          </div>
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
