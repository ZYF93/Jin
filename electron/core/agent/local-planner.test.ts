import { describe, expect, it } from "vite-plus/test";
import type { ArchSnapshot } from "../../../shared/arch/types";
import { translate, type Language, type MessageKey, type TranslationParams } from "../../../shared/i18n";
import { emptySnapshot } from "../arch/snapshot";
import { localPlan } from "./local-planner";

function translator(language: Language) {
  return (key: MessageKey, params?: TranslationParams): string =>
    translate(language, key, params);
}

function rootSnapshot(): ArchSnapshot {
  const snapshot = emptySnapshot();
  snapshot.nodes["l0:system"] = {
    id: "l0:system",
    level: "L0",
    kind: "system",
    parentId: null,
    name: "Jin",
    path: "",
    file: "",
    symbol: "",
    responsibility: "Root system",
    intentId: null,
    status: "active",
    metadata: {},
    introducedIn: "v1",
    updatedIn: "v1",
    lastTouchedIn: null,
  };
  return snapshot;
}

describe("localPlan", () => {
  it("localizes deterministic add proposals", () => {
    const plan = localPlan(rootSnapshot(), "添加模块 Payments", translator("zh"));

    expect(plan.title).toBe("添加模块 Payments");
    expect(plan.tasks[0]?.title).toBe("在不重复现有单元的前提下添加并实现 Payments");
    expect(plan.assistantMessage).toBe(
      "已准备 Payments 的模块提案（L0）。写代码前会先展示差异。",
    );
  });

  it("localizes intent-only fallbacks", () => {
    const plan = localPlan(rootSnapshot(), "为什么 WAL 需要 fold？", translator("zh"));

    expect(plan.title).toBe("为什么 WAL 需要 fold？");
    expect(plan.tasks[0]?.title).toBe("澄清请求的变更，并在已批准架构内实现");
    expect(plan.assistantMessage).toContain("仅意图版本");
  });

  it("keeps English as the default deterministic planner language", () => {
    const plan = localPlan(rootSnapshot(), "Add module Billing");

    expect(plan.title).toBe("Add module Billing");
    expect(plan.assistantMessage).toContain("module proposal for Billing");
  });
});
