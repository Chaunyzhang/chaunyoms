export interface TextEmbeddingProvider {
  readonly providerId: string;
  embed(text: string, dimensions: number): number[];
}

export class LocalHashEmbeddingProvider implements TextEmbeddingProvider {
  readonly providerId = "local_hash";

  embed(text: string, dimensions: number): number[] {
    const size = Math.max(Math.floor(dimensions), 16);
    const vector = new Array<number>(size).fill(0);
    const terms = tokenizeForEmbedding(text);
    if (terms.length === 0) {
      return vector;
    }
    for (const term of terms) {
      const index = positiveHash(term) % size;
      const sign = positiveHash(`sign:${term}`) % 2 === 0 ? 1 : -1;
      const weight = Math.min(Math.max(term.length / 6, 0.5), 2.5);
      vector[index] += sign * weight;
    }
    return normalizeVector(vector);
  }
}

export function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  if (length === 0) {
    return 0;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const l = Number.isFinite(left[index]) ? left[index] : 0;
    const r = Number.isFinite(right[index]) ? right[index] : 0;
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }
  if (leftNorm <= 0 || rightNorm <= 0) {
    return 0;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export function serializeVector(vector: number[]): string {
  return JSON.stringify(vector.map((value) => Number(value.toFixed(6))));
}

export function parseVector(value: unknown): number[] {
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry))
      : [];
  } catch {
    return [];
  }
}

export function tokenizeForEmbedding(text: string): string[] {
  const seen = new Set<string>();
  return text
    .toLowerCase()
    .replace(/^history\s+recall\s*:\s*/i, "")
    .split(/[^a-z0-9\u4e00-\u9fff]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)
    .filter((term) => {
      if (seen.has(term)) {
        return false;
      }
      seen.add(term);
      return true;
    });
}

function normalizeVector(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm <= 0) {
    return vector;
  }
  return vector.map((value) => value / norm);
}

function positiveHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
