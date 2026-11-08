export const VECTOR_DIMS = 384;

export function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Latin words plus individual CJK characters and CJK bigrams. The bigrams are
 * what make Chinese retrieval work without a dictionary tokenizer, both in
 * memory and in the FTS5 shadow table.
 */
export function tokenize(value: string): string[] {
  const lower = value.toLowerCase();
  const latin = lower.match(/[a-z_$][a-z0-9_$.-]*/g) ?? [];
  const cjk = lower.match(/[\u3400-\u9fff]/g) ?? [];
  const cjkBigrams: string[] = [];
  for (let index = 0; index < cjk.length - 1; index += 1) {
    cjkBigrams.push(`${cjk[index]}${cjk[index + 1]}`);
  }
  return [...latin, ...cjk, ...cjkBigrams].filter((term) => term.length > 1);
}

export function tokenMap(value: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const token of tokenize(value)) {
    map.set(token, (map.get(token) ?? 0) + 1);
  }
  return map;
}

/**
 * Feature-hashed bag-of-words vector. This is intentionally local and
 * deterministic: it gives the retriever a dense similarity signal without
 * requiring an embedding API or a model download. The vector is a derived
 * cache, never part of the architecture ledger.
 */
export function vectorize(tokens: Map<string, number>): Float32Array {
  const vector = new Float32Array(VECTOR_DIMS);
  for (const [term, count] of tokens) {
    const hash = fnv1a(term);
    const index = hash % VECTOR_DIMS;
    const sign = (hash & 0x80000000) === 0 ? 1 : -1;
    vector[index] += sign * Math.log1p(count);
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let index = 0; index < vector.length; index += 1) {
      vector[index] = (vector[index] ?? 0) / norm;
    }
  }
  return vector;
}

export function cosine(left: Float32Array, right: Float32Array): number {
  let score = 0;
  for (let index = 0; index < VECTOR_DIMS; index += 1) {
    score += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return score;
}

/** FTS5 query built from the same tokens used by the vector index. */
export function ftsQuery(value: string, limit = 24): string {
  const tokens = [...new Set(tokenize(value))]
    .filter((term) => term.length > 1)
    .slice(0, limit);
  return tokens.map((term) => `"${term.replace(/"/g, '""')}"`).join(" OR ");
}

export function vectorToBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
}

export function blobToVector(blob: Uint8Array): Float32Array {
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}
