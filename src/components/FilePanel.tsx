import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  File,
  FileCode2,
  FileJson2,
  Folder,
  FolderOpen,
  Lock,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import type { FileNode } from "../../shared/ipc";
import { highlightCode } from "../lib/highlight";
import { fileIconTone, formatBytes } from "../lib/utils";
import { useJin } from "../state/useJin";
import { Spinner } from "./ui";

function parents(path: string): string[] {
  const parts = path.split("/");
  const result: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    result.push(parts.slice(0, index).join("/"));
  }
  return result;
}

function TreeNode({
  entry,
  depth,
  openDirs,
  selectedFile,
  onToggle,
  onOpen,
}: {
  entry: FileNode;
  depth: number;
  openDirs: Set<string>;
  selectedFile: string | null;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  const isDirectory = entry.type === "directory";
  const open = openDirs.has(entry.path);
  const active = selectedFile === entry.path;
  const extension = entry.extension;
  const iconClass = fileIconTone(extension);

  return (
    <div>
      <button
        className={`hover-row flex h-[23px] w-full items-center gap-1 pr-2 text-left ${
          active ? "bg-[var(--accent-soft)] text-[var(--text)]" : "text-[var(--muted)]"
        }`}
        style={{ paddingLeft: `${8 + depth * 13}px` }}
        onClick={() => (isDirectory ? onToggle(entry.path) : onOpen(entry.path))}
        title={entry.path || entry.name}
      >
        {isDirectory ? (
          open ? (
            <ChevronDown size={11} className="shrink-0 text-[var(--faint)]" />
          ) : (
            <ChevronRight size={11} className="shrink-0 text-[var(--faint)]" />
          )
        ) : (
          <span className="w-[11px] shrink-0" />
        )}
        {isDirectory ? (
          open ? (
            <FolderOpen size={13} className="shrink-0 text-[var(--accent)]" />
          ) : (
            <Folder size={13} className="shrink-0 text-[var(--faint)]" />
          )
        ) : extension === "json" || extension === "jsonc" ? (
          <FileJson2 size={12} className={`shrink-0 ${iconClass}`} />
        ) : ["ts", "tsx", "js", "jsx", "vue", "py", "go", "rs", "java", "kt"].includes(
            extension ?? "",
          ) ? (
          <FileCode2 size={12} className={`shrink-0 ${iconClass}`} />
        ) : (
          <File size={12} className={`shrink-0 ${iconClass}`} />
        )}
        <span className="truncate text-[10px]">{entry.name}</span>
        {!isDirectory && entry.size !== undefined ? (
          <span className="ml-auto shrink-0 font-mono-ui text-[8px] text-[var(--faint)]">
            {formatBytes(entry.size)}
          </span>
        ) : null}
      </button>
      {isDirectory && open
        ? (entry.children ?? []).map((child) => (
            <TreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              openDirs={openDirs}
              selectedFile={selectedFile}
              onToggle={onToggle}
              onOpen={onOpen}
            />
          ))
        : null}
    </div>
  );
}

function FileViewer() {
  const selectedFile = useJin((state) => state.selectedFile);
  const fileContent = useJin((state) => state.fileContent);
  const fileLoading = useJin((state) => state.fileLoading);
  const fileError = useJin((state) => state.fileError);
  const openFile = useJin((state) => state.openFile);
  const notify = useJin((state) => state.notify);
  const [html, setHtml] = useState("");
  const [highlighting, setHighlighting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!fileContent) {
      setHtml("");
      return;
    }
    setHighlighting(true);
    setHtml("");
    void highlightCode(fileContent.content, fileContent.language)
      .then((result) => {
        if (!cancelled) setHtml(result);
      })
      .catch(() => {
        if (!cancelled) setHtml("");
      })
      .finally(() => {
        if (!cancelled) setHighlighting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fileContent]);

  const openExternal = async (): Promise<void> => {
    if (!fileContent) return;
    try {
      await window.jin.openInExternalEditor(fileContent.path);
    } catch (error) {
      notify("error", error instanceof Error ? error.message : String(error));
    }
  };

  if (!selectedFile) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-5 text-center">
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--panel-soft)] text-[var(--faint)]">
          <FileCode2 size={20} />
        </div>
        <div className="mt-3 text-[11px] font-semibold text-[var(--muted)]">
          Select a file to inspect
        </div>
        <div className="mt-1 text-[9.5px] leading-relaxed text-[var(--faint)]">
          The viewer is read-only. Use the external editor button to make changes.
        </div>
      </div>
    );
  }

  if (fileLoading) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-[var(--muted)]">
        <Spinner size={14} />
        <span className="text-[10px]">Reading file…</span>
      </div>
    );
  }

  if (fileError) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-5 text-center">
        <div className="text-[11px] font-semibold text-[var(--danger)]">Could not read file</div>
        <div className="mt-1 max-w-[280px] text-[9.5px] leading-relaxed text-[var(--muted)]">
          {fileError}
        </div>
        <button className="btn mt-3 h-7 text-[9px]" onClick={() => void openFile(selectedFile)}>
          <RotateCcw size={10} /> Retry
        </button>
      </div>
    );
  }

  if (!fileContent) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-2.5 py-2">
        <div className="min-w-0 flex-1">
          <div className="font-mono-ui truncate text-[9.5px] font-semibold" title={fileContent.path}>
            {fileContent.path}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[8px] text-[var(--faint)]">
            <span>{fileContent.language}</span>
            <span>·</span>
            <span>{formatBytes(fileContent.size)}</span>
            {fileContent.truncated ? <span className="text-[var(--warning)]">· truncated</span> : null}
          </div>
        </div>
        <span className="chip h-[18px] gap-1 px-1.5 text-[8px]">
          <Lock size={8} /> read-only
        </span>
        <button
          className="icon-btn h-7 w-7"
          title="Open in external editor"
          aria-label="Open in external editor"
          onClick={() => void openExternal()}
        >
          <ExternalLink size={13} />
        </button>
      </div>
      {highlighting ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-[var(--muted)]">
          <Spinner size={13} />
          <span className="text-[9.5px]">Highlighting…</span>
        </div>
      ) : html ? (
        <div className="code-view" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <div className="code-view">
          <pre>
            <code>{fileContent.content}</code>
          </pre>
        </div>
      )}
      <div className="flex shrink-0 items-center gap-1.5 border-t border-[var(--border)] px-2.5 py-1.5 text-[8px] text-[var(--faint)]">
        <span className="status-dot success" />
        external edits require a rescan
        <span className="ml-auto font-mono-ui">utf-8</span>
      </div>
    </div>
  );
}

export function FilePanel() {
  const tree = useJin((state) => state.fileTree);
  const loading = useJin((state) => state.fileTreeLoading);
  const selectedFile = useJin((state) => state.selectedFile);
  const loadFileTree = useJin((state) => state.loadFileTree);
  const openFile = useJin((state) => state.openFile);
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set());
  const expandedTree = useRef<FileNode | null>(null);

  useEffect(() => {
    if (!tree || expandedTree.current === tree) return;
    expandedTree.current = tree;
    const initial = new Set<string>();
    for (const child of tree.children ?? []) {
      if (child.type === "directory") initial.add(child.path);
    }
    if (selectedFile) {
      for (const parent of parents(selectedFile)) initial.add(parent);
    }
    setOpenDirs(initial);
  }, [selectedFile, tree]);

  useEffect(() => {
    if (!selectedFile) return;
    setOpenDirs((current) => {
      const next = new Set(current);
      for (const parent of parents(selectedFile)) next.add(parent);
      return next;
    });
  }, [selectedFile]);

  const toggle = (path: string): void => {
    setOpenDirs((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const roots = useMemo(() => tree?.children ?? [], [tree]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--border)] px-2.5 py-1.5">
        <span className="panel-title">Explorer</span>
        <span className="chip h-[18px] px-1.5 text-[8px]">read-only</span>
        <button
          className="icon-btn ml-auto h-7 w-7"
          onClick={() => void loadFileTree()}
          disabled={loading}
          title="Refresh file tree"
          aria-label="Refresh file tree"
        >
          {loading ? <Spinner size={12} /> : <RefreshCw size={12} />}
        </button>
      </div>
      <div className="min-h-[120px] max-h-[43%] shrink-0 overflow-auto border-b border-[var(--border)] py-1">
        {loading && !tree ? (
          <div className="flex h-24 items-center justify-center gap-2 text-[var(--faint)]">
            <Spinner size={13} /> <span className="text-[9.5px]">Loading tree…</span>
          </div>
        ) : roots.length === 0 ? (
          <div className="px-4 py-8 text-center text-[9.5px] text-[var(--faint)]">
            No readable project files.
          </div>
        ) : (
          roots.map((entry) => (
            <TreeNode
              key={entry.path || entry.name}
              entry={entry}
              depth={0}
              openDirs={openDirs}
              selectedFile={selectedFile}
              onToggle={toggle}
              onOpen={(path) => void openFile(path)}
            />
          ))
        )}
      </div>
      <FileViewer />
    </div>
  );
}
