import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  CheckCircle2,
  CornerDownLeft,
  GitPullRequest,
  MessageSquare,
  ScanSearch,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
  User,
  XCircle,
} from "lucide-react";
import type { ChatMessage } from "../../shared/ipc";
import {
  formatTime,
  isReviewing,
  nextOrdinal,
  ordinalLabel,
} from "../lib/utils";
import { useJin } from "../state/useJin";
import { Spinner } from "./ui";

function messageTone(message: ChatMessage): string {
  if (message.role === "system") return "border-transparent bg-transparent";
  if (message.kind === "error") return "border-rose-400/25 bg-rose-400/[0.055]";
  if (message.kind === "proposal") return "border-amber-300/20 bg-amber-300/[0.04]";
  if (message.kind === "implementation")
    return "border-emerald-400/20 bg-emerald-400/[0.04]";
  if (message.kind === "scan") return "border-[var(--border)] bg-[var(--panel-soft)]";
  if (message.role === "user")
    return "border-cyan-300/20 bg-[var(--accent-soft)]";
  return "border-[var(--border)] bg-[var(--panel-soft)]";
}

function MessageIcon({ message }: { message: ChatMessage }) {
  const cls = "h-[18px] w-[18px]";
  if (message.kind === "error") return <XCircle size={12} className="text-[var(--danger)]" />;
  if (message.kind === "proposal")
    return <GitPullRequest size={12} className="text-[var(--warning)]" />;
  if (message.kind === "implementation")
    return <CheckCircle2 size={12} className="text-[var(--success)]" />;
  if (message.kind === "scan")
    return <ScanSearch size={12} className="text-[var(--violet)]" />;
  if (message.role === "user") return <User size={12} className="text-[var(--accent)]" />;
  if (message.role === "assistant") return <Bot size={12} className="text-[var(--violet)]" />;
  return <Sparkles size={12} className={cls} />;
}

function ChatBubble({ message }: { message: ChatMessage }) {
  const proposal = useJin((state) => state.app?.proposal ?? null);
  const setReviewOpen = useJin((state) => state.setReviewOpen);
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const current =
    proposal && message.proposalId && proposal.id === message.proposalId
      ? proposal
      : null;

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
        <div
          className={`rounded-xl border px-2.5 py-2 text-left ${messageTone(message)}`}
        >
          <div className="message-prose text-[10.5px] leading-relaxed text-[var(--muted)]">
            {message.content}
          </div>
          {current && isReviewing(current) ? (
            <button
              className="btn btn-primary mt-2 h-7 w-full text-[9px]"
              onClick={() => setReviewOpen(true)}
            >
              <ShieldCheck size={11} />
              Review architecture diff
              <ArrowRight size={10} className="ml-auto" />
            </button>
          ) : null}
          {message.details ? (
            <details className="message-details">
              <summary>Implementation & verification details</summary>
              <pre>{message.details}</pre>
            </details>
          ) : null}
        </div>
        <div
          className={`mt-0.5 flex items-center gap-1.5 px-1 text-[8px] text-[var(--faint)] ${
            isUser ? "justify-end" : ""
          }`}
        >
          <span>{message.role}</span>
          <span>·</span>
          <span>{formatTime(message.createdAt)}</span>
          {message.proposalId && !current && isReviewing(proposal) === false ? (
            <span>· historical</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function AgentActivity() {
  const agent = useJin((state) => state.app?.agent);
  const cancelAgent = useJin((state) => state.cancelAgent);
  if (!agent || agent.phase === "idle") return null;
  const working =
    agent.phase === "planning" ||
    agent.phase === "implementing" ||
    agent.phase === "verifying";
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
                ? "Planning the turn"
                : agent.phase === "implementing"
                  ? "Implementing approved architecture"
                  : agent.phase === "verifying"
                    ? "Verifying conformance"
                    : "Agent error"}
            </div>
            <div className="mt-0.5 truncate text-[9px] text-[var(--muted)]">
              {agent.message}
            </div>
          </div>
          {working ? (
            <button
              className="icon-btn h-6 w-6 shrink-0"
              onClick={() => void cancelAgent()}
              title="Cancel agent"
            >
              <Square size={10} />
            </button>
          ) : null}
        </div>
        {working ? (
          <div className="mt-1 flex items-center gap-1.5 px-1 text-[8px] text-[var(--faint)]">
            <span className="typing-dots">
              <span />
              <span />
              <span />
            </span>
            The architecture, code, and verification stay in one turn.
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ChatPanel() {
  const app = useJin((state) => state.app);
  const busy = useJin((state) => state.busy);
  const sendMessage = useJin((state) => state.sendMessage);
  const [text, setText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const messages = app?.messages ?? [];
  const agent = app?.agent;
  const proposal = app?.proposal ?? null;
  const reviewing = isReviewing(proposal);
  const working =
    agent?.phase === "planning" ||
    agent?.phase === "implementing" ||
    agent?.phase === "verifying";
  const configured =
    app?.settings.provider.kind === "ollama" ||
    (app?.settings.provider.kind === "openai-compatible" &&
      app.settings.provider.hasApiKey);
  const disabled = !app?.project || Boolean(busy) || working || reviewing;

  useEffect(() => {
    if (!stickToBottom.current) return;
    const timer = window.setTimeout(() => {
      const container = scrollRef.current;
      if (container) container.scrollTop = container.scrollHeight;
    }, 30);
    return () => window.clearTimeout(timer);
  }, [messages.length, agent?.phase, agent?.message]);

  const submit = (): void => {
    const request = text.trim();
    if (!request || disabled) return;
    setText("");
    stickToBottom.current = true;
    void sendMessage(request);
  };

  return (
    <aside className="glass flex w-[342px] shrink-0 flex-col overflow-hidden border-y-0 border-r-0 xl:w-[372px] max-[1080px]:w-[310px]">
      <div className="flex h-[39px] shrink-0 items-center gap-2 border-b border-[var(--border)] px-3">
        <MessageSquare size={13} className="text-[var(--violet)]" />
        <span className="text-[11px] font-bold">Chat</span>
        <span className="chip ml-auto h-[19px] gap-1 px-1.5 text-[8px]">
          {working ? (
            <Spinner size={8} />
          ) : (
            <span
              className={`status-dot ${agent?.phase === "error" ? "danger" : configured ? "success" : "warning"}`}
            />
          )}
          {working
            ? agent?.phase
            : agent?.phase === "error"
              ? "error"
              : configured
                ? "agent ready"
                : "local planner"}
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
            <div className="mt-3 text-[11px] font-bold">Architecture is the interface</div>
            <p className="mt-1 max-w-[220px] text-[9.5px] leading-relaxed text-[var(--faint)]">
              Ask for a change. Jin proposes Intent and architecture first; approval unlocks code.
            </p>
          </div>
        ) : (
          messages.map((message) => <ChatBubble key={message.id} message={message} />)
        )}
        <AgentActivity />
      </div>

      <div className="shrink-0 border-t border-[var(--border)] p-2.5">
        {reviewing ? (
          <div className="mb-2 flex items-start gap-1.5 rounded-lg border border-amber-300/20 bg-amber-300/[0.05] px-2 py-1.5 text-[8.5px] leading-relaxed text-[var(--muted)]">
            <ShieldCheck size={10} className="mt-0.5 shrink-0 text-[var(--warning)]" />
            Approve or reject {ordinalLabel(nextOrdinal(app?.snapshot))} before starting another
            turn.
          </div>
        ) : null}
        {!configured ? (
          <div className="mb-2 flex items-start gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--panel-soft)] px-2 py-1.5 text-[8.5px] leading-relaxed text-[var(--faint)]">
            <Sparkles size={10} className="mt-0.5 shrink-0 text-[var(--warning)]" />
            Local planning is active. Configure an AI provider in Settings for code implementation.
          </div>
        ) : null}
        <div
          className={`rounded-xl border bg-[var(--control)] p-1.5 transition-colors ${
            disabled
              ? "border-[var(--border)] opacity-65"
              : "border-[var(--border)] focus-within:border-cyan-300/40"
          }`}
        >
          <textarea
            className="max-h-[150px] min-h-[54px] w-full resize-none border-0 bg-transparent px-1.5 py-1 text-[10.5px] leading-relaxed text-[var(--text)] outline-none placeholder:text-[var(--faint)]"
            placeholder={
              reviewing
                ? "Resolve the current architecture review first…"
                : working
                  ? "Jin is working…"
                  : app?.project
                    ? "Describe an Intent, change, or refactor…"
                    : "Open a project first…"
            }
            value={text}
            disabled={disabled}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <div className="flex items-center gap-1.5 px-1 pt-0.5">
            <CornerDownLeft size={9} className="text-[var(--faint)]" />
            <span className="text-[8px] text-[var(--faint)]">Enter to send · Shift+Enter newline</span>
            <button
              className="btn btn-primary ml-auto h-7 w-7 p-0"
              disabled={disabled || !text.trim()}
              onClick={submit}
              title="Send"
              aria-label="Send message"
            >
              {busy === "Thinking…" ? <Spinner size={12} /> : <Send size={12} />}
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
