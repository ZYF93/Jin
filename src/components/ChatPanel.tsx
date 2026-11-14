import { useEffect, useRef } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  Brain,
  CheckCircle2,
  GitPullRequest,
  MessageSquare,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  Square,
  Undo2,
  User,
  Wrench,
  XCircle,
} from "lucide-react";
import type { ChatMessage } from "../../shared/ipc";
import type { MessageKey } from "../../shared/i18n";
import { useT } from "../lib/i18n";
import { formatTime, isReviewing, nextOrdinal, ordinalLabel } from "../lib/utils";
import { isProviderConfigured } from "../../shared/provider";
import { useJin } from "../state/useJin";
import { ChatComposer } from "./ChatComposer";
import { MarkdownContent } from "./MarkdownContent";
import { Spinner } from "./ui";

function messageTone(message: ChatMessage): string {
  if (message.role === "system") return "border-transparent bg-transparent";
  if (message.kind === "error") return "border-rose-400/25 bg-rose-400/[0.055]";
  if (message.kind === "proposal") return "border-amber-300/20 bg-amber-300/[0.04]";
  if (message.kind === "implementation") return "border-emerald-400/20 bg-emerald-400/[0.04]";
  if (message.kind === "scan") return "border-[var(--border)] bg-[var(--panel-soft)]";
  if (message.role === "user") return "border-cyan-300/20 bg-[var(--accent-soft)]";
  return "border-[var(--border)] bg-[var(--panel-soft)]";
}

function MessageIcon({ message }: { message: ChatMessage }) {
  const cls = "h-[18px] w-[18px]";
  if (message.kind === "error") return <XCircle size={12} className="text-[var(--danger)]" />;
  if (message.kind === "proposal")
    return <GitPullRequest size={12} className="text-[var(--warning)]" />;
  if (message.kind === "implementation")
    return <CheckCircle2 size={12} className="text-[var(--success)]" />;
  if (message.kind === "scan") return <ScanSearch size={12} className="text-[var(--violet)]" />;
  if (message.role === "user") return <User size={12} className="text-[var(--accent)]" />;
  if (message.role === "assistant") return <Bot size={12} className="text-[var(--violet)]" />;
  return <Sparkles size={12} className={cls} />;
}

const ROLE_KEYS: Record<string, MessageKey> = {
  user: "role.user",
  assistant: "role.assistant",
  system: "role.system",
  tool: "role.tool",
};

function ChatBubble({ message }: { message: ChatMessage }) {
  const t = useT();
  const proposal = useJin((state) => state.app?.proposal ?? null);
  const setReviewOpen = useJin((state) => state.setReviewOpen);
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const current =
    proposal && message.proposalId && proposal.id === message.proposalId ? proposal : null;
  const busy = useJin((state) => state.busy);
  const undoImplementation = useJin((state) => state.undoImplementation);
  const undoAvailable = message.kind === "implementation" && !busy;

  if (isSystem) {
    return (
      <div className="fade-in flex items-start justify-center gap-1.5 px-4 py-1.5 text-center">
        <Sparkles size={10} className="mt-0.5 shrink-0 text-[var(--faint)]" />
        <p className="max-w-[90%] text-[9px] leading-relaxed text-[var(--faint)]">
          {message.content}
        </p>
      </div>
    );
  }

  return (
    <div className={`fade-in flex gap-2 ${isUser ? "flex-row-reverse" : ""}`}>
      <div
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-[var(--border)] ${
          isUser ? "bg-[var(--accent-soft)]" : "bg-[var(--panel-soft)]"
        }`}
      >
        <MessageIcon message={message} />
      </div>
      <div className={`min-w-0 max-w-[calc(100%-28px)] ${isUser ? "text-right" : ""}`}>
        <div className={`rounded-xl border px-2.5 py-2 text-left ${messageTone(message)}`}>
          {message.kind === "error" ? (
            <div className="mb-1 text-[9px] font-bold text-[var(--danger)]">
              {t("chat.requestFailed")}
            </div>
          ) : null}
          <MarkdownContent
            content={message.content}
            className="text-[10.5px] leading-relaxed text-[var(--muted)]"
          />
          {current && isReviewing(current) ? (
            <button
              className="btn btn-primary mt-2 h-7 w-full text-[9px]"
              onClick={() => setReviewOpen(true)}
            >
              <ShieldCheck size={11} />
              {t("chat.reviewDiff")}
              <ArrowRight size={10} className="ml-auto" />
            </button>
          ) : null}
          {message.details ? (
            <details className="message-details">
              <summary>{t("chat.details")}</summary>
              <pre>{message.details}</pre>
            </details>
          ) : null}
        </div>
        <div
          className={`mt-0.5 flex items-center gap-1.5 px-1 text-[8px] text-[var(--faint)] ${
            isUser ? "justify-end" : ""
          }`}
        >
          <span>{ROLE_KEYS[message.role] ? t(ROLE_KEYS[message.role]) : message.role}</span>
          <span>·</span>
          <span>{formatTime(message.createdAt)}</span>
          {message.proposalId && !current && isReviewing(proposal) === false ? (
            <span>· {t("chat.historical")}</span>
          ) : null}
          {undoAvailable ? (
            <button
              type="button"
              className="ml-1 inline-flex items-center gap-1 rounded-full border border-[var(--border)] px-1.5 py-0.5 text-[8px] text-[var(--faint)] transition-colors hover:text-[var(--text)]"
              onClick={() => void undoImplementation()}
              title={t("chat.undoHint")}
            >
              <Undo2 size={9} />
              {t("chat.undo")}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function StreamBubble() {
  const t = useT();
  const stream = useJin((state) => state.stream);
  if (!stream) return null;
  const activity = stream.activity.slice(-30);
  return (
    <div className="fade-in flex gap-2">
      <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--accent-soft)]">
        <Bot size={12} className="text-[var(--accent)]" />
      </div>
      <div className="min-w-0 max-w-[calc(100%-28px)] flex-1">
        <div className="rounded-xl border border-[var(--accent)]/25 bg-[var(--panel-soft)] px-2.5 py-2">
          <div className="flex items-center gap-1.5 text-[8px] font-semibold uppercase tracking-wide text-[var(--faint)]">
            {stream.phase === "thinking" ? (
              <Spinner size={8} className="text-[var(--accent)]" />
            ) : (
              <span className="status-dot success" />
            )}
            <span className="truncate">{stream.label}</span>
          </div>
          {activity.length > 0 ? (
            <div className="mt-2 max-h-32 space-y-1 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--panel)]/70 p-1.5">
              {activity.map((entry) => (
                <div
                  key={entry.id}
                  className="flex min-w-0 items-start gap-1.5 text-[9px] leading-snug"
                >
                  {entry.isError ? (
                    <AlertTriangle size={9} className="mt-0.5 shrink-0 text-[var(--danger)]" />
                  ) : (
                    <Wrench size={9} className="mt-0.5 shrink-0 text-[var(--accent)]" />
                  )}
                  <span
                    className={`shrink-0 font-semibold ${
                      entry.isError ? "text-[var(--danger)]" : "text-[var(--text)]"
                    }`}
                  >
                    {entry.tool}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono-ui text-[var(--faint)]">
                    {entry.detail}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {stream.reasoning ? (
            <details className="message-details mt-1.5" open={stream.phase === "thinking"}>
              <summary className="flex items-center gap-1.5 text-[9px] font-semibold text-[var(--faint)]">
                <Brain size={9} />
                {t("chat.thinking")}
              </summary>
              <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-[9.5px] italic leading-relaxed text-[var(--faint)]">
                {stream.reasoning}
              </pre>
            </details>
          ) : null}
          <div className="mt-1 break-words text-[10.5px] leading-relaxed text-[var(--muted)]">
            <MarkdownContent content={stream.content || t("chat.streamWaiting")} />
            <span className="stream-caret" aria-hidden="true" />
          </div>
        </div>
      </div>
    </div>
  );
}

function AgentActivity({ suppressError = false }: { suppressError?: boolean }) {
  const t = useT();
  const agent = useJin((state) => state.app?.agent);
  const cancelAgent = useJin((state) => state.cancelAgent);
  if (!agent || agent.phase === "idle" || (agent.phase === "error" && suppressError)) {
    return null;
  }
  const working =
    agent.phase === "planning" || agent.phase === "implementing" || agent.phase === "verifying";
  const flow = [
    {
      key: "approvalFlow.plan",
      done: agent.phase !== "planning",
      active: agent.phase === "planning",
    },
    {
      key: "approvalFlow.approval",
      done: agent.phase === "implementing" || agent.phase === "verifying",
      active: false,
    },
    {
      key: "approvalFlow.implementation",
      done: agent.phase === "verifying",
      active: agent.phase === "implementing",
    },
    { key: "approvalFlow.verification", done: false, active: agent.phase === "verifying" },
  ] as const;
  return (
    <div className="fade-in flex gap-2 px-1">
      <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--panel-soft)]">
        {agent.phase === "error" ? (
          <AlertTriangle size={12} className="text-[var(--danger)]" />
        ) : (
          <Spinner size={11} className="text-[var(--accent)]" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div
          className={`flex items-center gap-2 rounded-xl border px-2.5 py-2 ${
            agent.phase === "error"
              ? "border-rose-400/20 bg-rose-400/[0.05]"
              : "border-[var(--border)] bg-[var(--panel-soft)]"
          }`}
        >
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-semibold">
              {agent.phase === "planning"
                ? t("chat.planning")
                : agent.phase === "implementing"
                  ? t("chat.implementing")
                  : agent.phase === "verifying"
                    ? t("chat.verifying")
                    : t("chat.agentError")}
            </div>
            <div className="mt-0.5 truncate text-[9px] text-[var(--muted)]">{agent.message}</div>
          </div>
          {working ? (
            <button
              className="icon-btn h-6 w-6 shrink-0"
              onClick={() => void cancelAgent()}
              title={t("chat.cancelAgent")}
            >
              <Square size={10} />
            </button>
          ) : null}
        </div>
        {working ? (
          <ol className="mt-2 grid grid-cols-4 gap-1" aria-label={t("approvalFlow.title")}>
            {flow.map((step) => (
              <li
                key={step.key}
                className={`flex min-w-0 items-center gap-1 text-[7px] ${
                  step.done
                    ? "text-[var(--success)]"
                    : step.active
                      ? "font-semibold text-[var(--accent)]"
                      : "text-[var(--faint)]"
                }`}
              >
                {step.done ? (
                  <CheckCircle2 size={8} />
                ) : (
                  <span className="h-1 w-1 rounded-full bg-current" />
                )}
                <span className="truncate">{t(step.key)}</span>
              </li>
            ))}
          </ol>
        ) : null}
        {working ? (
          <div className="mt-1 flex items-center gap-1.5 px-1 text-[8px] text-[var(--faint)]">
            <span className="typing-dots">
              <span />
              <span />
              <span />
            </span>
            {t("chat.keepTurn")}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ChatPanel() {
  const t = useT();
  const app = useJin((state) => state.app);
  const busy = useJin((state) => state.busy);
  const sendMessage = useJin((state) => state.sendMessage);
  const openSettings = useJin((state) => state.openSettings);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const messages = app?.messages ?? [];
  const stream = useJin((state) => state.stream);
  const agent = app?.agent;
  const proposal = app?.proposal ?? null;
  const reviewing = isReviewing(proposal);
  const working =
    agent?.phase === "planning" || agent?.phase === "implementing" || agent?.phase === "verifying";
  const configured = isProviderConfigured(app?.settings.provider);
  const latestMessage = messages[messages.length - 1];
  const errorAlreadyShown =
    agent?.phase === "error" &&
    latestMessage?.kind === "error" &&
    latestMessage.content.includes(agent.message);
  const disabled = !app?.project || Boolean(busy) || working || reviewing || !configured;

  useEffect(() => {
    if (!stickToBottom.current) return;
    const timer = window.setTimeout(() => {
      const container = scrollRef.current;
      if (container) container.scrollTop = container.scrollHeight;
    }, 30);
    return () => window.clearTimeout(timer);
  }, [
    messages.length,
    agent?.phase,
    agent?.message,
    stream?.content.length,
    stream?.reasoning.length,
    stream?.activity.length,
    stream?.label,
  ]);

  const submit = (request: string, images?: string[]): void => {
    if ((!request && !images?.length) || disabled) return;
    stickToBottom.current = true;
    void sendMessage(request, images);
  };

  return (
    <aside className="glass flex w-[342px] shrink-0 flex-col overflow-hidden border-y-0 border-r-0 xl:w-[372px] max-[1080px]:w-[310px]">
      <div className="flex h-[39px] shrink-0 items-center gap-2 border-b border-[var(--border)] px-3">
        <MessageSquare size={13} className="text-[var(--violet)]" />
        <span className="text-[11px] font-bold">{t("chat.title")}</span>
        <span className="chip ml-auto h-[19px] gap-1 px-1.5 text-[8px]">
          {working ? (
            <Spinner size={8} />
          ) : (
            <span
              className={`status-dot ${agent?.phase === "error" ? "danger" : configured ? "success" : "warning"}`}
            />
          )}
          {working
            ? agent?.phase === "planning"
              ? t("chat.planning")
              : agent?.phase === "implementing"
                ? t("chat.implementing")
                : t("chat.verifying")
            : agent?.phase === "error"
              ? t("chat.error")
              : configured
                ? t("chat.agentReady")
                : t("chat.providerRequiredShort")}
        </span>
      </div>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-2.5 py-3"
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToBottom.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 48;
        }}
      >
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-3 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--accent-soft)] text-[var(--accent)]">
              <Sparkles size={20} />
            </div>
            <div className="mt-3 text-[11px] font-bold">{t("chat.emptyTitle")}</div>
            <p className="mt-1 max-w-[220px] text-[9.5px] leading-relaxed text-[var(--faint)]">
              {configured ? t("chat.emptyDetail") : t("chat.emptyDetailNoProvider")}
            </p>
          </div>
        ) : (
          messages.map((message) => <ChatBubble key={message.id} message={message} />)
        )}
        <StreamBubble />
        <AgentActivity suppressError={errorAlreadyShown} />
      </div>

      <div className="shrink-0 border-t border-[var(--border)] p-2.5">
        {reviewing ? (
          <div className="mb-2 flex items-start gap-1.5 rounded-lg border border-amber-300/20 bg-amber-300/[0.05] px-2 py-1.5 text-[8.5px] leading-relaxed text-[var(--muted)]">
            <ShieldCheck size={10} className="mt-0.5 shrink-0 text-[var(--warning)]" />
            {t("chat.reviewPrompt", {
              ordinal: ordinalLabel(nextOrdinal(app?.snapshot)),
            })}
          </div>
        ) : null}
        {!configured ? (
          <div className="mb-2 flex items-start gap-2 rounded-lg border border-amber-300/20 bg-amber-300/[0.05] px-2 py-1.5 text-[8.5px] leading-relaxed text-[var(--muted)]">
            <Sparkles size={10} className="mt-0.5 shrink-0 text-[var(--warning)]" />
            <span className="min-w-0 flex-1">{t("chat.providerRequired")}</span>
            <button
              className="btn h-6 shrink-0 px-2 text-[8px]"
              onClick={() => openSettings("provider")}
            >
              {t("chat.configureProvider")}
            </button>
          </div>
        ) : null}
        <ChatComposer disabled={disabled} reviewing={reviewing} working={working} onSend={submit} />
      </div>
    </aside>
  );
}
