import { useEffect } from "react";
import { AlertTriangle, FolderOpen, RotateCcw, Sparkles, X } from "lucide-react";
import { ArchitectureCanvas } from "./components/ArchitectureCanvas";
import { ChatPanel } from "./components/ChatPanel";
import { CommandPalette } from "./components/CommandPalette";
import { LeftPanel } from "./components/LeftPanel";
import { ReviewBar } from "./components/ReviewBar";
import { ReviewDialog } from "./components/ReviewDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { TopBar } from "./components/TopBar";
import { BrandMark, LoadingScreen, ToastStack } from "./components/ui";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { useJin } from "./state/useJin";
import { useT } from "./lib/i18n";

function Workspace() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopBar />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <LeftPanel />
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <ReviewBar />
          <div className="relative min-h-0 flex-1 overflow-hidden">
            <ArchitectureCanvas />
          </div>
        </main>
        <ChatPanel />
      </div>
    </div>
  );
}

function DemoWorkspace() {
  const t = useT();
  const openProject = useJin((state) => state.openProject);
  const busy = useJin((state) => state.busy);
  const setDemoGraph = useJin((state) => state.setDemoGraph);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-[var(--border)] px-4 py-2.5">
        <BrandMark size={24} />
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[12px] font-bold">
            {t("demo.title")}
            <span className="chip chip-accent h-[18px] px-1.5 text-[8px]">
              <Sparkles size={9} />
              {t("graph.demoDiff")}
            </span>
          </div>
          <div className="font-mono-ui truncate text-[9px] text-[var(--faint)]">
            {t("demo.subtitle")}
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button
            className="btn h-8 text-[10px]"
            disabled={Boolean(busy)}
            onClick={() => void openProject()}
          >
            <FolderOpen size={12} />
            {t("demo.openProject")}
          </button>
          <button className="btn btn-primary h-8 text-[10px]" onClick={() => setDemoGraph(false)}>
            <X size={12} />
            {t("demo.exit")}
          </button>
        </div>
      </header>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <ArchitectureCanvas />
      </div>
    </div>
  );
}

function StartupError({ message }: { message: string }) {
  const t = useT();
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="glass max-w-[480px] rounded-2xl p-5">
        <div className="flex items-center gap-2 text-[var(--danger)]">
          <AlertTriangle size={17} />
          <span className="text-[13px] font-bold">{t("startup.failed")}</span>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-[var(--muted)]">{message}</p>
        <p className="mt-2 text-[10px] leading-relaxed text-[var(--faint)]">{t("startup.hint")}</p>
        <button className="btn mt-4" onClick={() => window.location.reload()}>
          <RotateCcw size={13} />
          {t("startup.reload")}
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const t = useT();
  const ready = useJin((state) => state.ready);
  const startupError = useJin((state) => state.startupError);
  const app = useJin((state) => state.app);
  const demoGraph = useJin((state) => state.demoGraph);
  const initialize = useJin((state) => state.initialize);
  const setIntentsCollapsed = useJin((state) => state.setIntentsCollapsed);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1180px)");
    const apply = (): void => setIntentsCollapsed(media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [setIntentsCollapsed]);

  const theme = app?.settings.theme;
  const glass = app?.settings.glass;
  const reduceMotion = app?.settings.ui.reduceMotion;

  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (): void => {
      if (!theme) return;
      const resolved = theme === "system" ? (media.matches ? "dark" : "light") : theme;
      root.dataset.theme = resolved;
      if (glass) root.dataset.glass = glass;
      root.classList.toggle("reduce-motion", Boolean(reduceMotion));
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme, glass, reduceMotion]);

  return (
    <>
      {!ready ? (
        <LoadingScreen message={t("startup.openingLedger")} />
      ) : startupError ? (
        <StartupError message={startupError} />
      ) : !app ? (
        <LoadingScreen message={t("startup.readingState")} />
      ) : demoGraph ? (
        <DemoWorkspace />
      ) : app.project ? (
        <Workspace />
      ) : (
        <WelcomeScreen />
      )}
      <SettingsDialog />
      <ReviewDialog />
      <CommandPalette />
      <ToastStack />
    </>
  );
}
