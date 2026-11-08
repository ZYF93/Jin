import type {
  ArchSnapshot,
  ConformanceResult,
  ImplementationRecord,
  VersionState,
} from "./types";

/** Conformance results written before `kind` existed identify drift by evidence. */
function isLegacyDrift(result: ConformanceResult): boolean {
  return result.evidence.some(
    (line) =>
      line === "No architecture drift detected between approved L0/L1 nodes and source scan" ||
      line.startsWith("Undeclared source node ") ||
      line.startsWith("Declared node "),
  );
}

export function isDriftResult(result: ConformanceResult): boolean {
  if (result.kind === "drift") return true;
  if (result.kind === "op") return false;
  return isLegacyDrift(result);
}

/** Latest implementation record for a version, or null when it was never implemented. */
export function latestImplementation(
  snapshot: ArchSnapshot,
  version: VersionState,
): ImplementationRecord | null {
  for (let index = version.implementations.length - 1; index >= 0; index -= 1) {
    const id = version.implementations[index];
    if (!id) continue;
    const record = snapshot.implementations[id];
    if (record) return record;
  }
  return null;
}

/** True when the latest implementation failed the architecture drift check. */
export function hasFailedDrift(
  implementation: ImplementationRecord | null | undefined,
): boolean {
  return Boolean(
    implementation?.conformance.some(
      (result) => result.status === "fail" && isDriftResult(result),
    ),
  );
}

export function failedConformance(
  implementation: ImplementationRecord | null | undefined,
): ConformanceResult[] {
  return implementation?.conformance.filter((result) => result.status === "fail") ?? [];
}
