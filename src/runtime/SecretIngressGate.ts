import { SecretFinding, SecretScanner } from "../brainpack/SecretScanner";

export interface SecretIngressResult {
  text: string;
  findings: SecretFinding[];
  metadata: Record<string, unknown>;
}

export class SecretIngressGate {
  private readonly scanner = new SecretScanner();

  sanitize(path: string, text: string, metadata: Record<string, unknown> = {}): SecretIngressResult {
    const scan = this.scanner.scanText(path, text, "redact");
    const findings = scan.findings.map((finding) => ({ ...finding }));
    return {
      text: scan.redactedText,
      findings,
      metadata: findings.length > 0
        ? {
            ...metadata,
            secretIngressRedacted: true,
            secretIngressFindingCount: findings.length,
            secretIngressFindings: findings.map((finding) => ({
              type: finding.type,
              severity: finding.severity,
              action: finding.action,
              path: finding.path,
              hash: finding.hash,
              start: finding.start,
              end: finding.end,
            })),
          }
        : metadata,
    };
  }
}
