import { RawMessage } from "../types";

export interface ExtractedRuntimeMessage {
  sourceKey: string;
  id?: string;
  role: RawMessage["role"];
  content: unknown;
  text: string;
  timestamp?: number | string;
  metadata?: Record<string, unknown>;
}

export class OpenClawRuntimeMessageExtractor {
  extract(
    candidates: unknown[],
    extractTextFromContent: (content: unknown) => string,
  ): ExtractedRuntimeMessage[] {
    const messages = candidates.find((value) => Array.isArray(value));
    if (!Array.isArray(messages)) {
      return [];
    }

    const allowedRoles = new Set<RawMessage["role"]>(["system", "user", "assistant", "tool"]);
    const occurrenceCounts = new Map<string, number>();
    return messages
      .filter(
        (message): message is Record<string, unknown> =>
          Boolean(message) &&
          typeof message === "object" &&
          typeof message.role === "string" &&
          allowedRoles.has(message.role as RawMessage["role"]) &&
          "content" in message,
      )
      .map((message) => {
        const role = message.role as RawMessage["role"];
        const text = this.normalizeRuntimeMessageText(
          extractTextFromContent(message.content),
        );
        const occurrenceKey = `${role}:${this.normalizeWhitespace(text)}`;
        const occurrenceIndex = (occurrenceCounts.get(occurrenceKey) ?? 0) + 1;
        occurrenceCounts.set(occurrenceKey, occurrenceIndex);

        const mergedMetadata = this.mergeRuntimeMetadata(message);
        return {
          sourceKey: this.resolveRuntimeMessageSourceKey(
            message,
            role,
            text,
            occurrenceIndex,
          ),
          id:
            typeof message.id === "string" && message.id.trim().length > 0
              ? message.id
              : undefined,
          role,
          content: message.content,
          text,
          ...(Object.keys(mergedMetadata).length > 0
            ? { metadata: mergedMetadata }
            : {}),
          ...(typeof message.timestamp === "number"
            ? { timestamp: message.timestamp }
            : typeof message.createdAt === "string"
              ? { timestamp: message.createdAt }
              : {}),
        };
      });
  }

  private mergeRuntimeMetadata(
    message: Record<string, unknown>,
  ): Record<string, unknown> {
    const metadata: Record<string, unknown> =
      typeof message.metadata === "object" && message.metadata && !Array.isArray(message.metadata)
        ? { ...(message.metadata as Record<string, unknown>) }
        : {};

    const envelopeKeys = [
      "type",
      "kind",
      "origin",
      "source",
      "channel",
      "visibility",
      "name",
      "subtype",
      "internal",
      "hidden",
      "ephemeral",
      "controlPlane",
      "hostGenerated",
      "persist",
      "status",
    ] as const;

    for (const key of envelopeKeys) {
      const value = message[key];
      if (value !== undefined && metadata[key] === undefined) {
        metadata[key] = value;
      }
    }

    return metadata;
  }

  private resolveRuntimeMessageSourceKey(
    message: Record<string, unknown>,
    role: RawMessage["role"],
    text: string,
    occurrenceIndex: number,
  ): string {
    const explicitId =
      typeof message.id === "string" && message.id.trim().length > 0
        ? message.id.trim()
        : null;
    if (explicitId) {
      return `id:${explicitId}`;
    }

    return `derived:${role}:${occurrenceIndex}:${this.buildStableDigest(this.normalizeWhitespace(text))}`;
  }

  private buildStableDigest(text: string): string {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  private normalizeRuntimeMessageText(text: string): string {
    let normalized = text.trim();
    const metadataPrefix =
      /^(?:conversation|message)\s+info\s*\(untrusted metadata\):\s*```(?:json)?\s*[\s\S]*?```\s*/i;

    while (normalized.length > 0) {
      const stripped = normalized.replace(metadataPrefix, "").trim();
      if (stripped === normalized) {
        break;
      }
      normalized = stripped;
    }

    return normalized;
  }

  private normalizeWhitespace(text: string): string {
    return text.replace(/\s+/g, " ").trim();
  }
}
