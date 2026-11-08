import {
  ArrowRight,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Layers3,
  MessageSquare,
  Settings,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import type { MessageKey } from "../../shared/i18n";
import { isProviderConfigured } from "../../shared/provider";
import { useT } from "../lib/i18n";
import { useJin } from "../state/useJin";
import { BrandMark, Spinner } from "./ui";
import { formatRelative } from "../lib/utils";

const STEPS: Array<{
  icon: typeof MessageSquare;
  title: MessageKey;
  detail: MessageKey;
}> = [
  {
    icon: MessageSquare,
    title: "welcome.step1.title",
    detail: "welcome.step1.detail",
  },
  {
    icon: Layers3,
    title: "welcome.step2.title",
    detail: "welcome.step2.detail",
  },
  {
    icon: ShieldCheck,
    title: "welcome.step3.title",
    detail: "welcome.step3.detail",
  },
];

export function WelcomeScreen() {
  const t = useT();
  const app = useJin((state) => state.app);
  const busy = useJin((state) => state.busy);
  const openProject = useJin((state) => state.openProject);
  const createProject = useJin((state) => state.createProject);
  const openSettings = useJin((state) => state.openSettings);

  const recents = app?.recentProjects ?? [];
  const provider = app?.settings.provider;
  const configured = isProviderConfigured(provider);
  const heroLine = t("welcome.heroLine2", { accent: "\u0001" });
  const [heroBefore, heroAfter = ""] = heroLine.split("\u0001");

  return (
    <div className="flex h-full flex-col overflow-auto">
      <header className="flex items-center gap-3 px-7 py-5">
        <BrandMark size={32} />
        <div>
          <div className="text-[15px] font-extrabold tracking-tight">Jin</div>
          <div className="font-mono-ui text-[9px] tracking-[0.12em] text-[var(--faint)] uppercase">
            {t("welcome.tagline")}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="chip">
            <span className="status-dot live" /> {t("welcome.localFirst")}
          </span>
          <button
            className="btn btn-ghost"
            onClick={() => openSettings(configured ? "general" : "provider")}
          >
            <Settings size={13} />
            {t("welcome.settings")}
          </button>
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-[1220px] flex-1 items-center gap-8 px-7 pb-10 lg:grid-cols-[minmax(0,1.1fr)_minmax(390px,0.9fr)]">
        <section className="min-w-0">
          <div className="chip chip-accent">
            <Sparkles size={11} />
            {t("welcome.badge")}
          </div>
          <h1 className="mt-5 max-w-[650px] text-[clamp(34px,4.8vw,62px)] leading-[0.98] font-extrabold tracking-[-0.045em]">
            {t("welcome.heroLine1")}
            <br />
            {heroBefore}
            <span className="text-[var(--accent)]">{t("welcome.heroAccent")}</span>
            {heroAfter}
          </h1>
          <p className="mt-5 max-w-[570px] text-[14px] leading-relaxed text-[var(--muted)]">
            {t("welcome.heroDetail")}
          </p>

          <div className="mt-8 grid max-w-[720px] gap-3 sm:grid-cols-3">
            {STEPS.map((step, index) => (
              <div key={step.title} className="glass rounded-xl p-3.5">
                <div className="flex items-center gap-2">
                  <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--panel-soft)] text-[var(--accent)]">
                    <step.icon size={14} />
                  </div>
                  <span className="font-mono-ui text-[9px] text-[var(--faint)]">
                    0{index + 1}
                  </span>
                </div>
                <div className="mt-2.5 text-[11.5px] font-bold">{t(step.title)}</div>
                <div className="mt-1 text-[10.5px] leading-relaxed text-[var(--muted)]">
                  {t(step.detail)}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-2 text-[10px] text-[var(--faint)]">
            <span className="flex items-center gap-1.5">
              <GitBranch size={11} /> {t("welcome.asyncGit")}
            </span>
            <span className="flex items-center gap-1.5">
              <ShieldCheck size={11} /> {t("welcome.approvedOnly")}
            </span>
            <span className="flex items-center gap-1.5">
              <Layers3 size={11} /> {t("welcome.tsFirst")}
            </span>
          </div>
        </section>

        <section className="glass-strong slide-up rounded-2xl p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-[14px] font-bold">{t("welcome.openWorkspace")}</h2>
              <p className="mt-1 text-[10.5px] leading-relaxed text-[var(--muted)]">
                {t("welcome.openWorkspaceDetail")}
              </p>
            </div>
            <span className="chip">.jin/</span>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2">
            <button
              className="btn btn-primary h-10"
              disabled={Boolean(busy)}
              onClick={() => void openProject()}
            >
              {busy ? <Spinner size={13} /> : <FolderOpen size={14} />}
              {t("welcome.openProject")}
            </button>
            <button
              className="btn h-10"
              disabled={Boolean(busy)}
              onClick={() => void createProject()}
            >
              <FolderPlus size={14} />
              {t("welcome.newProject")}
            </button>
          </div>

          <button
            className="mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--panel-soft)] px-3 py-2.5 text-left transition-colors hover:bg-[var(--control)]"
            onClick={() => useJin.getState().setDemoGraph(true)}
          >
            <span className="flex items-center gap-2 text-[11px] font-semibold text-[var(--accent)]">
              <Sparkles size={13} />
              {t("welcome.viewDemo")}
              <ArrowRight size={12} className="ml-auto shrink-0 text-[var(--faint)]" />
            </span>
            <span className="mt-1 block text-[9.5px] leading-relaxed text-[var(--faint)]">
              {t("welcome.viewDemoDetail")}
            </span>
          </button>

          {!configured ? (
            <button
              className="mt-2 flex w-full items-center gap-2 rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2.5 text-left transition-colors hover:bg-amber-400/[0.1]"
              onClick={() => openSettings("provider")}
            >
              <Sparkles size={13} className="shrink-0 text-[var(--warning)]" />
              <span className="min-w-0 flex-1 text-[10.5px] leading-relaxed text-[var(--muted)]">
                <strong className="text-[var(--warning)]">
                  {t("welcome.noProviderTitle")}
                </strong>{" "}
                {t("welcome.noProviderDetail")}
              </span>
              <ArrowRight size={12} className="shrink-0 text-[var(--faint)]" />
            </button>
          ) : (
            <div className="mt-2 flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--panel-soft)] px-3 py-2 text-[10px] text-[var(--muted)]">
              <span className="status-dot success" />
              {t("welcome.providerReady", {
                model: provider?.model ?? t("welcome.provider"),
              })}
              <span className="ml-auto font-mono-ui text-[9px] text-[var(--faint)]">
                {provider?.kind}
              </span>
            </div>
          )}

          <div className="mt-5 flex items-center gap-2">
            <span className="panel-title">{t("welcome.recent")}</span>
            <span className="chip h-[18px] px-1.5 text-[8px]">{recents.length}</span>
            <div className="h-px flex-1 bg-[var(--border)]" />
          </div>

          <div className="mt-2 space-y-1">
            {recents.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[var(--border)] px-4 py-7 text-center">
                <Layers3 size={19} className="mx-auto text-[var(--faint)]" />
                <div className="mt-2 text-[11px] font-semibold text-[var(--muted)]">
                  {t("welcome.noRecent")}
                </div>
                <div className="mt-1 text-[10px] text-[var(--faint)]">
                  {t("welcome.noRecentDetail")}
                </div>
              </div>
            ) : (
              recents.slice(0, 6).map((project) => (
                <button
                  key={project.path}
                  className="hover-row flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left"
                  disabled={Boolean(busy)}
                  onClick={() => void openProject(project.path)}
                  title={project.path}
                >
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--panel-soft)] text-[var(--accent)]">
                    <FolderOpen size={13} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[11px] font-semibold">{project.name}</div>
                    <div className="font-mono-ui truncate text-[9px] text-[var(--faint)]">
                      {project.path}
                    </div>
                  </div>
                  <span className="shrink-0 text-[9px] text-[var(--faint)]">
                    {formatRelative(project.lastOpenedAt)}
                  </span>
                </button>
              ))
            )}
          </div>
        </section>
      </main>

      <footer className="flex items-center justify-between border-t border-[var(--border)] px-7 py-3 text-[9px] text-[var(--faint)]">
        <span>{t("welcome.footer")}</span>
        <span className="font-mono-ui">{t("welcome.footerTelemetry")}</span>
      </footer>
    </div>
  );
}
