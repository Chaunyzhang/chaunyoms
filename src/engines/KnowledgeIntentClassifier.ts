import { BridgeConfig, LlmCaller, LoggerLike } from "../types";
import {
  detectKnowledgeIntentPhrase,
  hasKnowledgeIntentCue,
  KnowledgeIntentSignal,
} from "../utils/knowledgeIntent";

export class KnowledgeIntentClassifier {
  constructor(
    private readonly llmCaller: LlmCaller | null,
    private readonly logger: LoggerLike,
  ) {}

  async classifyUserMessage(
    content: string,
    config: Pick<BridgeConfig, "knowledgeIntakeUserOverrideEnabled" | "emergencyBrake">,
  ): Promise<KnowledgeIntentSignal | null> {
    if (!config.knowledgeIntakeUserOverrideEnabled || config.emergencyBrake) {
      return null;
    }

    if (!hasKnowledgeIntentCue(content)) {
      this.logger.debug?.("knowledge_intent_classification_skipped", {
        reason: "no_write_intent_cue",
        contentLength: content.length,
      });
      return null;
    }

    if (!this.llmCaller) {
      return detectKnowledgeIntentPhrase(content);
    }

    const startedAt = Date.now();
    try {
      const signal = this.parseLlmSignal(await this.llmCaller.call({
        prompt: this.buildPrompt(content),
        temperature: 0,
        maxOutputTokens: 120,
        responseFormat: "json",
      }));
      if (signal) {
        const withTiming = {
          ...signal,
          latencyMs: Date.now() - startedAt,
        };
        this.logger.info("knowledge_intent_classified", {
          intent: withTiming.intent,
          confidence: withTiming.confidence,
          target: withTiming.target,
          latencyMs: withTiming.latencyMs,
        });
        return withTiming;
      }
    } catch (error) {
      this.logger.warn("knowledge_intent_llm_classification_failed", {
        error: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - startedAt,
      });
    }

    return detectKnowledgeIntentPhrase(content);
  }

  private buildPrompt(content: string): string {
    return [
      "Classify whether the user is explicitly asking the assistant to store the current content as long-term knowledge.",
      "Return strict JSON only.",
      "",
      "Schema:",
      "{\"intent\":\"promote_to_knowledge|none\",\"confidence\":0-1,\"reason\":\"short\",\"target\":\"knowledge_base|wiki|memory|unspecified\"}",
      "",
      "Rules:",
      "- Use promote_to_knowledge only for an explicit user instruction to remember, save, write to wiki, or put into a knowledge base.",
      "- Use none when the user is only discussing knowledge-base design, asking a question, or mentioning the concept.",
      "- Do not classify assistant/tool/system text as user intent.",
      "",
      "User message:",
      content.slice(0, 4000),
    ].join("\n");
  }

  private parseLlmSignal(raw: string): KnowledgeIntentSignal | null {
    const parsed = this.parseJsonObject(raw);
    if (!parsed) {
      return null;
    }
    const intent = parsed.intent === "promote_to_knowledge" ? "promote_to_knowledge" : "none";
    const confidence = typeof parsed.confidence === "number"
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0;
    const target = this.normalizeTarget(parsed.target);
    if (intent !== "promote_to_knowledge" || confidence < 0.5) {
      return {
        intent: "none",
        confidence,
        reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 160) : "llm_classified_no_explicit_write_intent",
        target,
        classifier: "llm",
      };
    }
    return {
      intent,
      confidence,
      reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 160) : "llm_detected_explicit_write_intent",
      target,
      classifier: "llm",
    };
  }

  private parseJsonObject(raw: string): Record<string, unknown> | null {
    try {
      const direct = JSON.parse(raw);
      return direct && typeof direct === "object" && !Array.isArray(direct)
        ? direct as Record<string, unknown>
        : null;
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) {
        return null;
      }
      try {
        const extracted = JSON.parse(match[0]);
        return extracted && typeof extracted === "object" && !Array.isArray(extracted)
          ? extracted as Record<string, unknown>
          : null;
      } catch {
        return null;
      }
    }
  }

  private normalizeTarget(value: unknown): KnowledgeIntentSignal["target"] {
    if (value === "knowledge_base" || value === "wiki" || value === "memory") {
      return value;
    }
    return "unspecified";
  }
}
