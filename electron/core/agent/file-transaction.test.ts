import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vite-plus/test";
import { commitFileTransaction } from "./file-transaction";

describe("commitFileTransaction", () => {
  it("restores earlier files when a later write fails", () => {
    const root = mkdtempSync(join(tmpdir(), "jin-file-transaction-"));
    try {
      const first = join(root, "first.ts");
      const second = join(root, "second.ts");
      writeFileSync(first, "before first", "utf8");
      writeFileSync(second, "before second", "utf8");
      let writes = 0;

      assert.throws(() =>
        commitFileTransaction(
          [
            {
              path: "first.ts",
              absolute: first,
              content: "after first",
              originalExists: true,
              originalContent: "before first",
            },
            {
              path: "second.ts",
              absolute: second,
              content: "after second",
              originalExists: true,
              originalContent: "before second",
            },
          ],
          {
            writeAtomic(absolute, content) {
              writes += 1;
              if (writes === 2) throw new Error("disk full");
              writeFileSync(absolute, content, "utf8");
            },
          },
        ),
      );

      assert.equal(readFileSync(first, "utf8"), "before first");
      assert.equal(readFileSync(second, "utf8"), "before second");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
