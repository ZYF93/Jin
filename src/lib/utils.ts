import type { ChangeKind } from "../../shared/arch/diff";
import type {
  ArchSnapshot,
  ProposalView,
  VersionStatus,
} from "../../shared/ipc";

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const text = String(error);
  return text === "[object Object]" ? "Unexpected error." : text;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatRelative(value: string | null | undefined): string {
  if (!value) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "never";
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact" }).format(value);
}

export function formatCountLabel(
  value: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${formatCount(value)} ${value === 1 ? singular : plural}`;
}

export function formatBytes(value: number | undefined): string {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

export function versionOrdinal(
  snapshot: ArchSnapshot | null | undefined,
  versionId: string,
): number | null {
  return snapshot?.versions[versionId]?.ordinal ?? null;
}

export function nextOrdinal(snapshot: ArchSnapshot | null | undefined): number {
  if (!snapshot) return 1;
  let max = 0;
  for (const version of Object.values(snapshot.versions)) {
    if (version.ordinal !== null) max = Math.max(max, version.ordinal);
  }
  return max + 1;
}

export function ordinalLabel(ordinal: number | null | undefined): string {
  return ordinal ? `v${ordinal}` : "v—";
}

export function isReviewing(proposal: ProposalView | null | undefined): boolean {
  return proposal?.status === "in_review" || proposal?.status === "stale";
}

export function changeLabel(change: ChangeKind | undefined): string {
  if (change === "added") return "Added";
  if (change === "removed") return "Removed";
  if (change === "modified") return "Modified";
  return "Unchanged";
}

export function statusLabel(status: VersionStatus): string {
  switch (status) {
    case "draft":
      return "Draft";
    case "in_review":
      return "In review";
    case "approved":
      return "Approved";
    case "rejected":
      return "Rejected";
    case "implemented":
      return "Implemented";
    case "verified":
      return "Verified";
    case "conflicted":
      return "Conflicted";
    default:
      return status;
  }
}

export function statusTone(
  status: VersionStatus,
): "muted" | "accent" | "success" | "warning" | "danger" {
  switch (status) {
    case "approved":
    case "implemented":
    case "verified":
      return "success";
    case "in_review":
    case "draft":
      return "accent";
    case "conflicted":
      return "danger";
    case "rejected":
      return "muted";
    default:
      return "muted";
  }
}

export function kindLabel(kind: string): string {
  return kind.split("_").join(" ");
}

export function fileIconTone(extension: string | undefined): string {
  if (!extension) return "text-slate-400";
  if (["ts", "tsx"].includes(extension)) return "text-sky-300";
  if (["js", "jsx", "mjs", "cjs"].includes(extension)) return "text-amber-300";
  if (["vue", "svelte"].includes(extension)) return "text-emerald-300";
  if (["py"].includes(extension)) return "text-cyan-300";
  if (["java", "kt", "kts"].includes(extension)) return "text-orange-300";
  if (["go"].includes(extension)) return "text-teal-300";
  if (["json", "jsonc"].includes(extension)) return "text-yellow-300";
  if (["md", "mdx"].includes(extension)) return "text-indigo-300";
  if (["css", "scss", "less"].includes(extension)) return "text-pink-300";
  if (["yaml", "yml", "toml"].includes(extension)) return "text-violet-300";
  return "text-slate-400";
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
