import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ArchOp,
  ArchSnapshot,
  ConformanceResult,
  ImplementationCheck,
} from "../../../shared/arch/types";
import type { ScanResult } from "../scan/scanner";

export interface VerifyInput {
  root: string;
  snapshot: ArchSnapshot;
  scan: ScanResult;
  ops: readonly ArchOp[];
  opRecordIds: readonly string[];
}

function observedLevelNodes(scan: ScanResult): Map<string, string> {
  const map = new Map<string, string>();
  for (const node of scan.nodes) {
    if (node.level !== "L0" && node.level !== "L1") continue;
    map.set(node.id, node.file || node.path);
  }
  return map;
}

/**
 * Check that the approved structural target is actually present in a fresh
 * scan. Structural edges are accepted as declared metadata; node existence and
 * file/symbol presence are checked against source facts.
 */
export function verifyArchitecture(input: VerifyInput): {
  results: ConformanceResult[];
  check: ImplementationCheck;
} {
  const observed = observedLevelNodes(input.scan);
  const observedFiles = new Map(
    input.scan.nodes
      .filter((node) => node.file)
      .map((node) => [node.file, node]),
  );
  const results: ConformanceResult[] = [];
  const pushOp = (result: Omit<ConformanceResult, "kind">): void => {
    results.push({ ...result, kind: "op" });
  };

  input.ops.forEach((op, index) => {
    const opId = input.opRecordIds[index] ?? `${input.snapshot.lastRecordId ?? "version"}:${index}`;
    if (op.op === "node.add") {
      const node = op.node;
      if (node.level === "facet" || node.kind === "external") {
        const fileNode = observedFiles.get(node.file);
        pushOp({
          opId,
          status: fileNode ? "pass" : "fail",
          evidence: fileNode
            ? [`Observed source file ${node.file}`]
            : [`Source file ${node.file || "(none)"} was not observed`],
        });
        return;
      }
      const where = observed.get(node.id);
      pushOp({
        opId,
        status: where ? "pass" : "fail",
        evidence: where
          ? [`Observed ${node.level} ${node.name} at ${where || node.path}`]
          : [`Not observed in a fresh scan: ${node.level} ${node.name} (${node.path || node.file || "no path"})`],
      });
      return;
    }
    if (op.op === "node.update") {
      const node = input.snapshot.nodes[op.id];
      const where = observed.get(op.id);
      pushOp({
        opId,
        status: where || (node?.level === "facet" && node.file) ? "pass" : "fail",
        evidence: where
          ? [`Observed updated node ${node?.name ?? op.id} at ${where}`]
          : node?.level === "facet" && node.file
            ? [`Facet ${node.name} mapped to observed file ${node.file}`]
            : [`Updated node ${op.id} was not observed`],
      });
      return;
    }
    if (op.op === "node.remove") {
      const node = input.snapshot.nodes[op.id];
      const stillObserved = observed.has(op.id) || Boolean(node?.file && observedFiles.has(node.file));
      pushOp({
        opId,
        status: stillObserved ? "fail" : "pass",
        evidence: stillObserved
          ? [`Removed node ${node?.name ?? op.id} is still present in source facts`]
          : [`Removed node ${node?.name ?? op.id} is no longer observed`],
      });
      return;
    }
    pushOp({
      opId,
      status: "pass",
      evidence: [`Structural ${op.op} is declared in the approved snapshot`],
    });
  });

  // Drift: compare L0/L1 scan facts with the approved snapshot, ignoring
  // external packages and facets (facets are finer than the approval surface).
  const declared = new Set(
    Object.values(input.snapshot.nodes)
      .filter(
        (node) =>
          (node.level === "L0" || node.level === "L1") &&
          node.kind !== "external" &&
          node.kind !== "system" &&
          (node.metadata.scanned === true || node.metadata.origin === "scan" || node.level === "L1"),
      )
      .map((node) => node.id),
  );
  const observedIds = new Set(
    input.scan.nodes
      .filter(
        (node) =>
          (node.level === "L0" || node.level === "L1") &&
          node.kind !== "external" &&
          node.kind !== "system",
      )
      .map((node) => node.id),
  );
  const undeclared = [...observedIds].filter((id) => !input.snapshot.nodes[id]);
  const missing = [...declared].filter((id) => !observedIds.has(id));
  const driftPass = undeclared.length === 0 && missing.length === 0;
  results.push({
    opId: input.opRecordIds[0] ?? "drift",
    kind: "drift",
    status: driftPass ? "pass" : "fail",
    evidence: driftPass
      ? ["No architecture drift detected between approved L0/L1 nodes and source scan"]
      : [
          ...undeclared.slice(0, 8).map((id) => `Undeclared source node ${id}`),
          ...missing.slice(0, 8).map((id) => `Declared node ${id} has no source fact`),
        ],
  });

  const failed = results.filter((result) => result.status === "fail").length;
  return {
    results,
    check: {
      name: "architecture conformance",
      status: failed === 0 ? "pass" : "fail",
      detail:
        failed === 0
          ? `${results.length} conformance checks passed`
          : `${failed} of ${results.length} conformance checks failed`,
    },
  };
}

interface PackageJson {
  scripts?: Record<string, string>;
}

function packageManager(root: string): string {
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock"))) return "bun";
  return "npm";
}

function runScript(
  root: string,
  manager: string,
  script: string,
  timeoutMs = 180_000,
): Promise<ImplementationCheck> {
  const args =
    manager === "yarn" || manager === "bun"
      ? ["run", script]
      : ["run", script];
  const command = process.platform === "win32" ? `${manager}.cmd` : manager;
  return new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      {
        cwd: root,
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          ...process.env,
          CI: "1",
          FORCE_COLOR: "0",
        },
      },
      (error, stdout, stderr) => {
        const output = `${stdout}\n${stderr}`.trim();
        if (error) {
          const timeout = (error as NodeJS.ErrnoException & { killed?: boolean }).killed;
          resolve({
            name: script,
            status: "fail",
            detail: `${timeout ? "Timed out" : error.message}\n${output.slice(-2000)}`.trim(),
          });
          return;
        }
        resolve({
          name: script,
          status: "pass",
          detail: output.slice(-2000) || "Passed",
        });
      },
    );
    child.on("error", (error) => {
      resolve({ name: script, status: "fail", detail: error.message });
    });
  });
}

/** Run the project's own typecheck/test/lint scripts; never invent commands. */
export async function runProjectChecks(root: string): Promise<ImplementationCheck[]> {
  const packagePath = join(root, "package.json");
  if (!existsSync(packagePath)) {
    return [
      {
        name: "project checks",
        status: "skip",
        detail: "No package.json found; no project test/typecheck scripts to run.",
      },
    ];
  }
  let pkg: PackageJson;
  try {
    pkg = JSON.parse(readFileSync(packagePath, "utf8")) as PackageJson;
  } catch {
    return [
      {
        name: "project checks",
        status: "fail",
        detail: "package.json is not valid JSON.",
      },
    ];
  }
  const scripts = pkg.scripts ?? {};
  const selected = ["typecheck", "test", "lint"].filter((script) => typeof scripts[script] === "string");
  if (selected.length === 0) {
    return [
      {
        name: "project checks",
        status: "skip",
        detail: "No typecheck/test/lint scripts found in package.json.",
      },
    ];
  }
  const manager = packageManager(root);
  const checks: ImplementationCheck[] = [];
  for (const script of selected) {
    checks.push(await runScript(root, manager, script));
  }
  return checks;
}

export function gitState(root: string): { commit: string; files: string[] } {
  try {
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const files = status
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter(Boolean)
      .map((line) => line.split(" -> ").pop() ?? line);
    return { commit: commit || "working-tree", files };
  } catch {
    return { commit: "working-tree", files: [] };
  }
}
