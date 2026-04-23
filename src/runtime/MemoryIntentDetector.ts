import { MemoryIntent, ObservationEntry, RawMessage } from "../types";

export interface MemoryIntentDecision {
  intent: MemoryIntent;
  confidence: number;
  trigger?: string;
}

const EXPLICIT_REMEMBER_PATTERNS = [
  /帮我记一下/i,
  /记一下这个/i,
  /记住这个/i,
  /记住这点/i,
  /不要忘了/i,
  /后面会用到/i,
  /\bremember this\b/i,
  /\bplease remember\b/i,
  /\bnote this\b/i,
];

const TEMPORARY_PATTERNS = [
  /等下/i,
  /待会/i,
  /这轮/i,
  /今天先/i,
  /稍后/i,
  /once this turn/i,
  /later today/i,
  /for this turn/i,
  /\bremind me\b/i,
];

const PREFERENCE_PATTERNS = [
  /以后/i,
  /默认/i,
  /习惯/i,
  /偏好/i,
  /请一直/i,
  /\bprefer\b/i,
  /\bdefault to\b/i,
  /\balways\b/i,
];

const PROJECT_PATTERNS = [
  /项目/i,
  /仓库/i,
  /代码库/i,
  /接口/i,
  /配置/i,
  /架构/i,
  /workflow/i,
  /repo/i,
  /project/i,
  /workspace/i,
  /build/i,
];

export class MemoryIntentDetector {
  inspectRawMessage(message: RawMessage): MemoryIntentDecision {
    return this.inspectText(message.content, message.role);
  }

  inspectObservation(observation: ObservationEntry): MemoryIntentDecision {
    return this.inspectText(observation.content, observation.role);
  }

  private inspectText(text: string, role: RawMessage["role"]): MemoryIntentDecision {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) {
      return { intent: "none", confidence: 0 };
    }

    const explicit = EXPLICIT_REMEMBER_PATTERNS.find((pattern) => pattern.test(normalized));
    if (explicit && role === "user") {
      if (TEMPORARY_PATTERNS.some((pattern) => pattern.test(normalized))) {
        return {
          intent: "temporary_remember",
          confidence: 0.96,
          trigger: explicit.source,
        };
      }

      if (PROJECT_PATTERNS.some((pattern) => pattern.test(normalized))) {
        return {
          intent: "project_memory",
          confidence: 0.94,
          trigger: explicit.source,
        };
      }

      if (PREFERENCE_PATTERNS.some((pattern) => pattern.test(normalized))) {
        return {
          intent: "preference_memory",
          confidence: 0.92,
          trigger: explicit.source,
        };
      }

      return {
        intent: "explicit_remember",
        confidence: 0.9,
        trigger: explicit.source,
      };
    }

    if (role === "user" && PREFERENCE_PATTERNS.some((pattern) => pattern.test(normalized))) {
      return { intent: "preference_memory", confidence: 0.68 };
    }

    if (role === "user" && PROJECT_PATTERNS.some((pattern) => pattern.test(normalized))) {
      return { intent: "project_memory", confidence: 0.6 };
    }

    return { intent: "none", confidence: 0 };
  }
}
