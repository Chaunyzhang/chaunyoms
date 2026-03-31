# OpenClaw Lossless Lite 已完成版 PRD

> 基于当前已落地实现整理
> 目标是把“已经做好的东西”单独沉淀出来，作为当前版本的事实基准

## 1 背景与出发点

OpenClaw 原版已经提供了 `memory-core`、`memory_search`、`memory_get`、`contextEngine`、session transcript 和基础 compaction 能力，但在长会话场景里，主上下文仍然容易被历史内容挤满，导致 token 成本上升、旧信息回溯不稳定。

本插件的出发点不是重做 OpenClaw 的整套记忆系统，而是在不改 Core 的前提下，补一层轻量的、可维护的长会话上下文管理能力，让原始消息继续作为唯一真相源，同时把模型每轮看到的上下文压得更低。

## 2 目标

- 保留原始消息，不丢历史真相。
- 在超阈值时压缩旧消息，降低主 prompt token。
- 把摘要当成索引和替身，不当成第二份事实。
- 让需要细节时可以回到原始消息。
- 保持插件足够轻，适合个人长期维护。

## 3 当前实现状态

当前插件已经完成了可运行首版，并且已经被 OpenClaw 真实加载为 `contextEngine`。

已完成的部分包括：

- 插件工程脚手架、TypeScript 构建、`openclaw` 扩展声明。
- `RawMessageStore` 的本地持久化与读写。
- `SummaryIndexStore` 的摘要持久化与关键词检索。
- `ContextAssembler` 的预算分配与上下文装配。
- `CompactionEngine` 的阈值判断、摘要生成框架和压缩流程。
- `RecallResolver` 的摘要回原文回溯流程。
- `OpenClawBridge` 的生命周期接入。
- 本地测试脚本和构建验证。

当前状态更准确地说是：

- 已经从“方案”进入“可加载插件原型”。
- 已经从“空实现”进入“可联调实现”。
- 还没有进入“真实长期使用后的稳定版”。

## 4 STAR 视角

### 4.1 Situation

OpenClaw 一键部署版已经在用，但长会话时主上下文会越来越贵，旧信息回溯也会变得不稳定。原版记忆体系能帮忙，但它不是专门针对“session transcript 级别无损上下文管理”设计的。

### 4.2 Task

要做的是一个第三方插件，只替换 `contextEngine`，保留官方 `memory-core`，让插件负责：

- 保存原始消息索引。
- 超阈值压缩旧消息。
- 维护摘要索引。
- 按预算组装上下文。
- 支持从摘要回原文。

### 4.3 Action

当前实现已经落了这些动作：

- 建了独立插件工程 `lossless-lite`。
- 用 JSONL/JSON 存储原始消息和摘要索引。
- 把上下文分成 raw store、summary index、runtime context view 三类对象。
- 把生命周期拆成 `bootstrap / ingest / assemble / compact / afterTurn`。
- 把失败路径收敛成 recent-tail 降级。
- 按 OpenClaw 当前 SDK 结构完成了插件注册和 `contextEngine` 接入。

### 4.4 Result

结果是：

- 插件已经能被 OpenClaw 识别并加载。
- 构建链路通过。
- 核心模块有了最小闭环。
- 方案从概念阶段进入了真实运行阶段。

## 5 已完成模块

### 5.1 插件脚手架

- `package.json` 已配置 `build`、测试脚本和 `openclaw.extensions`。
- `tsconfig.json` 已配置 TypeScript 编译。
- `openclaw.plugin.json` 已声明插件元信息。
- `index.ts` 已导出插件入口。

### 5.2 原始消息存储

`RawMessageStore` 已实现：

- 启动加载历史数据。
- 追加保存原始消息。
- 按轮次范围读取。
- 获取最近 tail。
- 统计未压缩 token 总量。
- 标记指定范围消息为已压缩。

### 5.3 摘要索引

`SummaryIndexStore` 已实现：

- 摘要条目持久化。
- 摘要列表读取。
- 关键词检索。
- 摘要 token 总量统计。

### 5.4 压缩流程

`CompactionEngine` 已实现：

- 是否触发压缩的判断。
- 选择待压缩轮次。
- 生成摘要 prompt。
- 通过 OpenClaw 可用 LLM caller 调模型。
- JSON 解析失败后的重试和 fallback。
- 写入摘要索引并标记原始消息 compacted。

### 5.5 上下文装配

`ContextAssembler` 已实现：

- token 预算分配。
- recent tail 装配。
- summary 区装配。
- 上下文视图写入。

### 5.6 回溯解析

`RecallResolver` 已实现：

- 按 query 搜摘要。
- 根据命中摘要回原文范围。
- 在预算内截断返回。

### 5.7 桥接层

`OpenClawBridge` 已实现：

- `bootstrap`
- `ingest`
- `assemble`
- `compact`
- `afterTurn`

并且已经完成 OpenClaw 侧真实加载。

## 6 当前阶段

当前阶段可以定义为：

**首版插件原型已完成，进入真实联调与稳定化阶段。**

不是“概念验证”，因为代码已经跑起来了。
不是“稳定生产版”，因为还有一些接口和运行期细节需要在真实会话中继续校准。

## 7 当前卡点

- `recall_detail` 工具还没有按最终 SDK 方式重新接回去。
- 真实会话里的 `AgentMessage` 和插件 payload 还需要继续对齐。
- 还没有用真实模型 key 做完整端到端摘要调用验证。
- 长会话、多轮 compaction、真实回溯的行为还需要继续观察。

## 8 验收现状

已通过的验证：

- `npm run build`
- `test:raw-store`
- `test:summary-store`
- `test:assembler`
- `test:recall`
- OpenClaw `plugins install --link`
- OpenClaw 插件加载状态

未完成的验证：

- 真实对话中的持续 `ingest`
- 真实对话中的 `compact`
- 真实对话中的 `assemble`
- 真实回溯时的 `recall_detail`

## 9 结论

这个插件现在已经不是“方案草稿”，而是一个已经落地的首版实现。

它的价值已经体现在：

- 有独立工程。
- 有独立存储。
- 有可运行生命周期。
- 有构建验证。
- 有 OpenClaw 真实加载。

下一阶段的核心不是继续扩展架构，而是把真实会话联调跑通，把行为稳定下来。
