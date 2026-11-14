export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

const STATUSES: ReadonlySet<TodoStatus> = new Set(["pending", "in_progress", "completed"]);

export function isTodoStatus(value: unknown): value is TodoStatus {
  return typeof value === "string" && STATUSES.has(value as TodoStatus);
}

/**
 * The agent's visible task list for one implementation run. OpenCode calls it
 * `todowrite`; the model rewrites the whole list each time so the UI always has
 * a consistent snapshot. Exactly one item may be `in_progress`.
 */
export class TodoList {
  private items: TodoItem[] = [];

  /** Replace the list. Invalid entries are dropped; at most one in-progress. */
  write(items: unknown): string {
    const parsed: TodoItem[] = [];
    for (const entry of Array.isArray(items) ? items : []) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const content = typeof record.content === "string" ? record.content.trim() : "";
      if (!content) continue;
      parsed.push({
        content: content.slice(0, 200),
        status: isTodoStatus(record.status) ? record.status : "pending",
      });
      if (parsed.length >= 40) break;
    }
    let seenInProgress = false;
    for (const item of parsed) {
      if (item.status !== "in_progress") continue;
      if (seenInProgress) item.status = "pending";
      seenInProgress = true;
    }
    this.items = parsed;
    return this.render();
  }

  read(): string {
    return this.items.length > 0 ? this.render() : "No todos yet.";
  }

  progress(): { done: number; total: number } {
    const total = this.items.length;
    const done = this.items.filter((item) => item.status === "completed").length;
    return { done, total };
  }

  /** Compact single-line summary for the chat activity feed. */
  summary(): string {
    if (this.items.length === 0) return "todo list cleared";
    const { done, total } = this.progress();
    const current = this.items.find((item) => item.status === "in_progress");
    return `${done}/${total} done${current ? ` · now: ${current.content}` : ""}`;
  }

  private render(): string {
    return this.items
      .map((item, index) => {
        const mark =
          item.status === "completed" ? "[x]" : item.status === "in_progress" ? "[~]" : "[ ]";
        return `${index + 1}. ${mark} ${item.content}`;
      })
      .join("\n");
  }
}
