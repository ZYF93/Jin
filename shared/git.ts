/**
 * Conservative branch-name gate shared by the Git service and the renderer.
 * Git accepts more characters than this, but rejecting whitespace, control
 * characters, `..`, `@{`, and leading `-` keeps names safe as argv entries and
 * portable across Windows/macOS checkouts.
 */
export function isValidBranchName(value: string): boolean {
  const name = value.trim();
  if (!name || name.length > 255) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)) return false;
  if (name.includes("..") || name.includes("//") || name.includes("@{")) return false;
  if (name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock")) return false;
  return name
    .split("/")
    .every(
      (part) =>
        part.length > 0 &&
        !part.startsWith(".") &&
        !part.endsWith(".lock"),
    );
}
