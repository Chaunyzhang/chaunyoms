import { encode } from "gpt-tokenizer";

export function estimateTokens(value: string): number {
  if (!value) {
    return 0;
  }

  try {
    return encode(value).length;
  } catch {
    return Math.ceil(value.length / 4);
  }
}
