import { describe, expect, it } from "vite-plus/test";
import { canonicalize, hashValue } from "./canonical";

describe("canonicalize", () => {
  it("sorts object keys recursively and preserves array order", () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    );
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
  });

  it("omits undefined object fields", () => {
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it("produces stable sha256 hashes", () => {
    expect(hashValue({ b: 1, a: 2 })).toBe(hashValue({ a: 2, b: 1 }));
    expect(hashValue({ a: 2 })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalize({ n: Number.POSITIVE_INFINITY })).toThrow();
  });
});
