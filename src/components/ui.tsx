import { useEffect, type ReactNode } from "react";
import clsx from "clsx";
import { Loader2, X } from "lucide-react";
import { useT } from "../lib/i18n";
import { useJin } from "../state/useJin";

export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      aria-label="Jin"
      role="img"
      className="shrink-0"
    >
      <rect width="64" height="64" rx="15" fill="var(--panel-solid)" />
      <rect
        x="0.75"
        y="0.75"
        width="62.5"
        height="62.5"
        rx="14.25"
        stroke="var(--border-strong)"
        strokeWidth="1.5"
      />
      <path
        d="M32 7L54 20V44L32 57L10 44V20L32 7Z"
        stroke="#6BCFE0"
        strokeWidth="2.4"
        strokeLinejoin="round"
        opacity=".68"
      />
      <path
        d="M32 30V16M28 35L17 42M36 35L47 42"
        stroke="#83E5F4"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <path
        d="M32 24L39 28V36L32 40L25 36V28L32 24Z"
        fill="#17283D"
        stroke="#D8F7FB"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <circle cx="32" cy="32" r="3.1" fill="#FFD878" />
      <circle cx="32" cy="15" r="2.3" fill="var(--panel-solid)" stroke="#9CEBF4" strokeWidth="1.2" />
      <circle cx="16" cy="43" r="2.3" fill="var(--panel-solid)" stroke="#9CEBF4" strokeWidth="1.2" />
      <circle cx="48" cy="43" r="2.3" fill="var(--panel-solid)" stroke="#C1B0FF" strokeWidth="1.2" />
    </svg>
  );
}

export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return <Loader2 size={size} className={clsx("spin", className)} />;
}

export function StatusDot({
  tone = "muted",
  pulse = false,
}: {
  tone?: "muted" | "live" | "success" | "warning" | "danger";
  pulse?: boolean;
}) {
  return <span className={clsx("status-dot", tone, pulse && tone === "live" ? "live" : "")} />;
}

export function Modal({
  open,
  onClose,
  children,
  className,
  label,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  label: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={clsx("modal", className)}
        role="dialog"
        aria-modal="true"
        aria-label={label}
      >
        {children}
      </div>
    </div>
  );
}

export function ModalHeader({
  title,
  subtitle,
  onClose,
  icon,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  icon?: ReactNode;
  children?: ReactNode;
}) {
  const t = useT();
  return (
    <div className="flex items-start gap-3 border-b border-[var(--border)] px-5 py-4">
      {icon ? (
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--accent-soft)] text-[var(--accent)]">
          {icon}
        </div>
      ) : null}
      <div className="min-w-0 flex-1">
        <h2 className="text-[14px] font-bold tracking-tight">{title}</h2>
        {subtitle ? (
          <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--muted)]">{subtitle}</p>
        ) : null}
      </div>
      {children}
      <button className="icon-btn" onClick={onClose} aria-label={t("common.closeDialog")}>
        <X size={15} />
      </button>
    </div>
  );
}

export function SectionLabel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={clsx("panel-title", className)}>{children}</div>;
}

export function ToastStack() {
  const t = useT();
  const toasts = useJin((state) => state.toasts);
  const dismiss = useJin((state) => state.dismissToast);
  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={clsx("toast", toast.kind)}>
          <StatusDot
            tone={
              toast.kind === "error"
                ? "danger"
                : toast.kind === "success"
                  ? "success"
                  : "live"
            }
          />
          <div className="flex-1">{toast.message}</div>
          <button
            className="icon-btn -mt-1 -mr-1 h-6 w-6 shrink-0"
            onClick={() => dismiss(toast.id)}
            aria-label={t("common.dismissNotification")}
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function LoadingScreen({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="glass flex items-center gap-3 rounded-2xl px-5 py-4">
        <BrandMark size={28} />
        <div>
          <div className="text-[12px] font-bold">Jin</div>
          <div className="text-[10px] text-[var(--muted)]">{message}</div>
        </div>
        <Spinner className="ml-2 text-[var(--accent)]" />
      </div>
    </div>
  );
}
