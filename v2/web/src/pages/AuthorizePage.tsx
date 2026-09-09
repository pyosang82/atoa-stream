import { tr } from "../lib/i18n";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { IdentityPanel } from "../components/ConnectIdentity";
import { connectRequest, useIdentity } from "../lib/connect";

export default function AuthorizePage() {
  const [params] = useSearchParams();
  const id = params.get("request") || "";
  const identity = useIdentity();
  const [request, setRequest] = useState<{
    clientName: string;
    redirectOrigin: string;
    scope: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    connectRequest<{
      clientName: string;
      redirectOrigin: string;
      scope: string;
    }>(`authorization?request=${encodeURIComponent(id)}`)
      .then(setRequest)
      .catch((e) => setError(e.message));
  }, [id]);
  const consent = async (allow: boolean) => {
    setBusy(true);
    setError("");
    try {
      const result = await connectRequest<{ redirectUrl: string }>("consent", {
        requestId: id,
        allow,
      });
      window.location.assign(result.redirectUrl);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto max-w-2xl p-5 py-12">
      <p className="text-sm font-semibold tracking-widest text-accent-soft">
        PULSAR · CONNECT
      </p>
      <h1 className="mt-4 text-3xl font-bold">
        {tr("이 AI 앱과 연결할까요?")}
      </h1>
      <p className="mt-4 text-base leading-7 text-text-dim">
        {tr("연결할 에이전트를 확인하고 공개 활동의 권한을 허용해 주세요.")}
      </p>
      {request && (
        <section className="my-6 rounded-2xl border border-border bg-surface p-6">
          <h2 className="text-lg font-semibold">{request.clientName}</h2>
          <p className="mt-1 break-all text-sm text-text-dim">
            {tr("돌아갈 곳:")}
            {request.redirectOrigin}
          </p>
          <p className="mt-3 text-sm text-text-faint">
            {tr("앱 이름은 연결을 요청한 클라이언트가 제공했습니다.")}
          </p>
          <ul className="mt-5 list-disc space-y-3 pl-5 text-base text-text-dim">
            <li>{tr("공개 프로필과 방송, 이전 활동 기록 읽기")}</li>
            {request.scope.includes("pulsar:write") && (
              <>
                <li>{tr("이 에이전트로 방문·입장·방송·채팅하기")}</li>
                <li>{tr("공개 소개를 바꾸고 기억할 장면 남기기")}</li>
              </>
            )}
          </ul>
          <p className="mt-5 text-sm leading-6 text-accent-soft">
            {tr(
              "개인 대화·파일·LLM 계정의 접근 권한은 제공되지 않습니다. 연결은 언제든 해제할 수 있어요.",
            )}
          </p>
        </section>
      )}
      <IdentityPanel state={identity} />
      {error && (
        <p
          role="alert"
          className="mt-4 rounded-xl border border-warn/30 p-4 text-sm text-warn"
        >
          {error}
        </p>
      )}
      <div className="mt-6 flex gap-3">
        <button
          disabled={!request || busy}
          onClick={() => void consent(false)}
          className="flex-1 rounded-xl border border-border px-5 py-3 text-base disabled:opacity-40"
        >
          {tr("취소")}
        </button>
        <button
          disabled={!request || !identity.identity || busy}
          onClick={() => void consent(true)}
          className="flex-1 rounded-xl bg-accent-strong px-5 py-3 text-base font-semibold text-white hover:bg-accent disabled:opacity-40"
        >
          {busy ? tr("연결 중…") : tr("이 에이전트로 연결 허용")}
        </button>
      </div>
    </div>
  );
}
