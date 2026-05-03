import { ChaunyomsRetrievalService } from "../runtime/ChaunyomsRetrievalService";
import { ContextItem } from "../types";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const service = Object.create(ChaunyomsRetrievalService.prototype) as {
    formatRecallText(
      query: string,
      items: ContextItem[],
      sourceTrace: Array<{ summaryId?: string; strategy: string; verified: boolean; resolvedMessageCount: number }>,
      answerCandidates: Array<unknown>,
      presentation: { maxItems: number; maxCharsPerItem: number; includeFullTrace: boolean },
      evidenceGate: { status: string; reason: string; atomHitCount: number; usableAtomCount: number; verifiedTraceCount: number; recommendedAction: string; targetIds: string[] },
      diagnostics?: Record<string, unknown>,
      summaryEvidence?: Array<{
        summaryId: string;
        summary: string;
        summaryLevel?: number;
        nodeKind?: string;
        startTurn?: number;
        endTurn?: number;
      }>,
      rawEvidenceMessages?: Array<{
        id: string;
        sessionId: string;
        turnNumber: number;
        role: string;
        content: string;
        isCenter?: boolean;
        sourceVerified?: boolean;
      }>,
    ): string;
  };

  const items: ContextItem[] = [{
    kind: "message",
    tokenCount: 40,
    turnNumber: 10,
    role: "user",
    content: "Please remember these exact setup facts for later: GATEWAY_PORT is 4319 TOKEN_ALIAS is red-fox.",
    metadata: {
      messageId: "m-gateway",
      sourceSummaryId: "summary-setup",
      sourceVerified: true,
    },
  }];

  const text = service.formatRecallText(
    "What is the current blocker, what is the gateway port, and what is the token alias?",
    items,
    [{ summaryId: "summary-setup", strategy: "message_ids", verified: true, resolvedMessageCount: 1 }],
    [],
    {
      maxItems: 4,
      maxCharsPerItem: 400,
      includeFullTrace: false,
    },
    {
      status: "sufficient",
      reason: "test",
      atomHitCount: 0,
      usableAtomCount: 0,
      verifiedTraceCount: 1,
      recommendedAction: "answer",
      targetIds: ["summary:summary-setup", "message:m-gateway"],
    },
    {},
    [{
      summaryId: "summary-setup",
      summary: "Setup facts summary: GATEWAY_PORT=4319 and TOKEN_ALIAS=red-fox.",
      summaryLevel: 1,
      nodeKind: "leaf",
      startTurn: 10,
      endTurn: 10,
    }],
    [{
      id: "m-gateway",
      sessionId: "session-1",
      turnNumber: 10,
      role: "user",
      content: "Please remember these exact setup facts for later: GATEWAY_PORT is 4319 TOKEN_ALIAS is red-fox.",
      isCenter: true,
      sourceVerified: true,
    }],
  );

  assert(text.includes("#### gateway port"), "expected slot section for gateway port");
  assert(text.includes("#### token alias"), "expected slot section for token alias");
  assert(text.includes("[summary summary-setup]"), "expected child summary evidence");
  assert(text.includes("[turn 10] user"), "expected raw source message evidence");
  assert(text.includes("source=verified_raw"), "expected raw evidence source label");

  console.log("test-retrieval-evidence-packet-slots passed");
}

void main();
