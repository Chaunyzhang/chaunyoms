# 记忆架构与上下文优化方案 v3（ChaunyOMS）

## 核心原则

1. 接受不完美，不追求一次装下所有历史。
2. 导航层是路标，不是事实源。
3. 知识库 + 检索是长期能力底座。
4. 压缩与召回分层，保证可回溯到原文。

---

## 四层结构

1. 私有记忆（当前 agent）

- 位置：`~/.openclaw/workspace/`
- 用途：身份、风格、技能、行为规则。
- 读写：当前 agent 私有。

2. 共享沉淀（所有 agent）

- 位置：`C:\openclaw-data\shared-insights\`
- 用途：共享经验、共识方法、可复用策略。
- 读写：按需沉淀，不自动泛化写入。

3. 知识库（版本化资料）

- 位置：`C:\openclaw-data\knowledge-base\`
- 用途：资料原文、版本演进、可审计追踪。
- 原则：源文件是事实源，向量索引是检索加速层。

4. 会话原文与摘要底座

- 位置：`C:\openclaw-data\chaunym-db\lcm.db` 与插件数据目录
- 用途：会话原文、压缩摘要、回溯路径。

---

## 导航层规则

导航文件位置：`~/.openclaw/workspace/memory/YYYY-MM-DD-HH-mm.md`

格式建议（精简 4 行）：

```md
2026-04-02:

- active: 当前主线
- decision: 本轮关键决策
- todo: 下一步待办
- recall: 回溯线索（summary id / 文档路径）
```

规则：

- 只写路标，不写完整对话正文。
- 命中导航可直接回答“近况类”问题。
- 涉及事实/参数/原话/约束，必须继续回源（DAG 或原文）。
- 当前实现按“保留 30 轮导航文件”清理旧文件。

---

## 检索路由（程序化）

路由目标分为：

1. `recent_tail`
2. `navigation`
3. `dag`
4. `shared_insights`
5. `knowledge_base`
6. `vector_search`

当前实现规则：

- 事实/参数/原话/约束问题：强制 `dag` 并 auto recall。
- 近况/主线/待办问题：优先 `navigation`。
- 共享沉淀与知识库的模糊检索：
  - `memorySearch.enabled=true` -> `vector_search`
  - 未启用 -> 走路标命中与文件直读降级路径。

---

## Embeddings 触发规则

- `memorySearch` 是按需能力，不是启动前强依赖。
- 当任务需要语义检索且未启用时，系统应提示配置 API。
- 用户可忽略，系统继续走非 embeddings 路径。

建议提示文案：

> 当前任务需要启用 embeddings 检索。要现在配置 API 吗？可选 OpenAI 或 SiliconFlow；也可以回复忽略继续。

---

## 稳定前缀（Assemble 顺序）

1. Shared Cognition
2. Shared Insights Index
3. Knowledge Base Index
4. Navigation
5. LCM Recall Guidance（仅在有 compacted summaries 时注入）

原则：越稳定越靠前，越动态越靠后。

---

## 最小程序化清单（已落地）

- 检索路由器（路由决策）
- embeddings 需求判断与提示
- 检索路径标注（`retrievalHitType`）
- 事实问题回源开关（auto recall）
- 启动时摘要完整性校验（hash + count）

---

## 系统配置风险与防护

关键配置：

- `plugins.slots.contextEngine = "chaunyoms"`
- `agents.defaults.memorySearch.extraPaths` 包含 `C:\openclaw-data`

风险：

- contextEngine 丢失 -> 回退默认引擎，DAG 行为降级。
- extraPaths 丢失 -> 共享层检索能力下降。

防护：

- 使用配置备份目录：`~/.openclaw/config-backup/openclaw.json`
- 使用插件自检脚本：
  - `npm run check:openclaw-config`
  - `npm run fix:openclaw-config`
  - `npm run restore:openclaw-config`

---

## 一句话总结

ChaunyOMS 以“原文不丢、摘要压缩、分层路由、可回源”为主线：导航负责提醒，DAG 负责历史，知识库负责资料，向量检索负责模糊语义召回；任何关键事实最终都应可回到原文。
