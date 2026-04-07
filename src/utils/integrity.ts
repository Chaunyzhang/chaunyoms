import { createHash } from "node:crypto";

import { RawMessage } from "../types";

export function hashRawMessages(messages: RawMessage[]): string {
  const normalized = messages
    .map((message) =>
      JSON.stringify({
        id: message.id,
        turnNumber: message.turnNumber,
        role: message.role,
        content: message.content,
        tokenCount: message.tokenCount,
      }),
    )
    .join("\n");

  return createHash("sha256").update(normalized, "utf8").digest("hex");
}
