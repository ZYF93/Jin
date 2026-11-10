import { describe, expect, it } from "vite-plus/test";
import { validateAcceptanceResults } from "./acceptance";

describe("validateAcceptanceResults", () => {
  it("passes only when every approved criterion has evidence", () => {
    expect(
      validateAcceptanceResults(["adds reset", "preserves count"], {
        results: [
          { index: 0, status: "pass", evidence: "reset() sets count to zero" },
          { index: 1, status: "pass", evidence: "increment behavior is unchanged" },
        ],
      }),
    ).toMatchObject({ status: "pass" });
  });

  it("fails closed when results are missing, malformed, or fail a criterion", () => {
    expect(validateAcceptanceResults(["adds reset"], { results: [] }).status).toBe("fail");
    expect(
      validateAcceptanceResults(["adds reset"], {
        results: [{ index: 0, status: "pass", evidence: "" }],
      }).status,
    ).toBe("fail");
    expect(
      validateAcceptanceResults(["adds reset"], {
        results: [{ index: 0, status: "fail", evidence: "reset was not implemented" }],
      }).status,
    ).toBe("fail");
  });
});
