import type { ArchOp, ArchSnapshot, Intent, IntentTask, Touch } from "../../../shared/ledger/types";
import { normalizeProjectPath } from "./path-safety";

function addFile(paths: Set<string>, value: string | undefined): void {
  if (!value) return;
  if (value.endsWith("/") || ["*", "?", "[", "]"].some((character) => value.includes(character)))
    return;
  try {
    paths.add(normalizeProjectPath(value));
  } catch {
    // An invalid architecture path is not a writable project path.
  }
}

function addNodeFiles(
  paths: Set<string>,
  node: { file?: string; path?: string } | undefined,
): void {
  if (!node) return;
  addFile(paths, node.file);
  if (node.path && /\.[A-Za-z0-9]+$/.test(node.path)) addFile(paths, node.path);
}

function addTestCompanions(paths: Set<string>): void {
  const sourcePaths = new Set(paths);
  for (const file of sourcePaths) {
    if (/\.(?:test|spec)\.[^/]+$/.test(file)) continue;
    const match = /^(?:(.*)\/)?([^/]+?)(\.[^/.]+)$/.exec(file);
    const directory = match?.[1] ?? "";
    const basename = match?.[2] ?? file;
    const extension = match?.[3] ?? "";
    for (const suffix of ["test", "spec"]) {
      const candidate = `${basename}.${suffix}${extension}`;
      addFile(paths, directory ? `${directory}/${candidate}` : candidate);
      addFile(paths, `${directory ? `${directory}/` : ""}__tests__/${candidate}`);
    }
  }
}

export function implementationTaskPaths(files: readonly string[]): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const file of files) addFile(paths, file);
  addTestCompanions(paths);
  return paths;
}

/** Return tasks that can be dispatched as separate workers, or null if scopes overlap. */
export function independentImplementationTasks(
  tasks: readonly IntentTask[],
  maxAgents = 3,
): readonly IntentTask[] | null {
  if (tasks.length < 2 || tasks.length > maxAgents) return null;
  if (
    tasks.some(
      (task) => !task.files?.length || !task.acceptance.length || task.dependsOn.length > 0,
    )
  ) {
    return null;
  }
  const owned = new Set<string>();
  for (const task of tasks) {
    const paths = implementationTaskPaths(task.files ?? []);
    if (paths.size === 0 || [...paths].some((path) => owned.has(path))) return null;
    for (const path of paths) owned.add(path);
  }
  return tasks;
}

/** Exact source/test paths authorized by the approved architecture version. */
export function implementationScopePaths(
  intent: Intent,
  ops: readonly ArchOp[],
  touches: readonly Touch[],
  snapshot: ArchSnapshot,
  baseSnapshot?: ArchSnapshot,
): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const task of intent.tasks) {
    for (const path of task.files ?? []) addFile(paths, path);
  }
  for (const op of ops) {
    if (op.op === "node.add") addNodeFiles(paths, op.node);
    else if (op.op === "node.update" || op.op === "node.remove") {
      addNodeFiles(paths, snapshot.nodes[op.id]);
      addNodeFiles(paths, baseSnapshot?.nodes[op.id]);
    }
  }
  for (const nodeIntent of intent.nodeIntents) {
    const target = snapshot.nodes[nodeIntent.facetId ?? nodeIntent.nodeId];
    addNodeFiles(paths, target);
    addNodeFiles(paths, baseSnapshot?.nodes[nodeIntent.facetId ?? nodeIntent.nodeId]);
    if (nodeIntent.facetId) addNodeFiles(paths, snapshot.nodes[nodeIntent.nodeId]);
    if (nodeIntent.facetId) addNodeFiles(paths, baseSnapshot?.nodes[nodeIntent.nodeId]);
  }
  for (const touch of touches) {
    for (const path of touch.codeRefs) addFile(paths, path);
    for (const path of touch.tests) addFile(paths, path);
  }
  addTestCompanions(paths);
  return paths;
}
