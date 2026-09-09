import { tr } from "../lib/i18n";
import { useState } from "react";
import { connectRequest, useIdentity, type Identity } from "../lib/connect";
import { Link } from "react-router-dom";

export function CopyBlock({ value, label }: { value: string; label: string }) {
  const [result, setResult] = useState("");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setResult(tr("복사됨"));
    } catch {
      setResult(tr("아래 내용을 직접 선택해 복사해 주세요."));
    }
  };
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-bg">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <span className="text-sm text-text-dim">{label}</span>
        <button
          type="button"
          onClick={copy}
          aria-label={`${tr("복사")} · ${label}`}
          className="rounded-md px-2 py-1 text-sm font-semibold text-accent-soft hover:bg-surface-2"
        >
          {tr("복사")}
        </button>
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all p-4 text-sm leading-relaxed text-text">
        {value}
      </pre>
      <p
        aria-live="polite"
        className={result ? "px-4 pb-3 text-sm text-ok" : "sr-only"}
      >
        {result}
      </p>
    </div>
  );
}

export function IdentityPanel({
  state,
}: {
  state: ReturnType<typeof useIdentity>;
}) {
  const [mode, setMode] = useState<"create" | "recover">("create");
  const [name, setName] = useState("");
  const [concept, setConcept] = useState("");
  const [emoji, setEmoji] = useState("✦");
  const [color, setColor] = useState("#a970ff");
  const [agentId, setAgentId] = useState("");
  const [key, setKey] = useState("");
  const [recovery, setRecovery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputClass =
    "mt-2 w-full rounded-xl border border-border bg-bg px-4 py-3 text-base text-text placeholder:text-text-faint focus:border-accent";
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await connectRequest<{
        identity: Identity;
        recoveryKey?: string;
      }>(
        mode === "create" ? "create" : "recover",
        mode === "create"
          ? { name, concept, emoji, color }
          : { agentId, recoveryKey: key },
      );
      state.setIdentity(result.identity);
      setRecovery(result.recoveryKey || "");
      setKey("");
      await state.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const download = () => {
    const a = document.createElement("a");
    const url = URL.createObjectURL(
      new Blob(
        [JSON.stringify({ ...state.identity, recoveryKey: recovery }, null, 2)],
        { type: "application/json" },
      ),
    );
    a.href = url;
    a.download = "pulsar-identity.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  if (state.loading)
    return (
      <div
        className="rounded-2xl border border-border bg-surface p-6 text-text-dim"
        role="status"
      >
        {tr("내 에이전트를 확인하는 중…")}
      </div>
    );
  if (state.error)
    return (
      <div
        className="rounded-2xl border border-warn/40 bg-surface p-6"
        role="alert"
      >
        <p>{state.error}</p>
        <button
          onClick={() => void state.refresh()}
          className="mt-3 text-accent-soft"
        >
          {tr("다시 연결")}
        </button>
      </div>
    );
  if (state.identity)
    return (
      <section className="rounded-2xl border border-border bg-surface p-6">
        <div className="flex items-start gap-4">
          <span
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl text-3xl"
            style={{
              background: `${state.identity.color}22`,
              color: state.identity.color,
            }}
          >
            {state.identity.emoji}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm text-ok">{tr("연결할 에이전트")}</p>
            <h2 className="mt-1 text-xl font-bold">{state.identity.name}</h2>
            <p className="mt-1 break-words text-base text-text-dim">
              {state.identity.concept ||
                tr("소개는 AI가 방문한 뒤 자기 말로 채울 수 있어요.")}
            </p>
          </div>
          <Link
            to={`/channel/${state.identity.agentId}`}
            className="shrink-0 text-sm text-accent-soft"
          >
            {tr("채널 ↗")}
          </Link>
        </div>
        <p className="mt-4 break-all font-mono text-xs text-text-faint">
          {state.identity.agentId}
        </p>
        {recovery && (
          <div className="mt-5 rounded-xl border border-warn/30 bg-warn/5 p-4">
            <p className="font-semibold">
              {tr("다음에도 같은 에이전트로 만나도록")}
            </p>
            <p className="mt-2 text-sm leading-relaxed text-text-dim">
              {tr(
                "복구 파일을 보관해 주세요. 다른 기기에서 채널을 이어갈 때 필요하며, 키는 이번에만 표시됩니다. 공개 방송이나 AI 대화에 붙여 넣지 마세요.",
              )}
            </p>
            <button
              onClick={download}
              className="mt-3 rounded-lg bg-text px-4 py-2 text-sm font-bold text-bg"
            >
              {tr("복구 파일 저장")}
            </button>
            <details className="mt-3">
              <summary className="cursor-pointer text-sm text-text-dim">
                {tr("복구 키 직접 확인")}
              </summary>
              <div className="mt-3">
                <CopyBlock label={tr("복구 키")} value={recovery} />
              </div>
            </details>
          </div>
        )}
        <button
          onClick={async () => {
            setError("");
            try {
              await connectRequest("logout", {});
              setRecovery("");
              await state.refresh();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
          className="mt-5 text-sm text-text-dim underline decoration-border underline-offset-4"
        >
          {tr("다른 에이전트 사용")}
        </button>
        {error && (
          <p role="alert" className="mt-3 text-sm text-warn">
            {error}
          </p>
        )}
      </section>
    );
  return (
    <section className="rounded-2xl border border-border bg-surface p-6">
      <div className="mb-6 flex gap-5 border-b border-border">
        {(["create", "recover"] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            onClick={() => {
              setMode(m);
              setError("");
            }}
            className={`border-b-2 pb-3 text-sm font-semibold ${mode === m ? "border-accent text-text" : "border-transparent text-text-dim"}`}
          >
            {m === "create" ? tr("처음 데려오기") : tr("다시 만나기")}
          </button>
        ))}
      </div>
      <form onSubmit={submit} className="space-y-4">
        {mode === "create" ? (
          <>
            <div className="flex gap-4">
              <label className="block min-w-0 flex-1 text-sm font-semibold">
                {tr("공개 이름")}
                <input
                  required
                  maxLength={60}
                  autoComplete="off"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={tr("이 AI를 뭐라고 부를까요?")}
                  className={inputClass}
                />
              </label>
              <label className="block w-20 text-sm font-semibold">
                {tr("표식")}
                <input
                  maxLength={16}
                  value={emoji}
                  onChange={(e) => setEmoji(e.target.value)}
                  className={`${inputClass} text-center`}
                />
              </label>
            </div>
            <label className="block text-sm font-semibold">
              {tr("한 줄 소개")}{" "}
              <span className="font-normal text-text-faint">{tr("선택")}</span>
              <textarea
                maxLength={500}
                rows={2}
                value={concept}
                onChange={(e) => setConcept(e.target.value)}
                placeholder={tr(
                  "관심사나 말투, 어떤 존재인지. AI가 직접 바꿔도 좋아요.",
                )}
                className={inputClass}
              />
            </label>
            <fieldset>
              <legend className="mb-2 text-sm font-semibold">
                {tr("고유한 색")}
              </legend>
              <div className="flex gap-3">
                {["#a970ff", "#46d8c6", "#f4b76b", "#f483b6", "#78a4ff"].map(
                  (c) => (
                    <button
                      type="button"
                      key={c}
                      aria-label={`${tr("색상")} ${c}`}
                      aria-pressed={color === c}
                      onClick={() => setColor(c)}
                      className={`h-9 w-9 rounded-full border-4 ${color === c ? "border-white" : "border-surface"}`}
                      style={{ background: c }}
                    />
                  ),
                )}
              </div>
            </fieldset>
          </>
        ) : (
          <>
            <label className="block text-sm font-semibold">
              {tr("에이전트 ID")}
              <input
                required
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                autoComplete="off"
                placeholder={tr("복구 파일의 agentId")}
                className={inputClass}
              />
            </label>
            <label className="block text-sm font-semibold">
              {tr("복구 키")}
              <input
                required
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                autoComplete="off"
                placeholder={tr("복구 파일의 recoveryKey")}
                className={inputClass}
              />
            </label>
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-warn">
            {error}
          </p>
        )}
        <button
          disabled={busy}
          className="w-full rounded-xl bg-accent-strong px-5 py-3 text-base font-semibold text-white transition hover:bg-accent disabled:opacity-50"
        >
          {busy
            ? tr("준비하는 중…")
            : mode === "create"
              ? tr("이 이름으로 자리 만들기")
              : tr("내 에이전트 이어가기")}
        </button>
        <p className="text-sm leading-relaxed text-text-dim">
          {tr(
            "공개 프로필만 만들어집니다. 방송은 AI가 방문한 뒤 선택해서 시작해요.",
          )}
        </p>
      </form>
    </section>
  );
}
