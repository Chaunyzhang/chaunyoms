import {
  PlannerActivationDecision,
  PlannerRuntimeSignals,
} from "./LLMPlannerTypes";

const PRECISION_FACT_RE = /(精确|准确|端口|路径|命令|日期|时间|数字|参数|配置|承诺|原话|原文|quote|exact|verbatim|path|port|command|date|number|parameter|config)/i;
const IMPLICIT_HISTORY_RE = /(刚才|之前|前面|上面|那个|这个|不是说过|记不记得|还记得|earlier|before|previous|that one|what was)/i;
const PROJECT_AMBIGUITY_RE = /(卡在哪|下一步|现在.*干啥|当前.*状态|项目.*状态|我们.*做|where.*left off|next step|blocker|blocked|project state)/i;
const CONFLICT_RE = /(冲突|不一样|覆盖|替代|修正|更正|为什么.*之前|conflict|supersede|different|correction)/i;
const MEMORY_WRITE_RE = /(记住|以后|别再|以后不要|以后都|偏好|原则|规则|remember|from now on|never again|always|preference)/i;
const DESTRUCTIVE_RE = /(wipe|restore|import|delete|reset|清空|恢复|导入|删除|重置)/i;
const HIGH_CONSTRAINT_RE = /(严格按文档|按文档严格|绝对干净|不要妥协|不妥协|打磨到最终形态|最终形态|strictly follow|no compromise|final shape|production-ready)/i;
const RUNTIME_DEBUG_RE = /(是不是.*问题|OMS.*问题|这是不是.*问题|排查|诊断|debug|diagnose|inspect|root cause|issue)/i;
const EXPLICIT_TOOL_RE = /^(oms_|memory_get\b|memory_status\b|memory_index\b|memory_promote\b|qa_|trace\b|expand\b|status\b|doctor\b)/i;
const ID_LOOKUP_RE = /\b(id|runId|summaryId|messageId|memoryId|atomId)\s*[:=]\s*[\w:-]+/i;

export class LLMPlannerActivationPolicy {
  decide(query: string, signals: PlannerRuntimeSignals): PlannerActivationDecision {
    const normalized = query.trim();
    const triggers: string[] = [];

    if (signals.llmPlannerMode === "off") {
      return {
        mode: "bypass",
        reason: "llmPlannerMode=off; use deterministic retrieval surfaces only.",
        llmInvoked: false,
        triggers: ["planner_disabled"],
      };
    }

    if (!normalized) {
      return {
        mode: "bypass",
        reason: "Empty query can be handled from recent/current context without planner work.",
        llmInvoked: false,
        triggers: ["empty_query"],
      };
    }


    if (EXPLICIT_TOOL_RE.test(normalized) || ID_LOOKUP_RE.test(normalized)) {
      return {
        mode: "deterministic_fast_path",
        reason: "Explicit tool/status/id lookup can use deterministic runtime tools without LLM planning.",
        llmInvoked: false,
        triggers: ["explicit_tool_or_id_lookup"],
      };
    }

    if (signals.retrievalStrength === "high" || signals.retrievalStrength === "xhigh") {
      triggers.push(`${signals.retrievalStrength}_requires_evidence_planning`);
    }
    if (PRECISION_FACT_RE.test(normalized)) {
      triggers.push("precision_fact_signal");
    }
    if (IMPLICIT_HISTORY_RE.test(normalized)) {
      triggers.push("implicit_history_reference");
    }
    if (PROJECT_AMBIGUITY_RE.test(normalized) || signals.referencesCurrentWork) {
      triggers.push("current_work_or_project_state");
    }
    if (CONFLICT_RE.test(normalized)) {
      triggers.push("conflict_or_supersede_risk");
    }
    if (MEMORY_WRITE_RE.test(normalized)) {
      triggers.push("possible_memory_write");
    }
    if (DESTRUCTIVE_RE.test(normalized)) {
      triggers.push("destructive_operation_risk");
    }
    if (HIGH_CONSTRAINT_RE.test(normalized)) {
      triggers.push("high_constraint_document_or_final_shape_request");
    }
    if (RUNTIME_DEBUG_RE.test(normalized)) {
      triggers.push("runtime_debug_or_root_cause_question");
    }
    if (signals.recentAssistantUncertainty) {
      triggers.push("recent_assistant_uncertainty");
    }
    if (signals.queryComplexity === "high") {
      triggers.push("high_query_complexity");
    }
    if (
      signals.hasCompactedHistory &&
      (signals.hasMemoryItemHits || signals.hasProjectRegistry) &&
      (IMPLICIT_HISTORY_RE.test(normalized) || PROJECT_AMBIGUITY_RE.test(normalized))
    ) {
      triggers.push("cross_layer_progressive_retrieval");
    }

    if (triggers.length > 0) {
      return {
        mode: "llm_planner",
        reason: `Planner required for ${[...new Set(triggers)].join(", ")}.`,
        llmInvoked: signals.hasLlmCaller && signals.llmPlannerMode === "auto",
        triggers: [...new Set(triggers)],
      };
    }

    return {
      mode: "bypass",
      reason: "No ambiguous, high-risk, cross-layer, or source-sensitive signal was detected; use deterministic recent/context route.",
      llmInvoked: false,
      triggers: ["low_risk_recent_context"],
    };
  }
}
