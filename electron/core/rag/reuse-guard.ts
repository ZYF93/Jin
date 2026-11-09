import type { ImplementationCheck } from "../../../shared/ledger/types";
import type { ReusePlan } from "../../../shared/ipc";
import type { ScanResult } from "../scan/scanner";

export interface ReuseGuardInput {
  plan: ReusePlan | null;
  scan: ScanResult;
  changedPaths: readonly string[];
  deletedPaths?: readonly string[];
  /** New content keyed by path, used to find exports that duplicate an existing unit. */
  edits?: ReadonlyArray<{ path: string; content: string }>;
}

function exportPatterns(path: string): RegExp[] {
  const lower = path.toLowerCase();
  if (lower.endsWith(".py")) {
    return [
      /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm,
      /^\s*class\s+([A-Za-z_]\w*)/gm,
    ];
  }
  if (lower.endsWith(".go")) {
    return [
      /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/gm,
      /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/gm,
    ];
  }
  if (lower.endsWith(".java") || lower.endsWith(".kt") || lower.endsWith(".kts")) {
    return [
      /(?:^|\n)\s*(?:(?:public|private|protected|abstract|final|open|data|sealed)\s+)*(?:class|interface|enum|object|record)\s+([A-Za-z_]\w*)/g,
      /(?:^|\n)\s*fun\s+([A-Za-z_]\w*)\s*\(/g,
    ];
  }
  return [
    /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
    /^\s*export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
    /^\s*export\s+(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
    /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
  ];
}

function exportedNames(path: string, content: string): string[] {
  const names = new Set<string>();
  for (const pattern of exportPatterns(path)) {
    for (const match of content.matchAll(pattern)) {
      if (match[1]) names.add(match[1]);
    }
  }
  return [...names];
}

function evidence(paths: readonly string[], limit = 4): string {
  const shown = paths.slice(0, limit).join(", ");
  return paths.length > limit ? `${shown} (+${paths.length - limit} more)` : shown;
}

/**
 * Reuse guard: the implementation may add new code, but it may not silently
 * duplicate an exported symbol owned by an untouched reuse candidate. This is
 * deliberately a structural check, not a semantic review; the Verifier still
 * runs project checks and conformance.
 */
export function evaluateReuse(input: ReuseGuardInput): ImplementationCheck {
  const plan = input.plan;
  if (!plan || plan.candidates.length === 0) {
    return {
      name: "reuse",
      status: "pass",
      detail: "No close reuse candidate was found; new code is allowed.",
    };
  }
  const changed = new Set([...input.changedPaths, ...(input.deletedPaths ?? [])]);
  const candidates = plan.candidates.slice(0, 8);
  const touched = candidates.filter((candidate) => changed.has(candidate.path));
  if (touched.length > 0) {
    return {
      name: "reuse",
      status: "pass",
      detail: `Reused or updated candidate file(s): ${evidence(touched.map((candidate) => candidate.path))}.`,
    };
  }

  const untouchedExports = new Map<string, string[]>();
  for (const file of input.scan.files) {
    if (changed.has(file.path)) continue;
    for (const name of file.exports) {
      const owners = untouchedExports.get(name);
      if (owners) owners.push(file.path);
      else untouchedExports.set(name, [file.path]);
    }
  }
  const duplicates: string[] = [];
  for (const edit of input.edits ?? []) {
    if (input.deletedPaths?.includes(edit.path)) continue;
    for (const name of exportedNames(edit.path, edit.content)) {
      const owners = untouchedExports.get(name);
      if (owners && owners.length > 0) {
        duplicates.push(`${name} (${edit.path} duplicates ${owners[0]})`);
      }
    }
  }
  if (duplicates.length > 0) {
    return {
      name: "reuse",
      status: "fail",
      detail: `New exports duplicate existing units: ${evidence(duplicates, 5)}. Reuse or rename them before committing.`,
    };
  }
  return {
    name: "reuse",
    status: "skip",
    detail: `ReusePlan listed ${candidates.length} candidate(s) (${evidence(
      candidates.map((candidate) => candidate.path),
    )}), but the implementation changed none. Verify that new code does not duplicate them.`,
  };
}
