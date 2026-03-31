# OpenClaw Lossless Lite

Lightweight lossless context management plugin for OpenClaw.

## Build

```powershell
npm install
npm run build
```

## Notes

- The bridge is defensive because hook payloads can vary by OpenClaw version.
- If compaction or assembly fails, the plugin falls back to recent-tail behavior.
