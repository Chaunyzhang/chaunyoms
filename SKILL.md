---
name: chaunyoms-installer
description: Install and configure the ChaunyOMS OpenClaw contextEngine plugin on Windows machines. Use when OpenClaw users need agent-driven setup, upgrade, or verification of plugin build, plugin link install, contextEngine slot binding, and runtime health checks.
---

# ChaunyOMS Installer Skill

## Execute Setup

1. Resolve environment paths:
   - Plugin repo path: use current working repo unless user specifies another path.
   - OpenClaw config path: `%USERPROFILE%\\.openclaw\\openclaw.json`.
2. Verify prerequisites:
   - `node -v`
   - `npm -v`
   - `openclaw --version`
3. Build plugin:
   - `npm install`
   - `npm run build`
4. Install plugin link:
   - `openclaw plugins install --link "<plugin_repo_path>"`
5. Run plugin health check before takeover:
   - `openclaw plugins doctor`
   - do not switch away from `legacy` until the build and link are confirmed
6. Configure `contextEngine` slot to `chaunyoms` in `openclaw.json`.
7. Put plugin config under `plugins.entries.chaunyoms.config`, not top-level keys.
8. Set safe default:
   - `plugins.entries.chaunyoms.config.enableTools = false`
9. Run config self-check:
   - `npm run check:openclaw-config`
   - if mismatched: `npm run fix:openclaw-config`
10. Configure plugin block if missing under `plugins.entries.chaunyoms.config`:
   - `dataDir`
   - `sharedDataDir`
   - `contextWindow`
   - `contextThreshold`
   - `freshTailTokens`
   - `maxFreshTailTurns`
   - `compactionBatchTurns`
   - `summaryMaxOutputTokens`
   - `summaryModel` (optional; default to current conversation model when omitted)
11. Restart gateway only after config is validated.
12. Verify:
   - `npm run test:raw-store`
   - `npm run test:summary-store`
   - `npm run test:assembler`
   - `npm run test:recall`
   - `npm run test:memory-router`
   - `npm run test:external-bootstrap`
   - `npm run test:stable-prefix`
   - `npm run test:memory-retrieve-auto-recall`
   - `npm run test:compaction-integrity`
   - `npm run test:embedding-bootstrap`
13. Report final status with:
   - build status
   - test status
   - config status (`contextEngine` bound to `chaunyoms`)
   - install status (`plugins install --link` success)
   - safe-mode status (`enableTools=false`)

## Apply Safe Config Rules

1. Backup `openclaw.json` before editing.
2. Merge JSON keys without removing unrelated user settings.
3. Do not downgrade existing values unless explicitly requested.
4. If JSON is malformed, stop and ask user before overwriting.

## Use Recommended Config Values

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
          "enableTools": false,
          "dataDir": ".chaunyoms",
          "sharedDataDir": "C:\\openclaw-data",
          "contextWindow": 32000,
          "contextThreshold": 0.75,
          "freshTailTokens": 6000,
          "maxFreshTailTurns": 8,
          "compactionBatchTurns": 12,
          "summaryMaxOutputTokens": 300
        }
      }
    }
  }
}
```

`summaryModel` can be omitted to follow the active OpenClaw conversation model.

## Validate Runtime Expectations

1. Confirm stable-prefix sources exist or are bootstrapped:
   - `C:\\openclaw-data\\shared-cognition\\COGNITION.md`
   - `C:\\openclaw-data\\shared-insights\\insight-index.json`
   - `C:\\openclaw-data\\knowledge-base\\topic-index.json`
2. Confirm retrieval outputs include `details.retrievalHitType`.
3. Confirm compatibility aliases are callable:
   - `lcm_describe` -> `memory_route`
   - `lcm_expand_query` -> `memory_retrieve`
   - `lcm_grep` -> `recall_detail`
4. Confirm navigation snapshots are written to `~/.openclaw/workspace/memory/YYYY-MM-DD-HH-mm.md` and retention is 30 rounds.
5. Confirm `memory_retrieve` can execute `vector_search` route when `memorySearch.enabled=true`.
6. Confirm assembled context can include `LCM Recall Guidance` when compacted summaries exist.
7. Only enable tool registration after the host/provider path has been separately verified.
8. If `memorySearch` is not configured yet, expect ChaunyOMS to inject a one-shot setup guidance so the assistant can proactively ask the user to configure embeddings.

## Handle Failures

1. Build failure:
   - report compiler error
   - stop installation change
2. Plugin install failure:
   - report command error
   - keep config unchanged
3. Config write failure:
   - restore from backup
   - report restoration result
4. Test failure:
   - report failing test names
   - keep plugin installed but mark setup as incomplete
5. If direct activation breaks normal dialogue:
   - switch `contextEngine` back to `legacy`
   - keep plugin files installed
   - set `enableTools=false`
   - only retry activation after one shortest-message smoke test passes
