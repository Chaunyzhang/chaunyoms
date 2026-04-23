# OpenClaw Chaunyoms

Lightweight OMS context-engine plugin for OpenClaw.

## Current Defaults

- `chaunyoms` now installs in a **safe mode** by default.
- Context-engine lifecycle is enabled.
- runtime data no longer follows the gateway working directory; defaults now resolve to:
  - `dataDir = C:\openclaw-data\data\chaunyoms`
  - `sharedDataDir = C:\openclaw-data`
  - `memoryVaultDir = C:\openclaw-data\vaults\chaunyoms`
  - `knowledgeBaseDir = C:\openclaw-data\knowledge-base`
- plugin tools are **disabled by default** with `plugins.entries.chaunyoms.config.enableTools = false`.
- strict compaction is **enabled by default**:
  - trigger threshold: `0.70`
  - LLM summary required
  - summary / rollup / knowledge promotion are LLM-only paths
  - bare host model ids such as `gpt-5.4` are normalized against configured provider-scoped refs when possible
- This avoids the MiniMax Anthropic-compatible `tool call id is invalid (2013)` failure we reproduced during direct activation.
- knowledge promotion is present in code but **disabled by default**.

## Runtime Behavior

- recent-tail assembly works as the safe baseline
- OMS compaction / recall stores remain available to the context engine
- if compaction pressure crosses the trigger threshold, ChaunyOMS compacts before assemble continues and only resumes after pressure returns to the healthy range
- navigation snapshots write only after a compaction event produces a new compressed boundary
- retrieval tools exist in code, but are only registered when `enableTools=true`
- if embeddings retrieval is not ready, ChaunyOMS now injects a one-shot bootstrap guidance into the next assembled prompt so OpenClaw will ask the user whether to configure `memorySearch` embeddings
- embeddings readiness is considered satisfied when either:
  - OpenClaw runtime exposes a working `memorySearch` capability
  - or `agents.defaults.memorySearch` is enabled and has a concrete provider/model/baseUrl-style configuration

## Memory Layers

- `RawMessageStore`: source transcript layer for fresh tail assembly and source recall
- `SummaryIndexStore`: compressed history layer; summaries now preserve structured fact anchors, project/topic coordinates, active-state markers, and parent/child summary-tree links
- `DurableMemoryStore`: extracted durable facts, decisions, diagnostics, and project-state hints for lightweight retrieval with active/superseded record tracking
- `KnowledgeMarkdownStore`: optional markdown knowledge promotion path, present in code but disabled by default
- `ProjectRegistryStore`: agent-scoped project registry that tracks active focus, blockers, next steps, linked summaries, and linked durable memories
- `SessionDataLayer`: the plugin's data boundary; runtime orchestration reads/writes through this layer instead of directly managing file stores

## Organizer / Routing Upgrades

- background organization now reconciles duplicate durable memories, supersedes stale project-state records, and rebuilds the project registry from active summaries + durable memories
- retrieval routing now hard-selects between:
  - `recent_tail`
  - `project_registry`
  - `durable_memory`
  - `summary_tree`
  - `knowledge_base`
  - `shared_insights`
  - `vector_search`
- retrieval decisions now include an explicit route plan and explanation so downstream callers can inspect why a layer was chosen
- multi-project validation coverage now includes parallel Project Atlas / Project Beacon routing and organizer reconciliation

## Decoupling Status

ChaunyOMS now separates:
- **runtime layer**: orchestration, routing, compaction policy, recall decisions
- **data layer**: raw/summaries/observations/durable memory/knowledge persistence and migrations

Core runtime services no longer depend on concrete file-store classes directly; they depend on repository interfaces and the session data layer.

## Summary Tree / Project Organization

- leaf summaries still compact raw message ranges
- when enough root summaries accumulate, ChaunyOMS now rolls them into higher-level branch summaries
- branch summaries keep child summary ids and inherited source-message boundaries so recall can still trace back to raw history
- project snapshots now carry:
  - `project_id`
  - `project_title`
  - `project_status`
- durable project-state memories supersede older active project-state entries for the same project instead of piling up forever

## Update / Migration Behavior

- session data now maintains a local `_schema-registry.json`
- bootstrap runs a session data migration pass before stores are initialized
- current explicit migrations cover:
  - raw messages: add missing `sequence`
  - summaries: normalize to schema version 2 and backfill structured fields
  - durable memory: normalize to schema version 2 wrapper format

## Fixed Context Zone

The compaction trigger still uses total context pressure, but compaction stops based on the remaining **compressible history zone**.

Current fixed zone content includes:
- OpenClaw host-fixed context (accounting rule: prefer host-provided `systemPromptTokens`; only fall back to local workspace bootstrap estimation when the host does not provide it)
  - workspace bootstrap files loaded by the host system prompt layer:
    - `AGENTS.md`
    - `SOUL.md`
    - `IDENTITY.md`
    - `USER.md`
    - `TOOLS.md`
    - `BOOTSTRAP.md`
    - `MEMORY.md`
    - `HEARTBEAT.md` when present / eligible
  - host skill exposure (`<available_skills>`) and other system-prompt sections when the host includes them
- OpenClaw / plugin stable prefix material loaded by `StablePrefixStore`
  - shared cognition
  - shared insights index
  - knowledge-base index
  - navigation snapshot
- recall guidance emitted when summaries exist
- durable memory items injected by `ContextAssembler`

Current fresh-message zone includes:
- recent tail messages preserved by `assembleRecentTail(...)`

Current compressible zone is therefore treated as:
- raw historical conversation outside the fixed zone and outside the protected fresh tail

Each new summary now preserves:
- natural-language summary
- keywords
- constraints
- decisions
- blockers
- exact facts
- source message ids
- source timestamps
- source sequence range anchors

Tool names behind `enableTools=true`:

- `memory_route`
- `memory_retrieve`
- `recall_detail`
- `lcm_describe`
- `lcm_expand_query`
- `lcm_grep`

## Build

```powershell
npm install
npm run build
```

## Safe Two-Stage Install

### Stage 1: Install But Do Not Take Over Yet

```powershell
openclaw plugins install -l "D:\chaunyoms"
openclaw plugins doctor
```

Keep `contextEngine` on `legacy` first.

### Stage 2: Activate ChaunyOMS

Set:

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

Then restart gateway and send one shortest possible test message.

## Clean Uninstall

```powershell
openclaw plugins uninstall chaunyoms --keep-files
```

Then set:

```json
{
  "plugins": {
    "slots": {
      "contextEngine": "legacy"
    }
  }
}
```

## Notes

- plugin-specific config belongs under `plugins.entries.chaunyoms.config`, not top-level `chaunyoms`
- if `sharedDataDir` is overridden and `dataDir`/`memoryVaultDir` are omitted, ChaunyOMS derives them under that shared root instead of using `process.cwd()`
- the bridge is defensive because hook payloads can vary by OpenClaw version
- if assembly fails, the plugin falls back to recent-tail behavior
- vector dimensions are delegated to OpenClaw `memorySearch`; ChaunyOMS does not hard-code its own embedding dimension schema
