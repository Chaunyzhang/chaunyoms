# ChaunyOMS Install Commands

## 1. Build

```powershell
cd D:\chaunyoms
npm install
npm run build
```

## 2. Link Install

```powershell
openclaw plugins install -l "D:\chaunyoms"
openclaw plugins doctor
openclaw plugins list
```

## 3. Safe Activation

Set `C:\Users\%USERNAME%\.openclaw\openclaw.json`:

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

Then:

```powershell
openclaw gateway restart
openclaw agent --agent main --message "Reply with OK only." --json
```

## 4. Rollback

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

Then:

```powershell
openclaw gateway restart
```
