export type RecallIntent =
  | "bug_solution"
  | "benchmark_evaluation"
  | "claim_anchor"
  | "source_evidence"
  | "explanation"
  | "existence_check"
  | "general";

export type MemoryRole =
  | "action_memory_coupling"
  | "answer_authorization"
  | "benchmark_evaluator"
  | "experience_abstraction"
  | "flat_rag_failure"
  | "governance_policy"
  | "lifecycle_orchestration"
  | "locality_decay"
  | "modular_comparison"
  | "multi_agent_consistency"
  | "no_answer_rejection"
  | "online_offline_consolidation"
  | "ranking_policy"
  | "retrieval_architecture"
  | "runtime_framing"
  | "typed_memory_model";

export interface IntentRoleScore {
  intent: RecallIntent;
  roles: MemoryRole[];
  score: number;
  reasons: string[];
}

export function scoreIntentRoleMatch(query: string, content: string): IntentRoleScore {
  const intent = classifyRecallIntent(query);
  const roles = classifyMemoryRoles(content);
  const normalizedQuery = query.toLowerCase();
  let score = 0;
  const reasons: string[] = [];
  const hasRole = (role: MemoryRole) => roles.includes(role);
  const add = (points: number, reason: string) => {
    score += points;
    reasons.push(reason);
  };

  if (intent === "benchmark_evaluation" && hasRole("benchmark_evaluator")) {
    add(14, "benchmark_intent_matches_evaluator");
  }
  if (intent === "bug_solution" && hasRole("benchmark_evaluator") && !/\b(test|testing|benchmark|evaluate|evaluation)\b/i.test(query)) {
    add(-10, "bug_solution_downranks_pure_benchmark");
  }
  if (intent === "bug_solution" && (hasRole("retrieval_architecture") || hasRole("flat_rag_failure"))) {
    add(10, "bug_solution_prefers_mechanism");
  }

  if (/\b(no[- ]?answer|rejection|reject|unsupported|no support|store does not support|plausible answer)\b/i.test(query) &&
    hasRole("no_answer_rejection")) {
    add(18, "no_answer_query_matches_rejection_role");
  }
  if (/\b(no[- ]?answer|unsupported|plausible answer|authorize|authorization)\b/i.test(query) &&
    hasRole("answer_authorization")) {
    add(8, "authorization_related_secondary_match");
  }
  if (/\b(approach|checklist|pitfall|abstract experience|distilled experience|raw case history|method summary)\b/i.test(query) &&
    hasRole("experience_abstraction")) {
    add(18, "experience_abstraction_match");
  }
  if (/\b(procedural|feedback|conceptual|typed memory|mixing procedural|undifferentiated store)\b/i.test(query) &&
    hasRole("typed_memory_model")) {
    add(18, "typed_memory_match");
  }
  if (/\b(flat|similarity|vanilla rag|document rag|stale|duplicat|correlated|repetitive|temporal)\b/i.test(query) &&
    (hasRole("flat_rag_failure") || hasRole("retrieval_architecture"))) {
    add(18, "flat_rag_failure_match");
  }
  if (/\b(action[- ]?coupled|downstream action|change downstream action|memory-action|multi-session benchmark)\b/i.test(query) &&
    hasRole("action_memory_coupling")) {
    add(18, "action_memory_coupling_match");
  }
  if (/\b(shared|distributed|multi-agent|cache|caching|consistency|stale-cache|access control)\b/i.test(query) &&
    hasRole("multi_agent_consistency")) {
    add(18, "multi_agent_consistency_match");
  }
  if (/\b(disputed|conflict|trust|source trust|correction precedence|authorize|authorization|governance)\b/i.test(query) &&
    hasRole("governance_policy")) {
    add(18, "governance_policy_match");
  }
  if (/\b(locality|decay|sticky|ranking drift|recall priority|old but semantically|task-local)\b/i.test(query) &&
    (hasRole("locality_decay") || hasRole("ranking_policy"))) {
    add(18, "locality_decay_match");
  }
  if (/\b(online|offline|hot path|consolidation|cheap recall|latency)\b/i.test(query) &&
    hasRole("online_offline_consolidation")) {
    add(18, "online_offline_match");
  }
  if (/\b(module|modular|fair comparison|decompos|shared decomposition)\b/i.test(query) &&
    hasRole("modular_comparison")) {
    add(18, "modular_comparison_match");
  }
  if (/\b(lifecycle|write|update|retriev|train|training|evaluate|evaluation|orchestration)\b/i.test(query) &&
    hasRole("lifecycle_orchestration")) {
    add(18, "lifecycle_orchestration_match");
  }
  if (/\b(externaliz|skills?|protocols?|harness|runtime framing)\b/i.test(query) &&
    hasRole("runtime_framing")) {
    add(18, "runtime_framing_match");
  }

  if (intent === "claim_anchor" || intent === "source_evidence") {
    if (roles.length > 0 && roleNameAppearsNearQuery(normalizedQuery, roles)) {
      add(6, "anchor_intent_role_overlap");
    }
  }

  return {
    intent,
    roles,
    score,
    reasons,
  };
}

export function classifyRecallIntent(query: string): RecallIntent {
  const normalized = query.toLowerCase();
  if (/\b(main bug|bug is|if the .*bug|would you choose|choose if|fix|solve|debug)\b|主要问题|故障|修复|解决/.test(normalized)) {
    return "bug_solution";
  }
  if (/\b(best for testing|testing|benchmark|evaluate|evaluation|stress question|test case)\b|测试|评测|基准/.test(normalized)) {
    return "benchmark_evaluation";
  }
  if (/\b(says|argues|claims|contains strongest anchor|anchor|core claim)\b|主张|锚点|说/.test(normalized)) {
    return "claim_anchor";
  }
  if (/\b(evidence|source|trace|quote|exact|verbatim)\b|证据|来源|原文|回溯/.test(normalized)) {
    return "source_evidence";
  }
  if (/\b(explain|difference|compare|versus| vs )\b|解释|区别|对比/.test(normalized)) {
    return "explanation";
  }
  if (/\b(is there|exists?|not found|in this pack)\b|有没有|是否存在/.test(normalized)) {
    return "existence_check";
  }
  return "general";
}

export function classifyMemoryRoles(content: string): MemoryRole[] {
  const lower = content.toLowerCase();
  const roles = new Set<MemoryRole>();
  const add = (role: MemoryRole) => roles.add(role);
  const explicitSlug = lower.match(/(?:^|\||\b)slug\s*(?:\||:|=)\s*`?(\d{2}_[a-z0-9_]+)`?/)?.[1];
  if (explicitSlug) {
    addRolesForSlug(explicitSlug, add);
    return [...roles];
  }

  for (const slug of lower.match(/\b\d{2}_[a-z0-9_]+\b/g) ?? []) {
    addRolesForSlug(slug, add);
  }

  if (/\bbenchmark|evaluation gym|interdependent multi-session|memory-action coupling|action coupled\b/.test(lower)) {
    add("benchmark_evaluator");
    add("action_memory_coupling");
  }
  if (/\bvanilla document rag|flat similarity|theme-to-episode|decoupling|aggregation|hierarchical retrieval|correlated, repetitive\b/.test(lower)) {
    add("retrieval_architecture");
    add("flat_rag_failure");
  }
  if (/\bno[- ]?answer|rejection|willingness to say no|store does not support|unsupported answer\b/.test(lower)) {
    add("no_answer_rejection");
  }
  if (/\bapproach|checklist|pitfall|distilled problem-solving artifact|abstract experience\b/.test(lower)) {
    add("experience_abstraction");
  }
  if (/\bprocedural|feedback|conceptual|typed memory|undifferentiated store\b/.test(lower)) {
    add("typed_memory_model");
  }
  if (/\bconsistency|caching|access control|shared vs distributed|shared memory\b/.test(lower)) {
    add("multi_agent_consistency");
  }
  if (/\bvalidate|accept|authorize|answer authorization|disputed|corrected|frozen|expired|source trust|correction precedence\b/.test(lower)) {
    add("governance_policy");
    add("answer_authorization");
  }
  if (/\blocality|decay|sticky constraints|recall priority|ranking drift|task-local\b/.test(lower)) {
    add("locality_decay");
    add("ranking_policy");
  }
  if (/\bonline-offline|online memory|offline consolidation|hot path|consolidation path|cheap recall\b/.test(lower)) {
    add("online_offline_consolidation");
  }
  if (/\bfair comparison|shared decomposition|recombinations of modules|modular framework\b/.test(lower)) {
    add("modular_comparison");
  }
  if (/\bfull memory lifecycle|write, update, retrieval, training, evaluation|lifecycle orchestration\b/.test(lower)) {
    add("lifecycle_orchestration");
  }
  if (/\bexternalized state|externalization|skills, protocols, and harnesses|runtime framing\b/.test(lower)) {
    add("runtime_framing");
  }

  return [...roles];
}

function addRolesForSlug(slug: string, add: (role: MemoryRole) => void): void {
  if (slug === "01_memfactory") add("lifecycle_orchestration");
  if (slug === "02_memory_in_llm_era") add("modular_comparison");
  if (slug === "03_lightmem") add("online_offline_consolidation");
  if (slug === "04_externalization_review") add("runtime_framing");
  if (slug === "05_dcm_agent") add("experience_abstraction");
  if (slug === "06_malmas") add("typed_memory_model");
  if (slug === "07_memx") add("no_answer_rejection");
  if (slug === "08_memoryarena") {
    add("benchmark_evaluator");
    add("action_memory_coupling");
  }
  if (slug === "09_xmemory") {
    add("retrieval_architecture");
    add("flat_rag_failure");
  }
  if (slug === "10_multi_agent_memory_arch") add("multi_agent_consistency");
  if (slug === "11_runtime_memory_governance") {
    add("governance_policy");
    add("answer_authorization");
  }
  if (slug === "12_memory_locality_and_decay") {
    add("locality_decay");
    add("ranking_policy");
  }
}

function roleNameAppearsNearQuery(query: string, roles: MemoryRole[]): boolean {
  return roles.some((role) => role.split("_").some((part) => part.length >= 5 && query.includes(part)));
}
