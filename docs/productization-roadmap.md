# ChaunyOMS Productization Roadmap

## Purpose

This roadmap is the working plan for turning ChaunyOMS from a broad experimental memory system into a lean, auditable, agent-first production memory layer.

The guiding direction is:

- Keep raw source records as the final source of truth.
- Keep level-1 substrate summaries as the low-level knowledge nutrient layer.
- Keep source trace and evidence atoms as the precision layer.
- Keep KnowledgeMarkdownStore as the only default human-readable knowledge layer.
- Move operational reads toward SQLite-first.
- Turn broad Markdown/JSON mirrors into optional debug, export, or backup surfaces.

## P0: Hard Fixes

These are correctness and operability issues. They should be handled before larger slimming or SQLite-primary migration work.

### 1. Fix Chinese Knowledge Override Mojibake

The Chinese "remember this / write to knowledge base / save as knowledge" override path must not depend on mojibake literals.

Current direction:

- Prefer LLM ingress intent tagging for explicit user knowledge-write intent.
- Keep phrase matching as fallback only.
- Store Chinese fallback phrases in encoding-safe form when needed.
- Ensure tests cover `记住这个`, `帮我记一下`, `放进知识库`, `写进 wiki`, `沉淀到知识库`, and `保存为知识`.

Done so far:

- Added `KnowledgeIntentClassifier`.
- Added `rawMessage.metadata.knowledgeIntent`.
- Added fallback phrase matching with Unicode-safe literals.
- Added regression coverage.

### 2. Keep Real OpenClaw Testing on the Single Allowed Protocol

Reference only: `docs/openclaw-real-environment-test-protocol.md`.

Current direction:

- Treat `docs/openclaw-real-environment-test-protocol.md` as the only rule
  source.
- Do not restate the protocol in roadmap/status docs; link to the canonical
  protocol instead.

Done so far:

- The roadmap now links to the canonical protocol instead of restating the flow.
- Duplicate roadmap-level flow instructions have been removed to avoid drift.

### 3. Show Retrieval Budget and Atom Storage Shape in Tool Text

The model and tester should see whether retrieval came from persistent atoms, transient summary-derived atoms, summaries, or raw spans without digging into hidden JSON details.

Current direction:

- Display `retrievalBudget` in `memory_retrieve` text output.
- Display persistent/transient evidence atom counts.
- Keep detailed JSON diagnostics for tooling, but make the normal text answer self-explanatory.

Done so far:

- `memory_retrieve` text includes total/atom/summary/raw budgets.
- It also shows persistent vs transient atom counts.

### 4. Continue Agent-First Scope Hardening

ChaunyOMS should be cross-session within the same agent, not accidentally cross-agent by default.

Current direction:

- Make agent scope the default for runtime memory.
- Avoid treating shared/global data as authoritative agent memory unless explicitly configured.
- Keep workspace/global knowledge separate from agent memory.
- Audit tools and scripts for accidental `main` fallback.

Status:

- Session QA scripts now infer the owning agent from the session.
- More code audit is still required for shared/global data surfaces.

### 5. Add Evidence Atom Backfill as an Explicit Migration Tool

Old summaries may contain embedded atom-like structures while the persistent evidence atom store is empty. Backfill is useful, but it must not run as implicit magic.

Current direction:

- Add an explicit admin/migration tool such as `oms_backfill_atoms`.
- Dry-run by default.
- Report source summary count, generated atom count, skipped count, conflicts, and write target.
- Never silently mutate old data during normal retrieval.

Status:

- Persistent evidence atoms exist for newly compacted summaries.
- `oms_backfill_atoms` now provides explicit dry-run/apply backfill from existing level-1 leaf summaries.
- Backfill reports total summaries, eligible summaries, skipped summaries, generated atoms, written atoms, and source summary ids.
- Regression coverage verifies dry-run safety, apply behavior, and idempotent skip behavior after backfill.

## P1: Default Slimming

These changes reduce file noise, prompt-cache churn, and operational complexity without changing the memory model.

### 1. Add Mirror Configuration Switches

Add config switches for human-readable mirrors:

- `agentVaultMirrorEnabled`
- `transcriptMirrorEnabled`
- `summaryMarkdownMirrorEnabled`
- `durableMarkdownMirrorEnabled`
- `knowledgeMarkdownEnabled`

Target default:

- Disable broad AgentVault mirrors.
- Keep KnowledgeMarkdownStore enabled.
- Keep explicit export/debug tools for humans.

Status:

- Implemented `agentVaultMirrorEnabled`, `transcriptMirrorEnabled`, `summaryMarkdownMirrorEnabled`, `durableMarkdownMirrorEnabled`, and `knowledgeMarkdownEnabled`.
- Defaults now keep AgentVault mirrors off and curated Knowledge Markdown on.

### 2. Disable AgentVault Summary/Durable/Transcript Markdown by Default

AgentVault mirrors are useful for development, but they are not the product's default human interface.

Current direction:

- Do not hot-write summary/durable/transcript Markdown mirrors by default.
- Preserve source trace, SQLite records, raw messages, summaries, and knowledge assets.
- Provide manual export tools for debugging.

Status:

- Implemented default-off hot writes for summary and durable AgentVault mirrors.
- Transcript mirroring is now represented in config and remains off by default.

### 3. Keep KnowledgeMarkdownStore as the Only Default Human-Readable Knowledge Layer

The formal human-readable layer should be curated knowledge, not full memory mirrors.

Current direction:

- Preserve KnowledgeMarkdownStore.
- Keep manual review first.
- Only approved facts, decisions, patterns, and incidents become durable human-facing knowledge.

Status:

- Implemented default `knowledgeMarkdownEnabled=true`.
- Knowledge promotion remains manual-review-first by default.

### 4. Write Navigation Only When Content Hash Changes

Navigation can affect prompt-cache stability if rewritten too often.

Current direction:

- Hash navigation content before writing.
- Avoid touching files when content is unchanged.
- Eventually split stable prefix into static, project navigation, and query-dependent knowledge index.

Status:

- Workspace navigation already skips unchanged content.
- AgentVault navigation now also skips identical-content rewrites when the mirror is explicitly enabled.

## P2: SQLite-First Migration

This is the larger storage migration. It should come after P0/P1 because it changes more core assumptions.

### 1. Tool Read Paths Prefer SQLite

Retrieval, trace, grep, replay, context inspection, and diagnostics should read SQLite first.

Status:

- Runtime assembly, `memory_retrieve`, `oms_grep`, `oms_expand`, `oms_trace`, `oms_replay`, context inspection, and QA report/smoke paths use the SQLite runtime as the canonical read surface.
- `oms_verify_migration` compares repository counts against SQLite runtime counts.
- `oms_migrate_json_to_sqlite` is now explicit and intentionally non-magical in final-shape mode: legacy JSON is not imported during normal startup.

### 2. Implement SQLite-Backed Repositories

Implement repository-backed SQLite storage behind existing interfaces:

- `SQLiteRawMessageRepository`
- `SQLiteSummaryRepository`
- `SQLiteDurableMemoryRepository`
- `SQLiteObservationRepository`
- `SQLiteProjectRegistryRepository`
- `SQLiteKnowledgeRawRepository`

Keep interfaces stable so callers do not need to know whether JSON or SQLite is primary.

Status:

- Implemented SQLite-backed repositories for raw messages, summaries, durable memories, evidence atoms, observations, project registry, and knowledge raw candidates.
- `SessionDataLayer` now selects SQLite repositories when `sqlitePrimaryEnabled=true`.
- SQLite includes a generic `runtime_records` table for non-core runtime records such as observations, project records, and knowledge raw entries.

### 3. Downgrade JSON to Backup/Export/Off

Add a persistence mode:

- `jsonPersistenceMode: "primary" | "backup" | "off"`
- `sqlitePrimaryEnabled: boolean`

Migration target:

- JSON is no longer the hot-path primary store.
- JSON remains available for backup/export during transition.

Status:

- `sqlitePrimaryEnabled` defaults to `true`.
- `jsonPersistenceMode` defaults to `"off"`.
- `oms_export_json_backup` provides explicit JSON export from the SQLite-first runtime.
- `oms_cleanup_legacy_json` provides dry-run/apply cleanup of legacy JSON/JSONL files.

### 4. Add Migration and Verification Tools

Required tools:

- `oms_migrate_json_to_sqlite`
- `oms_verify_migration`
- `oms_export_json_backup`
- `oms_cleanup_legacy_json`

Verification must check:

- message count
- summary count
- compacted flags
- source hash
- source message count
- source edge count
- raw replay
- summary DAG
- memory retrieve
- source trace

Status:

- Implemented `oms_migrate_json_to_sqlite`, `oms_verify_migration`, `oms_export_json_backup`, and `oms_cleanup_legacy_json`.
- The migration stance is final-shape SQLite-first: no implicit legacy adaptation on the hot path.
- New regression coverage verifies SQLite primary storage writes to the runtime ledger without creating raw/summary/durable/atom JSON hot-path files.

## Current Execution Rule

P0/P1 hardening is in place. P2 now targets the final product shape directly: SQLite is the operational source of truth; JSON is backup/export only; curated Knowledge Markdown remains the default human-readable knowledge layer.
