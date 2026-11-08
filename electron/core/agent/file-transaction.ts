import { existsSync, unlinkSync } from "node:fs";

export interface StagedFileEdit {
  path: string;
  absolute: string;
  content: string | null;
  originalExists: boolean;
  originalContent: string;
}

/** Apply a prevalidated file batch and restore its committed prefix on failure. */
export function commitFileTransaction(
  edits: readonly StagedFileEdit[],
  options: {
    writeAtomic: (absolute: string, content: string) => void;
    checkCancelled?: () => void;
  },
): void {
  const committed: StagedFileEdit[] = [];
  try {
    for (const edit of edits) {
      options.checkCancelled?.();
      if (edit.content === null) {
        if (existsSync(edit.absolute)) unlinkSync(edit.absolute);
      } else {
        options.writeAtomic(edit.absolute, edit.content);
      }
      committed.push(edit);
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const edit of committed.reverse()) {
      try {
        if (edit.originalExists) {
          options.writeAtomic(edit.absolute, edit.originalContent);
        } else if (existsSync(edit.absolute)) {
          unlinkSync(edit.absolute);
        }
      } catch (rollbackError) {
        rollbackErrors.push(
          `${edit.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
    }
    if (rollbackErrors.length > 0) {
      const failure = new Error(
        `File transaction failed and rollback was incomplete: ${rollbackErrors.join("; ")}`,
      );
      Object.assign(failure, { cause: error });
      throw failure;
    }
    throw error;
  }
}
