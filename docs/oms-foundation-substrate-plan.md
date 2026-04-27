# OMS Foundation Substrate Plan

本文是 `docs/统一接口.txt` 的下一阶段落地版。目标不是立刻建设 Graph、RAG、Embedding、Wiki 等上层设施，而是先把它们未来必须接入的 OMS 底座契约做好。

## 0. 当前项目实际与文档边界

这份文档必须同时尊重两件事：当前源码真实行为，以及我们下一阶段要去的目标形态。

当前项目实际：

- 默认配置已经是 `sqlitePrimaryEnabled=true`、`jsonPersistenceMode="off"`、`knowledgeMarkdownEnabled=true`、`agentVaultMirrorEnabled=false`。
- 当前运行主账本优先是 `SQLiteRuntimeStore`，并通过 typed repositories 持久化 `RawMessage`、`SummaryEntry`、`EvidenceAtomEntry`、`DurableMemoryEntry`、`KnowledgeRawEntry`、`ProjectRecord`、runtime records、source edges、context run audit。
- `KnowledgeMarkdownStore` 不是未来概念，而是当前默认启用的人类可读知识层，并且会同步到 SQLite asset index。
- `AgentVault` Markdown mirrors 是 legacy 可选镜像，默认关闭，不是当前主运行路径。
- JSON/JSONL stores 没有从源码中删除；它们仍作为 fallback repository 或显式 backup/export 路径存在，因此文档不能写成“JSON 已经彻底不存在”。
- 当前 trace 能力主要依赖 `SourceSpanRef`、`EvidenceBinding` 和 SQLite `source_edges`，还不是通用的 `OMSObject` / `OMSAnnotation` / `TraceEdge` 统一底座。
- 当前代码还没有正式落地通用 `PolicyEngine`、`ContextPacket`、`AnswerAuthorization`、`PluginManifest` 这些模块名对应的统一实现。

阅读规则：

- 本文后续凡是出现 `OMSObject`、`OMSAnnotation`、`PolicyEngine`、`ContextPacket`、`PluginManifest`，都应理解为**下一阶段目标契约**，不是对当前代码已实现状态的陈述。
- 本文如果描述未来结构，必须使用“目标形态”“下一阶段”“应当”“将要”这样的语气，不能写成当前既成事实。

## 1. 总原则

OMS 的下一阶段方向是：**一体母体，多维投影**。

目标形态下，SQLite 继续作为运行母体和主事实账本。KnowledgeMarkdownStore 保留为默认人类可读知识层；AgentVault Markdown mirrors 保持可选 legacy 镜像；JSON repository fallback 只作为兼容或显式导出路径存在。

目标形态下，所有对象、来源、状态、事件、关系和标注都围绕同一套 `object_id` 工作。Embedding、Graph、RAG、Wiki、Decay、Entity、Topic、Task Locality 都不是独立真相库，而是对象母体上的结构化标注、关系边、视图或可重建索引。

在目标底座里，下面这些内容会被统一收束：

- `raw_message` 是对象。
- `cleaned_segment` 是下一阶段对象。
- `level_1_substrate_summary` 是下一阶段对象。
- `evidence_atom` 是对象。
- `memory_record` 是对象。
- `knowledge_artifact` 是对象。
- `tool_event` 是下一阶段统一对象，当前仍以 runtime/audit records 为主。
- `context_packet` 是下一阶段统一对象，当前仍以 planner/runtime audit 记录为主。
- `embedding` 是 annotation。
- `rag_span` 是 annotation。
- `entity/topic` 是 annotation。
- `decay/task_locality` 是 annotation。
- `graph_relation` 是 edge。
- `source_trace` 是 edge。
- `conflict/supersede/support` 也是 edge。

任何未来插件都不能绕过 OMS 自己建事实库。插件可以生成对象、标注、边和事件；也可以维护可重建索引；但不能成为最终 source of truth。

## 2. 阶段 A：统一对象母体

目标：把现有 raw、summary、atom、memory、knowledge，以及已有 runtime records / tool audit / context planning audit，逐步纳入统一 `OMSObject` 协议。

任务：

- 定义 `OMSObject` 基础结构。
- 定义 `object_type` 枚举。
- 定义 namespace：`user`、`workspace`、`project`、`agent`、`session`、`task`。
- 强制区分 `object_id`、`canonical_key`、`source_ref`。
- 定义对象 lifecycle：`candidate`、`active`、`conflicted`、`superseded`、`expired`、`deleted`、`archived`。
- 定义对象 governance：`context_allowed`、`retrievable`、`long_term_allowed`、`deletable`、`user_editable`。
- 为现有 raw messages、summaries、evidence atoms、durable memories、knowledge assets 建立 object facade。
- 把当前 runtime records、tool audit、context run audit 也纳入统一对象映射。

不做：

- 不做真正 Graph。
- 不做真正 RAG。
- 不做向量检索。
- 不做 Wiki UI。
- 不做复杂本体。

验收：

- 任意核心数据都能说明自己是什么对象。
- 任意核心数据都有 `object_id`。
- 任意核心数据都有命名空间。
- 任意核心数据都有生命周期状态。
- 任意核心数据能说明是否可检索、是否可进入上下文、是否可长期保存。
- 任意核心数据能说明来源。
- 文档里不再把 `tool_event`、`context_packet` 写成已经存在的通用对象实现。

## 3. 阶段 B：来源、边和事件

目标：让所有派生内容都能被审计、回溯、纠错和重建。

任务：

- 定义 `SourceRef`。
- 定义 `TraceEdge`。
- 统一边类型：`derived_from`、`source_of`、`supports`、`conflicts_with`、`supersedes`、`duplicates`、`mentions`、`belongs_to`、`expanded_from`、`traced_to`。
- 建立 Event Log。
- 事件化关键动作：`write`、`compress`、`atomize`、`promote`、`retrieve`、`expand`、`trace`、`assemble_context`、`authorize_answer`、`correct`、`delete`。
- 每个事件必须有 `event_id`、`event_type`、`subject_object_id`、`actor`、`time`、`payload`、`request_id`。
- 建立 trace 校验：orphan edge、source hash mismatch、missing source refs、invalid target。

验收：

- 新接入的 substrate-style memory path 必须能回到 evidence atom 或明确的 source message/source summary。
- 任意 evidence atom 都能回到 summary 或 raw source span。
- 任意 summary 都能验证 source message count 和 source hash。
- 任意一次回答都能查到它用了哪些对象和策略。

## 4. 阶段 C：结构化标注系统

目标：把未来 embedding、graph、RAG、entity、topic、decay 的位置提前标准化，但不提前做重型能力。

任务：

- 定义 `OMSAnnotation`。
- annotation 必须包含 `annotation_id`、`target_object_id`、`annotation_type`、`provider`、`payload`、`target_hash`、`status`、`created_at`、`updated_at`。
- 首批 annotation type：`keyword`、`entity`、`topic`、`temporal`、`authority`、`decay`、`task_locality`、`rag_span`、`embedding_placeholder`。
- 允许性能专用表，但必须引用 `object_id` 和 `target_hash`。
- 标注必须可删除、可重建、可过期。
- 标注不能作为事实来源，只能作为检索、排序、过滤、展示或上下文组装的辅助信息。

验收：

- 删除 embedding/rag/entity/decay 标注不影响 raw/source trace。
- 原对象 hash 变化后，旧标注自动变 stale。
- 检索可以利用标注，但最终回答证据必须来自对象和 source refs。

## 5. 阶段 D：策略引擎

目标：把现在散落在代码里的规则收束成可审计、可测试、可替换的 policy。

任务：

- 定义 `PolicyRule`。
- 定义 `PolicyDecision`。
- 建立最小 `PolicyEngine`。
- 首批策略包括 `tool_result_policy`、`context_policy`、`promotion_policy`、`retrieval_policy`、`answer_policy`、`retention_policy`。

策略要求：

- `tool_result_policy`：工具结果默认 scratch only，压缩时删除 payload，只保留必要 source edge 或 derived fact。
- `context_policy`：最近尾巴按 5%-10% 保留，同时限制 1-10 轮和单消息 token cap。
- `promotion_policy`：只有稳定、重要、可追溯、可复用对象才能晋升长期记忆。
- `retrieval_policy`：先小对象，后摘要片段，最后原文 span。
- `answer_policy`：检索相关不等于回答授权；无证据、冲突、来源不足时拒答或要求 trace。
- `retention_policy`：过期、低价值、临时对象要能归档或清理。

验收：

- 每次上下文组装能解释是哪条 policy 让某对象进入或离开上下文。
- 每次拒答能解释是哪条 `answer_policy` 生效。
- 工具结果不会因为压缩进入长期记忆 payload。

## 6. 阶段 E：ContextPacket

目标：OMS 最终交给 Agent 的不是“记忆列表”，而是标准化上下文包。

任务：

- 定义 `ContextPacket`。
- 定义 `ContextItem`。
- 定义 omitted items。
- 记录 token budget：`fixed_prefix`、`recent_tail`、`working_state`、`long_term_memory`、`retrieval_atoms`、`summary_sections`、`source_spans`、`tool_context`、`output_reserve`。
- 每个 context item 必须有 `object_id`、`reason`、`priority`、`token_estimate`、`source_trace_available`。
- 记录 `context_packet_id` 和 `request_id`。

验收：

- 能回答一次请求的 token 花在哪里。
- 能回答某条记忆为什么进入上下文。
- 能回答某条摘要为什么没进入上下文。
- 能比较压缩前后 context packet 的差异。

## 7. 阶段 F：插件拓展坞协议

目标：未来任何插件都以 OMS 标准组件方式接入，而不是直接读写内部库。

任务：

- 定义 `PluginManifest`。
- 插件必须声明 `reads`、`writes`、`emits_events`、`subscribes_events`、`permissions`、`budgets`、`side_effects`、`rollback`。
- 插件只能读写 `OMSObject`、`OMSAnnotation`、`TraceEdge`、`Event`。
- 插件不能拥有独立事实库。
- 插件可以维护可重建索引，但索引必须能从 SQLite 母体重建。
- 高风险插件必须支持 dry-run。

验收：

- 新增一个 mock annotation plugin，不需要改核心数据库结构。
- 新增一个 mock retrieval provider，不需要绕过 `OMSObjectStore`。
- 插件输出都能 trace 到 `object_id` 或 `event_id`。

## 8. 阶段 G：最小评估与观测

目标：先建评测和观测底座，不用急着做大 dashboard。

任务：

- 记录 request trace。
- 记录 retrieval candidates。
- 记录 selected / discarded objects。
- 记录 context packet。
- 记录 answer authorization。
- 记录 latency 和 token cost。
- 建立最小 regression eval。

首批指标：

- source trace success rate
- answer grounding rate
- no-answer correctness
- exact constraint recall
- retrieval precision
- retrieval context tokens
- context assembly latency
- tool payload pollution rate
- stale/conflicted memory usage rate

验收：

- 任何一次测试失败都能定位到写入问题、检索问题、上下文组装问题、回答授权问题，还是模型最终回答问题。

## 9. 评测纪律与反作弊原则

OMS 项目禁止任何形式的测试作弊、题目定制优化和自欺欺人式指标提升。

评测的目标是验证系统是否真的具备可泛化的记忆、检索、回溯、上下文组装和回答授权能力，而不是让某一组测试题看起来通过。

禁止行为：

- 禁止针对某一道题、某一个 slug、某一个关键词、某一个测试文件做单独优化。
- 禁止把测试题答案、标准答案、题号、题面特征写进源码、prompt、fixture、配置或数据库。
- 禁止为了通过某个测试临时扩大 `top_k`、`N`、token budget、raw span 数量或检索范围。
- 禁止通过“多捞一点总能捞到”的方式伪装召回能力。
- 禁止把工具命中、候选命中、summary 命中直接当成最终正确率。
- 禁止只看 `memory_retrieve` 是否命中，而不看模型最终回答是否正确。
- 禁止为了某类测试修改排序规则，却不在通用测试集和负样本上验证副作用。
- 禁止在测试运行时手工注入、修补、改写数据库来制造通过结果。
- 禁止 eval-only 代码路径影响真实产品路径。
- 禁止使用隐藏的 hardcoded alias、magic keyword、special-case fallback。
- 禁止把负样本处理成“召回不到就随便猜一个最像的”。
- 禁止用更大的上下文、更大的检索范围、更慢的工具链掩盖底层切片、索引和排序问题。

允许行为：

- 可以优化通用 schema、通用切片、通用 annotation、通用 ranking、通用 policy。
- 可以调整默认 `top_k` 或 token budget，但必须作为产品级配置，并在完整回归集、负样本集、跨会话集上同时验证。
- 可以增加新检索信号，但必须解释它对所有同类问题的泛化价值。
- 可以新增测试集，但不能把答案泄漏到运行逻辑。
- 可以为诊断临时打开 debug，但 debug 路径不能进入生产默认行为。

评分原则：

- 精确度必须取决于模型最终回答，而不是工具调用是否命中。
- 工具结果只能作为证据链的一部分。
- 真正的评分对象是 final answer 是否回答了题目、答案正确、没有多编、没有错配相似对象、能在需要时给出 source trace、在无证据时能拒答、在冲突时能说明不确定或请求 trace。

每次评测必须保存：

- 测试集版本。
- 运行配置。
- 检索 `top_k`。
- token budget。
- context packet。
- 候选对象。
- 最终回答。
- 评分结果。
- 失败原因。

硬规则：

不能用更宽的召回来掩盖更差的精准度；不能用题目特化来伪装系统能力；不能用工具命中来替代模型最终回答。

## 10. 第三方参考隔离与源码洁净原则

OMS 可以参考公开论文、公开架构思想、开放标准和业界通用概念，但禁止把任何参考项目的源码、命名体系、文件结构、专有标识、测试样例或独特实现细节带入本项目源码。

禁止行为：

- 禁止复制任何参考项目源码片段。
- 禁止改写式搬运参考项目源码。
- 禁止保留参考项目的类名、函数名、变量名、文件名、目录名、注释、测试名或 prompt 名称。
- 禁止在源码、测试、fixture、prompt 模板、配置、日志格式、错误码中出现参考项目的专有名称。
- 禁止把参考项目的示例数据、测试数据、README 结构、配置结构原样搬进项目。
- 禁止使用“先复制再慢慢改”的方式搭建模块。
- 禁止让源码依赖某个参考项目的术语体系，除非该术语是行业通用标准。

允许行为：

- 可以吸收通用思想，例如 object model、provenance、event log、policy engine、context packet、plugin manifest。
- 可以参考开放标准的概念，例如 JSON Schema、OpenAPI、CloudEvents、W3C PROV、OpenTelemetry，但落地命名必须符合 OMS 自己的领域模型。
- 可以在文档中列出参考方向和设计启发，但源码必须保持独立命名和独立实现。
- 可以实现同类能力，但必须通过自己的接口、schema、测试和命名体系表达。

源码洁净检查：

- 模块名必须是 OMS 自己的概念。
- 类名和函数名必须来自本项目语义。
- 注释必须描述我们的设计，而不是复述参考项目。
- 测试数据必须由我们自己构造。
- 配置字段必须符合 OMS 命名。
- 不能有参考项目名称或专有术语泄漏。

如果某个参考项目名称必须出现，只能出现在 docs 的研究、评估或引用章节，不能出现在 `src`、`tests`、`fixtures`、`prompts`、runtime config 或默认用户可见输出中。

硬规则：

参考思想可以，复制源码不行；借鉴架构可以，继承命名不行；写进 docs 可以，泄漏进 src 不行。

## 11. 下一阶段完成标准

下一阶段完成，不以“功能看起来更多”为标准，而以“底座是否更稳”为标准。

必须满足：

- 新对象都能进入统一 `OMSObject` 协议。
- 派生信息都走 `OMSAnnotation` 或 `TraceEdge`。
- 插件不能绕过 OMS 母体写独立事实。
- 策略从业务代码中逐步收束到 `PolicyEngine`。
- 上下文组装能输出 `ContextPacket`。
- 回答前能产生 `AnswerAuthorization`。
- 测试不能包含题目特化逻辑。
- 源码不能出现参考项目源码或专有命名。
- 评测结果以模型最终回答为准。
- 任何召回扩大、预算扩大、`top_k` 调整都必须作为产品级策略接受完整回归验证。

这套地基完成后，再开始考虑真正接入 Embedding Provider、Graph Projection、RAG Projection、Wiki View 和更复杂的 Agentic Retrieval。
