# OpenClaw Chaunyoms

Lightweight OMS context-engine plugin for OpenClaw.

## Current Safe Default

- `chaunyoms` now installs in a **safe mode** by default.
- Context-engine lifecycle is enabled.
- plugin tools are **disabled by default** with `plugins.entries.chaunyoms.config.enableTools = false`.
- This avoids the MiniMax Anthropic-compatible `tool call id is invalid (2013)` failure we reproduced during direct activation.

## Runtime Behavior

- recent-tail assembly works as the safe baseline
- OMS compaction / recall stores remain available to the context engine
- navigation snapshots keep writing after each turn
- retrieval tools exist in code, but are only registered when `enableTools=true`
- if embeddings retrieval is not ready, ChaunyOMS now injects a one-shot bootstrap guidance into the next assembled prompt so OpenClaw will ask the user whether to configure `memorySearch` embeddings
- embeddings readiness is considered satisfied when either:
  - OpenClaw runtime exposes a working `memorySearch` capability
  - or `agents.defaults.memorySearch` is enabled and has a concrete provider/model/baseUrl-style configuration

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
          "enableTools": false
        }
      }
    }
  }
}
```

Then restart gateway and send one shortest possible test message.

## OpenClaw Config Self-Check

```powershell
npm run check:openclaw-config
npm run fix:openclaw-config
npm run restore:openclaw-config
```

- `check` only reports mismatches
- `fix` creates `~/.openclaw/config-backup/openclaw.json` then applies required keys
- `restore` restores `openclaw.json` from backup

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
- the bridge is defensive because hook payloads can vary by OpenClaw version
- if assembly fails, the plugin falls back to recent-tail behavior
- vector dimensions are delegated to OpenClaw `memorySearch`; ChaunyOMS does not hard-code its own embedding dimension schema
