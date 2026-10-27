#!/usr/bin/env vpx
import { mergeWalFiles } from "../electron/core/wal/merge";

const [, , basePath, oursPath, theirsPath] = process.argv;

if (!basePath || !oursPath || !theirsPath) {
  console.error("usage: merge-wal <base> <ours> <theirs>");
  process.exit(2);
}

try {
  const result = mergeWalFiles(basePath, oursPath, theirsPath);
  const semantic = result.conflicts.filter((conflict) => conflict.code !== "stale-write");
  if (semantic.length > 0) {
    console.error(
      `Jin WAL merged with ${semantic.length} semantic conflict${semantic.length === 1 ? "" : "s"}; open Jin to resolve.`,
    );
    for (const conflict of semantic.slice(0, 10)) {
      console.error(`- ${conflict.code}: ${conflict.message}`);
    }
  }
  console.log(`Jin WAL merged: ${result.records.length} records.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
