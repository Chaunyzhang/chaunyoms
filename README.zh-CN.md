# ChaunyOMS

<div align="center">

**一个面向真实长会话与长期记忆治理的 OpenClaw 上下文引擎插件**

[![OpenClaw](https://img.shields.io/badge/OpenClaw-context--engine-6f42c1)](./README.md)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6)](https://www.typescriptlang.org/)
[![状态](https://img.shields.io/badge/status-active%20development-2ea043)](./README.md)
[![默认模式](https://img.shields.io/badge/default-safe%20mode-orange)](./README.md)

</div>

> ChaunyOMS 不是“给 prompt 多塞一点记忆”的补丁，  
> 也不是一上来就把所有东西揉成一个巨型知识库的激进方案。  
> 它更像一个**运行期优先、边界清晰、可继续长大的上下文内核**。

---

## 目录

- [它是什么](#它是什么)
- [它不是什么](#它不是什么)
- [为什么值得做](#为什么值得做)
- [架构概览](#架构概览)
- [记忆分层](#记忆分层)
- [当前行为](#当前行为)
- [安装方式](#安装方式)
- [配置要点](#配置要点)
- [仓库结构](#仓库结构)
- [验证覆盖](#验证覆盖)
- [后续方向](#后续方向)

---

## 它是什么

ChaunyOMS 是一个给 OpenClaw 用的 **context engine 插件**，核心关注点是：

- 长对话上下文控制
- 可追溯的原始历史
- 结构化长期记忆
- 可控压缩与原文回溯
- 项目级组织
- 面向后续 wiki / knowledge workflow 的演进能力

更直白一点说，它想解决的是：

- 会话一长，prompt 越来越贵
- 重要信息散落在对话里，越来越难回忆
- 想做长期知识，但又不想一开始就把系统做得很重

---

## 它不是什么

ChaunyOMS **不是**：

- 一个简单的聊天日志堆积器
- 一个已经完成的 wiki 编译器
- 一个向量数据库替代品
- 一个“所有东西都先存再说”的无限记忆插件

它是有边界感的：

- raw history 仍然是来源层
- durable memory 是结构化记忆，不是摘要块
- knowledge workflow 是预留出来的，不是默认强开
- 安全默认值优先于激进自动化

---

## 为什么值得做

很多 memory 系统最后会走向两个极端：

1. 只是不断把更多文本塞回 prompt  
2. 还没把运行期问题理顺，就过早跳进一个很重的知识系统

ChaunyOMS 选的是第三条路：

- **先把运行期上下文做好**
- **再把数据边界理顺**
- **再给知识层留出干净入口**

所以它的价值不在于“功能堆很多”，而在于：

- 原始记录可追溯
- 运行层和数据层分开
- 压缩不是乱压，而是可控系统行为
- 在 summary 还没出现前，系统也能先提炼 durable / knowledge raw

---

## 架构概览

```mermaid
flowchart LR
    Host[OpenClaw Host] --> Payload[Payload Adapter]
    Payload --> Ingress[运行期入口过滤]
    Ingress --> Raw[Raw Message Store]
    Ingress --> Obs[Observation Store]

    Raw --> Durable[Durable Memory]
    Obs --> Durable

    Raw --> KRaw[Knowledge Raw]
    Obs --> KRaw

    Raw --> Compact[Compaction Engine]
    Compact --> Summary[Summary Index]
    Summary --> Rollup[摘要树 / Rollup]

    Durable --> Router[检索路由]
    Summary --> Router
    KRaw --> Wiki[未来的 Wiki Rewrite]
    Router --> Assemble[上下文组装]
    Assemble --> LLM[主 LLM]
```

---

## 记忆分层

| 层 | 作用 | 当前定位 |
| --- | --- | --- |
| `RawMessageStore` | 原始对话层 | recent tail、精确回溯、压缩来源 |
| `ObservationStore` | 观察事件层 | 把 tool/output 等运行信号从聊天原文里分出来 |
| `DurableMemoryStore` | 结构化长期记忆层 | 约束、决策、诊断、项目状态提示 |
| `KnowledgeRawStore` | 知识原料层 | 后续 wiki / knowledge rewrite 的毛坯料 |
| `SummaryIndexStore` | 压缩历史层 | 一层摘要与后续摘要树 |
| `KnowledgeMarkdownStore` | 托管知识层 | 代码已存在，默认关闭 |
| `ProjectRegistryStore` | 项目组织层 | 当前焦点、阻塞、下一步、关联资产 |

### 一个很重要的区分

- **Durable memory 不是摘要。**
- 它更像“提前抽出来的结构化长期记忆卡片”。
- 真正的“压缩摘要”要等 compaction 触发后才会出现。

---

## 当前行为

### 默认是安全模式

- tools 默认关闭
- knowledge promotion 默认关闭
- strict compaction 默认开启
- 数据目录不再跟着 gateway 工作目录乱跑

### 运行期行为

- recent-tail 仍然是最稳的基础路径
- runtime ingress 会过滤 host wrapper、heartbeat、pseudo-user 噪音、低价值 tool receipt
- 即使还没触发压缩，也可以先写：
  - raw
  - durable memory
  - knowledge raw
- 只有上下文压力过阈值时，才触发 compaction
- navigation snapshot 只有在压缩边界出现后才写

### 检索行为

当前检索路由可以在这些层之间做硬选择：

- `recent_tail`
- `project_registry`
- `durable_memory`
- `summary_tree`
- `knowledge`
- `shared_insights`
- `vector_search`

---

## 安装方式

## 1. 构建

```powershell
npm install
npm run build
```

## 2. 链接安装到 OpenClaw

```powershell
openclaw plugins install -l "D:\chaunyoms"
openclaw plugins doctor
openclaw plugins list
```

## 3. 激活为 context engine

在 OpenClaw 配置里加：

```json
{
  "plugins": {
    "slots": {
      "contextEngine": "chaunyoms"
    },
    "entries": {
      "chaunyoms": {
        "enabled": true,
        "config": {
          "dataDir": "C:\\openclaw-data\\data\\chaunyoms",
          "sharedDataDir": "C:\\openclaw-data",
          "memoryVaultDir": "C:\\openclaw-data\\vaults\\chaunyoms",
          "knowledgeBaseDir": "C:\\openclaw-data\\knowledge-base",
          "enableTools": false,
          "contextThreshold": 0.70,
          "strictCompaction": true,
          "compactionBarrierEnabled": true,
          "knowledgePromotionEnabled": false
        }
      }
    }
  }
}
```

然后重启：

```powershell
openclaw gateway restart
```

---

## 配置要点

重点配置项：

- `dataDir`
- `workspaceDir`
- `sharedDataDir`
- `memoryVaultDir`
- `knowledgeBaseDir`
- `enableTools`
- `contextThreshold`
- `strictCompaction`
- `compactionBarrierEnabled`
- `runtimeCaptureEnabled`
- `durableMemoryEnabled`
- `autoRecallEnabled`
- `knowledgePromotionEnabled`
- `emergencyBrake`

### 说明

- 配置必须放在 `plugins.entries.chaunyoms.config`
- 如果只改了 `sharedDataDir`，其它目录会按这个根自动推导
- 如果 assemble 失败，会回退到 recent-tail 行为

---

## 仓库结构

```text
src/
  data/        数据边界、迁移、vault bridge
  engines/     压缩、提炼、组织、摘要树
  host/        OpenClaw payload/config/runtime 适配
  resolvers/   recall 解析
  routing/     检索路由决策
  runtime/     session runtime、ingress、retrieval service
  stores/      raw/summaries/durable/knowledge/project 持久化
  system/      外部共享目录初始化
  tests/       运行期与数据边界回归测试
```

---

## 验证覆盖

当前仓库已经有针对这些点的专项测试：

- runtime ingress normalization
- summary normalization
- summary tree / project registry
- tool turn numbering
- upgrade protection
- knowledge routing priority
- retrieval vector fallback

它当然还在进化中，  
但它也已经不是一个“没有护栏、全靠感觉”的实验仓库。

---

## 后续方向

短期内最值得继续做的事情：

- durable / knowledge raw 的更强语义去重
- 把 wiki rewrite 做成异步流水线
- 继续分清运行期记忆和正式知识层
- 做更多真实 OpenClaw 会话下的 end-to-end 验证

---

## 项目定位

实话实说版本：

- 它还在长。
- 有些层已经很稳。
- 有些层是明确留到后面再做重活。

但如果要一句更有劲的话来形容它：

> **ChaunyOMS 已经不像一个“记忆小补丁”，而更像一个真正的上下文引擎骨架。**

它现在最牛的地方，不是“把所有东西都做完了”，  
而是它已经把未来能不能继续长大这件事，提前按工程方式想清楚了。

