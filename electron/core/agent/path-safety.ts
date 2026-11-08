const BLOCKED_ROOTS = new Set([
  ".git",
  ".jin",
  "node_modules",
  "dist",
  "dist-electron",
  "release",
]);

/**
 * Normalize a project-relative path and reject anything that could escape the
 * workspace or touch Jin/Git/toolchain internals. Every staging layer and the
 * final writer use this rule, so a generated edit can never become a write the
 * approval-bound coder would refuse.
 */
export function normalizeProjectPath(relativePath: string): string {
  const clean = relativePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!clean || clean.includes("\0") || clean.startsWith("/") || /^[A-Za-z]:\//.test(clean)) {
    throw new Error(`Unsafe file path: ${relativePath}`);
  }
  const parts = clean.split("/");
  if (parts.some((part) => part === "..") || BLOCKED_ROOTS.has(parts[0] ?? "")) {
    throw new Error(`Refusing to write Jin/Git/toolchain path: ${relativePath}`);
  }
  return clean;
}

/** True when a path is safe to use as a project-relative write target. */
export function isProjectPath(relativePath: string): boolean {
  try {
    normalizeProjectPath(relativePath);
    return true;
  } catch {
    return false;
  }
}

export { BLOCKED_ROOTS };
