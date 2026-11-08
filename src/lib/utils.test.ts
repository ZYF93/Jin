import { describe, expect, it } from "vite-plus/test";
import type { ArchDiff, RiskHint } from "../../shared/arch/diff";
import { translate, type Language } from "../../shared/i18n";
import {
  localizeCheckDetail,
  localizeCheckName,
  localizeEvidence,
  localizeReuseReason,
  localizeReuseSummary,
  riskText,
} from "./utils";

function translator(language: Language) {
  return (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
    translate(language, key, params);
}

function diff(patch: Partial<ArchDiff> = {}): ArchDiff {
  return {
    nodes: {},
    edges: {},
    colors: {},
    summary: { added: 0, removed: 0, modified: 0, affected: 0 },
    ...patch,
  };
}

const removalRisk: RiskHint = {
  id: "risk:removals",
  level: "high",
  title: "2 nodes removed",
  detail: "stored english detail",
};

describe("riskText", () => {
  it("uses structured risk ids and diff counts in both languages", () => {
    const graphDiff = diff({ summary: { added: 0, removed: 2, modified: 0, affected: 2 } });

    expect(riskText(removalRisk, graphDiff, translator("zh"))).toEqual({
      title: "移除了 2 个节点",
      detail: "移除架构节点也会移除它们的包含/依赖边。请确认代码及其调用方会一起退役。",
    });
    expect(riskText(removalRisk, graphDiff, translator("en")).title).toBe(
      "2 nodes removed",
    );
  });

  it("keeps unknown future hints readable", () => {
    const future: RiskHint = {
      id: "risk:future",
      level: "low",
      title: "Future risk",
      detail: "Future detail",
    };
    expect(riskText(future, diff(), translator("zh"))).toEqual({
      title: "Future risk",
      detail: "Future detail",
    });
  });
});

describe("localizeReuse", () => {
  it("translates generated reuse summaries and reasons", () => {
    expect(
      localizeReuseSummary(
        "Found 2 existing units worth reusing before writing new code.",
        translator("zh"),
      ),
    ).toBe("发现 2 个可复用的现有单元，写新代码前应先考虑。");
    expect(
      localizeReuseSummary(
        "No close existing implementation found; new code may be justified, but explain why reuse is not possible.",
        translator("zh"),
      ),
    ).toBe("未找到接近的现有实现；新增代码可能是合理的，但需要说明为什么无法复用。");
    expect(
      localizeReuseReason("Matches parser, token in the scanned source.", translator("zh")),
    ).toBe("与扫描源码中的 parser, token 匹配。");
  });

  it("keeps source-authored responsibilities verbatim", () => {
    expect(localizeReuseReason("Parses the WAL format.", translator("zh"))).toBe(
      "Parses the WAL format.",
    );
  });
});

describe("localizeCheckDetail", () => {
  it("translates reuse-guard checks", () => {
    expect(
      localizeCheckDetail(
        "No close reuse candidate was found; new code is allowed.",
        translator("zh"),
      ),
    ).toBe("未找到接近的复用候选；允许新增代码。");
    expect(
      localizeCheckDetail(
        "Reused or updated candidate file(s): src/a.ts, src/b.ts.",
        translator("zh"),
      ),
    ).toBe("已复用或更新候选文件：src/a.ts, src/b.ts。");
    expect(
      localizeCheckDetail(
        "ReusePlan listed 2 candidate(s) (src/a.ts, src/b.ts), but the implementation changed none. Verify that new code does not duplicate them.",
        translator("zh"),
      ),
    ).toBe(
      "复用计划列出了 2 个候选（src/a.ts, src/b.ts），但实现未改动其中任何文件。请确认新代码没有重复它们。",
    );
  });

  it("translates built-in check names but not script names", () => {
    expect(localizeCheckName("architecture conformance", translator("zh"))).toBe(
      "架构一致性",
    );
    expect(localizeCheckName("project checks", translator("zh"))).toBe("项目检查");
    expect(localizeCheckName("reuse", translator("zh"))).toBe("复用检查");
    expect(localizeCheckName("typecheck", translator("zh"))).toBe("typecheck");
  });

  it("translates a timed-out prefix and leaves command output alone", () => {
    expect(localizeCheckDetail("Timed out\nboom", translator("zh"))).toBe("超时\nboom");
    expect(localizeCheckDetail("error TS2322: type mismatch", translator("zh"))).toBe(
      "error TS2322: type mismatch",
    );
  });
});

describe("localizeEvidence", () => {
  it("translates persisted main-process evidence", () => {
    expect(
      localizeEvidence("Observed updated node fees at src/fees.ts", translator("zh")),
    ).toBe("已观察到更新后的节点 fees，位于 src/fees.ts");
    expect(localizeEvidence("Undeclared source node l1:new", translator("en"))).toBe(
      "Undeclared source node l1:new",
    );
  });

  it("leaves command output untouched", () => {
    expect(localizeEvidence("error TS2322: type mismatch", translator("zh"))).toBe(
      "error TS2322: type mismatch",
    );
    expect(localizeCheckDetail("Passed", translator("zh"))).toBe("通过");
    expect(localizeCheckDetail("command output", translator("zh"))).toBe("command output");
  });
});
