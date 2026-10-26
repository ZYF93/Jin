import { describe, expect, it } from "vite-plus/test";
import { isUlid, ulid, ulidTime } from "./ulid";

describe("ulid", () => {
  it("generates canonical 26-character ids in time order", () => {
    const earlier = ulid(1_700_000_000_000);
    const later = ulid(1_700_000_001_000);
    expect(earlier).toHaveLength(26);
    expect(isUlid(earlier)).toBe(true);
    expect(earlier < later).toBe(true);
    expect(ulidTime(earlier)).toBe(1_700_000_000_000);
  });

  it("rejects malformed ids", () => {
    expect(isUlid("not-a-ulid")).toBe(false);
    expect(() => ulidTime("not-a-ulid")).toThrow();
  });
});
