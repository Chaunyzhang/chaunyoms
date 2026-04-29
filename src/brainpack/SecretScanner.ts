import { createHash } from "node:crypto";

export type SecretFindingSeverity = "warn" | "block";
export type SecretFindingAction = "redacted" | "blocked" | "reported";

export interface SecretFinding {
  type: string;
  severity: SecretFindingSeverity;
  action: SecretFindingAction;
  path: string;
  hash: string;
  start: number;
  end: number;
}

export interface SecretScanResult {
  path: string;
  findings: SecretFinding[];
  redactedText: string;
  blocked: boolean;
}

interface SecretPattern {
  type: string;
  severity: SecretFindingSeverity;
  pattern: RegExp;
  replacement: string | ((match: string, ...groups: string[]) => string);
}

const SECRET_PATTERNS: SecretPattern[] = [
  {
    type: "private_key",
    severity: "block",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
  {
    type: "openai_like_api_key",
    severity: "block",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
    replacement: "[REDACTED_API_KEY]",
  },
  {
    type: "github_token",
    severity: "block",
    pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
    replacement: "[REDACTED_GITHUB_TOKEN]",
  },
  {
    type: "aws_access_key",
    severity: "block",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: "[REDACTED_AWS_KEY]",
  },
  {
    type: "credential_assignment",
    severity: "block",
    pattern: /\b(api[_-]?key|token|password|secret|cookie|authorization)\s*[:=]\s*["']?([^"'\s]{8,})["']?/gi,
    replacement: (_match, label: string) => `${label}=[REDACTED_SECRET]`,
  },
];

const FORBIDDEN_PATH_PATTERNS = [
  /(^|[\\/])\.env(?:\.|$)/i,
  /\.(?:db|sqlite|sqlite3)$/i,
  /(?:-wal|-shm)$/i,
  /(^|[\\/])id_rsa$/i,
  /(^|[\\/])id_ed25519$/i,
];

export class SecretScanner {
  scanText(path: string, text: string, mode: "strict" | "redact" | "report_only" = "strict"): SecretScanResult {
    const findings: SecretFinding[] = [];
    let redactedText = text;
    for (const pattern of SECRET_PATTERNS) {
      redactedText = redactedText.replace(pattern.pattern, (match: string, ...args: unknown[]) => {
        const offset = this.matchOffset(args);
        const action = this.findingAction(mode, pattern.severity);
        findings.push({
          type: pattern.type,
          severity: pattern.severity,
          action,
          path,
          hash: this.hash(match),
          start: offset,
          end: offset + match.length,
        });
        if (mode === "report_only" || action === "blocked") {
          return match;
        }
        return typeof pattern.replacement === "function"
          ? pattern.replacement(match, ...this.replacementGroups(args))
          : pattern.replacement;
      });
    }
    const blockedByPath = this.isForbiddenPath(path);
    if (blockedByPath) {
      findings.push({
        type: "forbidden_path",
        severity: "block",
        action: "blocked",
        path,
        hash: this.hash(path),
        start: 0,
        end: 0,
      });
    }
    return {
      path,
      findings,
      redactedText,
      blocked: blockedByPath || findings.some((finding) => finding.action === "blocked"),
    };
  }

  isForbiddenPath(path: string): boolean {
    return FORBIDDEN_PATH_PATTERNS.some((pattern) => pattern.test(path));
  }

  private hash(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
  }

  private findingAction(mode: "strict" | "redact" | "report_only", severity: SecretFindingSeverity): SecretFindingAction {
    if (mode === "report_only") {
      return "reported";
    }
    if (mode === "strict" && severity === "block") {
      return "blocked";
    }
    return "redacted";
  }

  private matchOffset(args: unknown[]): number {
    const offset = args.find((value) => typeof value === "number");
    return typeof offset === "number" && Number.isFinite(offset)
      ? Math.max(0, offset)
      : 0;
  }

  private replacementGroups(args: unknown[]): string[] {
    const offsetIndex = args.findIndex((value) => typeof value === "number");
    const captureValues = offsetIndex >= 0 ? args.slice(0, offsetIndex) : args;
    return captureValues.map((value) => String(value));
  }
}
