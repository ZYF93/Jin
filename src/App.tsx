import { useEffect } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { ArchitectureCanvas } from "./components/ArchitectureCanvas";
import { ChatPanel } from "./components/ChatPanel";
import { LeftPanel } from "./components/LeftPanel";
import { ReviewBar } from "./components/ReviewBar";
import { ReviewDialog } from "./components/ReviewDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { TopBar } from "./components/TopBar";
import { LoadingScreen, ToastStack } from "./components/ui";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { useJin } from "./state/useJin";

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

function StartupError({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="glass max-w-[480px] rounded-2xl p-5">
        <div className="flex items-center gap-2 text-[var(--danger)]">
          <AlertTriangle size={17} />
          <span className="text-[13px] font-bold">Jin could not start</span>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-[var(--muted)]">{message}</p>
        <p className="mt-2 text-[10px] leading-relaxed text-[var(--faint)]">
          Start the desktop app with <span className="font-mono-ui">pnpm dev</span>. The
          renderer needs the preload bridge exposed by Electron.
        </p>
        <button className="btn mt-4" onClick={() => window.location.reload()}>
          <RotateCcw size={13} />
          Reload
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const ready = useJin((state) => state.ready);
  const startupError = useJin((state) => state.startupError);
  const app = useJin((state) => state.app);
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
        <LoadingScreen message="Opening the architecture ledger…" />
      ) : startupError ? (
        <StartupError message={startupError} />
      ) : !app ? (
        <LoadingScreen message="Reading project state…" />
      ) : app.project ? (
        <Workspace />
      ) : (
        <WelcomeScreen />
      )}
      <SettingsDialog />
      <ReviewDialog />
      <ToastStack />
    </>
  );
}
