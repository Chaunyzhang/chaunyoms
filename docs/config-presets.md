# ChaunyOMS Config Presets

ChaunyOMS now supports three named presets through `configPreset`.

## 1. `safe`

Use when you want the most conservative behavior.

- disables semantic candidate expansion by default
- disables auto recall by default
- keeps knowledge promotion off unless explicitly enabled

```json
{
  "configPreset": "safe",
  "knowledgePromotionEnabled": false
}
```

## 2. `balanced`

This matches the current default posture.

- keeps safe defaults
- keeps auto recall on
- keeps semantic candidate expansion on
- still treats source recall and unified knowledge as the final authority

```json
{
  "configPreset": "balanced"
}
```

## 3. `enhanced_recall`

Use when you want stronger retrieval helpers without switching to RAG-first behavior.

- enables semantic candidate expansion
- increases semantic candidate limit
- keeps source recall and unified knowledge as the final authority

```json
{
  "configPreset": "enhanced_recall",
  "semanticCandidateLimit": 8
}
```

## Warnings

ChaunyOMS emits configuration guidance when it sees risky combinations, for example:

- `knowledgePromotionEnabled=true` with `strictCompaction=false`
- semantic candidate expansion enabled while runtime capture is disabled
- emergency brake enabled

The goal is not to block startup. The goal is to make degraded or contradictory behavior obvious.
