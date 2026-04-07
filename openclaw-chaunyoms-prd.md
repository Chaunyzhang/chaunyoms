# OpenClaw ChaunyOMS PRD（当前完成版）

## 1. 背景

OpenClaw 原生已具备基础记忆与上下文能力，但在长会话下，仍可能出现：

- 上下文窗口被历史内容挤占
- 事实细节回溯不稳定
- 路由行为依赖提示词而不够确定

ChaunyOMS 的目标不是替代 OpenClaw 核心能力，而是在 `contextEngine` 层补齐“可压缩、可回源、可路由”的稳定行为。

## 2. 目标

- 保留原始消息作为唯一事实源。
- 超阈值时执行可控压缩，降低上下文成本。
- 将摘要作为索引与替身，而非事实本体。
- 对事实/参数/约束类问题强制回源。
- 兼容 OpenClaw 差异接口并可持续维护。

## 3. 当前已完成能力

### 3.1 引擎与生命周期

- 已注册 `contextEngine: chaunyoms`
- 已实现：`bootstrap / ingest / assemble / compact / afterTurn`

### 3.2 压缩与回源

- `freshTailTokens` 主控
- 阈值触发压缩
- `SummaryIndexStore` 持久化摘要
- `RecallResolver` 支持摘要到原文回溯

### 3.3 检索路由

- `MemoryRetrievalRouter` 路由到：
  - `recent_tail`
  - `navigation`
  - `dag`
  - `shared_insights`
  - `knowledge_base`
  - `vector_search`
- 事实类问题自动回源（auto recall）
- 返回 `details.retrievalHitType`（`route_hit/dag_recall/vector_retrieval/recent_tail`）

### 3.4 向量检索

- `vector_search` 已接入执行路径
- 优先尝试 OpenClaw runtime `memorySearch` 能力
- 不可用时降级到 `vector-store` 本地文件检索兜底

### 3.5 稳定前缀与导航

- Assemble 分层注入稳定前缀
- `LCM Recall Guidance` 在有 compacted summaries 时注入
- `afterTurn` 自动写导航快照到 `~/.openclaw/workspace/memory/`
- 导航保留策略：保留最近 30 轮文件

### 3.6 完整性与安全

- 启动时执行摘要完整性校验（source hash + message count）
- mismatch 告警，不阻断启动
- 提供 `openclaw.json` 自检/修复/恢复脚本

### 3.7 兼容工具名

- 主工具：
  - `memory_route`
  - `memory_retrieve`
  - `recall_detail`
- 兼容别名：
  - `lcm_describe` -> `memory_route`
  - `lcm_expand_query` -> `memory_retrieve`
  - `lcm_grep` -> `recall_detail`

## 4. 验证现状

已通过：

- `npm run build`
- `test:memory-router`
- `test:memory-retrieve-auto-recall`
- `test:stable-prefix`
- `test:compaction-integrity`
- `test:external-bootstrap`

## 5. 已知边界

- `OpenClawLlmCaller` 仍属于多入口兼容探测策略，需持续跟随上游 SDK 变化验证。
- 本地 `vector-store` 兜底检索为过渡方案，召回精度依赖索引质量。

## 6. 结论

ChaunyOMS 已从“原型”进入“可交付可联调”阶段：

- 核心路径可跑通
- 关键风险点（完整性、配置漂移、工具兼容）已有控制手段
- 可用于下一阶段真实会话压测与生产前收敛
