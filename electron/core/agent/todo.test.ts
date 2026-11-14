import { describe, expect, it } from "vite-plus/test";
import { TodoList } from "./todo";

describe("TodoList", () => {
  it("writes a clean list and enforces a single in-progress item", () => {
    const list = new TodoList();
    const text = list.write([
      { content: "a", status: "in_progress" },
      { content: "b", status: "in_progress" },
      { content: "c", status: "pending" },
    ]);
    expect(text).toContain("1. [~] a");
    expect(text).toContain("2. [ ] b"); // demoted: only one in_progress allowed
    expect(text).toContain("3. [ ] c");
  });

  it("tracks progress for the activity feed", () => {
    const list = new TodoList();
    list.write([
      { content: "a", status: "completed" },
      { content: "b", status: "in_progress" },
    ]);
    expect(list.progress()).toEqual({ done: 1, total: 2 });
    expect(list.summary()).toContain("1/2 done");
    expect(list.summary()).toContain("now: b");
  });

  it("drops malformed entries and empty content", () => {
    const list = new TodoList();
    expect(list.write([null, 42, { status: "pending" }, { content: "ok" }])).toContain("1. [ ] ok");
    expect(list.read()).toContain("ok");
  });
});
