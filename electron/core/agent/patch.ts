import { applyPatch, parsePatch, type StructuredPatch } from "diff";
import { normalizeProjectPath } from "./path-safety";

export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchError";
  }
}

/** One file section of a unified diff, normalized to a project-relative path. */
export interface UnifiedPatchFile {
  path: string;
  patch: StructuredPatch;
  isNew: boolean;
  isDelete: boolean;
}

function headerPath(name: string | undefined): string {
  if (!name) return "";
  let value = name.trim();
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  // Git appends a timestamp after a tab in some diffs; ignore it.
  value = value.split("\t")[0]?.trim() ?? "";
  value = value.replace(/^[ab]\//, "");
  return value;
}

function sectionPath(section: StructuredPatch): {
  path: string;
  isNew: boolean;
  isDelete: boolean;
} {
  const oldPath = headerPath(section.oldFileName);
  const newPath = headerPath(section.newFileName);
  const isNew = section.oldFileName === "/dev/null" || (!oldPath && Boolean(newPath));
  const isDelete = section.newFileName === "/dev/null";
  const chosen = isDelete ? oldPath : newPath || oldPath;
  if (!chosen) {
    throw new PatchError("Patch section has no file path");
  }
  if (!isNew && !isDelete && oldPath && newPath && oldPath !== newPath) {
    throw new PatchError(
      `Renames are not supported in one patch (${oldPath} → ${newPath}); delete and add separately.`,
    );
  }
  return {
    path: normalizeProjectPath(chosen),
    isNew,
    isDelete,
  };
}

/**
 * Parse a multi-file unified diff. Hunk-only patches are accepted when the
 * caller supplies the target path; full patches carry their own headers.
 */
export function parseUnifiedPatch(
  patchText: string,
  fallbackPath?: string,
): UnifiedPatchFile[] {
  if (!patchText.trim()) throw new PatchError("Patch is empty");
  let sections: StructuredPatch[];
  try {
    sections = parsePatch(patchText);
  } catch (error) {
    throw new PatchError(
      `Could not parse patch: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const useFallback =
    Boolean(fallbackPath) && !/^---\s/m.test(patchText);
  const files: UnifiedPatchFile[] = [];
  for (const section of sections) {
    if (!section.hunks || section.hunks.length === 0) continue;
    if (useFallback && !section.oldFileName && !section.newFileName) {
      files.push({
        path: normalizeProjectPath(fallbackPath ?? ""),
        patch: section,
        isNew: false,
        isDelete: false,
      });
      continue;
    }
    const meta = sectionPath(section);
    files.push({ ...meta, patch: section });
  }
  if (files.length === 0) {
    throw new PatchError("Patch contains no file hunks");
  }
  if (useFallback && files.length > 1) {
    throw new PatchError(
      "A path argument can only be used with a single-file patch; omit it for multi-file diffs.",
    );
  }
  return files;
}

/** Apply one parsed file section to an in-memory source string. */
export function applyUnifiedPatchFile(
  source: string,
  file: UnifiedPatchFile,
): string | null {
  if (file.isDelete) {
    const deleted = applyPatch(source, file.patch, { fuzzFactor: 1 });
    if (deleted === false) {
      throw new PatchError(
        `Patch does not apply to ${file.path}; the file may have changed. Re-read it and regenerate the diff.`,
      );
    }
    return null;
  }
  const patched = applyPatch(file.isNew ? "" : source, file.patch, {
    fuzzFactor: 1,
  });
  if (patched === false) {
    throw new PatchError(
      `Patch does not apply to ${file.path}; the file may have changed. Re-read it and regenerate the diff.`,
    );
  }
  return patched;
}

/** Apply a unified diff to one known file without touching disk. */
export function applyUnifiedPatchText(
  source: string,
  patchText: string,
  path: string,
): string | null {
  const files = parseUnifiedPatch(patchText, path);
  if (files.length !== 1) {
    throw new PatchError("Expected a single-file patch");
  }
  return applyUnifiedPatchFile(source, files[0] as UnifiedPatchFile);
}
