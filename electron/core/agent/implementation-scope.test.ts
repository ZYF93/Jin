import { describe, expect, it } from "vite-plus/test";
import type { ArchNode, Intent } from "../../../shared/ledger/types";
import { emptySnapshot } from "../arch/snapshot";
import {
  formatFacetIntents,
  implementationScopePaths,
  independentImplementationTasks,
  intentsForScope,
} from "./implementation-scope";

const node: ArchNode = {
  id: "service-id",
  level: "L1",
  kind: "service",
  parentId: null,
  name: "Agents service",
  path: "shared/agents.ts",
  file: "shared/agents.ts",
  symbol: "",
  responsibility: "Agent configuration types.",
  intentId: null,
  status: "active",
  metadata: {},
  introducedIn: "v1",
  updatedIn: "v1",
  lastTouchedIn: null,
};

const intent: Intent = {
  id: "intent-id",
  versionId: "version-id",
  title: "Update agent configuration",
  goal: "Add an agent setting.",
  tasks: [
    {
      id: "task-id",
      title: "Update types",
      status: "pending",
      dependsOn: [],
      acceptance: ["The type exposes enabled"],
      files: ["shared/agents.ts", "shared/agents.test.ts"],
    },
  ],
  nodeIntents: [
    { nodeId: node.id, statement: "Update the agent config type.", invariants: [], acceptance: [] },
  ],
  author: { id: "actor", kind: "user", name: "Tester", email: "" },
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("implementationScopePaths", () => {
  it("authorizes proposed source files and their conventional test companions only", () => {
    const snapshot = { ...emptySnapshot(), nodes: { [node.id]: node } };
    const paths = implementationScopePaths(intent, [], [], snapshot);
    expect(paths.has("shared/agents.ts")).toBe(true);
    expect(paths.has("shared/agents.test.ts")).toBe(true);
    expect(paths.has("shared/__tests__/agents.test.ts")).toBe(true);
    expect(paths.has("electron/main.ts")).toBe(false);
  });

  it("splits only fully scoped, dependency-free tasks with disjoint file ownership", () => {
    const tasks = [
      {
        id: "a",
        title: "A",
        status: "pending" as const,
        dependsOn: [],
        acceptance: ["A works"],
        files: ["src/a.ts"],
      },
      {
        id: "b",
        title: "B",
        status: "pending" as const,
        dependsOn: [],
        acceptance: ["B works"],
        files: ["src/b.ts"],
      },
    ];
    expect(independentImplementationTasks(tasks)).toEqual(tasks);
    expect(
      independentImplementationTasks([{ ...tasks[1]!, files: ["src/a.test.ts"] }, tasks[0]!]),
    ).toBeNull();
    expect(
      independentImplementationTasks([{ ...tasks[0]!, dependsOn: ["b"] }, tasks[1]!]),
    ).toBeNull();
    expect(independentImplementationTasks([{ ...tasks[0]!, files: [] }, tasks[1]!])).toBeNull();
  });
});

describe("intentsForScope / formatFacetIntents", () => {
  const facet: ArchNode = {
    ...node,
    id: "reset-facet",
    level: "facet",
    kind: "method",
    parentId: node.id,
    name: "reset()",
    file: "shared/agents.ts",
  };
  const other: ArchNode = {
    ...node,
    id: "other-service",
    name: "Other service",
    file: "shared/other.ts",
  };
  const snapshot = {
    ...emptySnapshot(),
    nodes: { [node.id]: node, [facet.id]: facet, [other.id]: other },
  };
  const nodeIntents = [
    {
      nodeId: node.id,
      facetId: facet.id,
      statement: "reset clears state",
      invariants: ["idempotent"],
      acceptance: ["reset twice is safe"],
    },
    { nodeId: other.id, statement: "other change", invariants: [], acceptance: [] },
  ];

  it("keeps every intent when the scope is null (single worker)", () => {
    expect(intentsForScope(nodeIntents, null, snapshot)).toHaveLength(2);
  });

  it("filters intents to the worker's file scope", () => {
    const scope = new Set(["shared/agents.ts"]);
    const kept = intentsForScope(nodeIntents, scope, snapshot);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.facetId).toBe(facet.id);
  });

  it("keeps an intent when its node has no file mapping", () => {
    const unmapped = { nodeId: "no-file-node", statement: "kept", invariants: [], acceptance: [] };
    const scope = new Set(["shared/agents.ts"]);
    expect(intentsForScope([unmapped], scope, snapshot)).toHaveLength(1);
  });

  it("renders a labelled facet block with invariants and acceptance", () => {
    const text = formatFacetIntents([nodeIntents[0]!], snapshot);
    expect(text).toContain("Agents service > reset()");
    expect(text).toContain("reset clears state");
    expect(text).toContain("invariant: idempotent");
    expect(text).toContain("acceptance: reset twice is safe");
  });

  it("returns an empty string for no intents", () => {
    expect(formatFacetIntents([], snapshot)).toBe("");
  });
});
