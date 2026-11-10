import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  assertIntegrationBaselines,
  createImplementationWorkspace,
  disposeImplementationWorkspace,
  withProjectWriteLock,
} from "./workspace";

const roots: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "jin-workspace-test-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".jin", "cache"), { recursive: true });
  writeFileSync(join(root, "src", "counter.ts"), "export const count = 0;\n");
  writeFileSync(join(root, ".jin", "wal.jsonl"), "private ledger\n");
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("implementation workspace", () => {
  it("keeps agent edits private and excludes Jin's ledger", () => {
    const root = fixture();
    const workspace = createImplementationWorkspace(root);
    try {
      expect(existsSync(join(workspace, ".jin"))).toBe(false);
      writeFileSync(join(workspace, "src", "counter.ts"), "export const count = 1;\n");
      expect(readFileSync(join(root, "src", "counter.ts"), "utf8")).toContain("= 0");
    } finally {
      disposeImplementationWorkspace(workspace);
    }
  });

  it("serializes concurrent final integrations", async () => {
    const root = fixture();
    const order: number[] = [];
    const signal = new AbortController().signal;
    const first = withProjectWriteLock(root, signal, async () => {
      order.push(1);
      await new Promise((resolve) => setTimeout(resolve, 150));
      order.push(2);
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = withProjectWriteLock(root, signal, () => {
      order.push(3);
    });
    await Promise.all([first, second]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("rejects stale file baselines instead of overwriting another agent", () => {
    const edit = {
      path: "src/counter.ts",
      absolute: "/tmp/src/counter.ts",
      content: "export const count = 1;\n",
      originalExists: true,
      originalContent: "export const count = 0;\n",
    };
    expect(() =>
      assertIntegrationBaselines([edit], () => ({
        exists: true,
        content: "export const count = 2;\n",
      })),
    ).toThrow(/Implementation conflict.*src\/counter\.ts/);
  });
});
