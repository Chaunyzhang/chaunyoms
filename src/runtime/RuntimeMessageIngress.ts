import { RuntimeMessageSnapshot } from "../host/OpenClawPayloadAdapter";

export type RuntimeMessageClassification =
  | "user_message"
  | "assistant_message"
  | "tool_output"
  | "tool_receipt"
  | "system_message"
  | "heartbeat"
  | "control_plane"
  | "host_wrapper"
  | "pseudo_user"
  | "empty";

export type RuntimeMessageStorageTarget = "drop" | "raw_message" | "observation";

export interface RuntimeMessageIngressDecision {
  persist: boolean;
  classification: RuntimeMessageClassification;
  normalizedText: string;
  reason: string;
  storageTarget: RuntimeMessageStorageTarget;
}

const HEARTBEAT_PATTERNS = [
  /^HEARTBEAT_OK$/i,
  /^NO_REPLY$/i,
  /Read HEARTBEAT\.md if it exists \(workspace context\)\./i,
];

const TOOL_RECEIPT_PATTERNS = [
  /^(?:command|task|job|process|operation) (?:completed|finished|succeeded)\.?$/i,
  /^done\.?$/i,
  /^completed\.?$/i,
  /^success(?:ful)?\.?$/i,
  /^exit code: 0$/i,
  /^tool call (?:completed|finished|succeeded)\.?$/i,
];

const CONTROL_PLANE_PATTERNS = [
  /^System\s*\(untrusted\)\s*:/i,
  /^Control panel\s*:/i,
  /^Current time is /i,
  /^You(?:'ve| have) previously run the following command/i,
  /^Your previous command (?:has )?(?:completed|finished|succeeded)/i,
  /^Background task .* (?:completed|finished|succeeded)/i,
  /^Session(?:Start|End)\b/i,
  /^Hook\b/i,
];

const PSEUDO_USER_PATTERNS = [
  /^System\s*\(untrusted\)\s*:/i,
  /^Current time is /i,
  /^Control panel\s*:/i,
  /^Your previous command /i,
  /^You've previously run the following command/i,
  /^Background task /i,
  /^Tool result\s*:/i,
  /^Observation\s*:/i,
];

export class RuntimeMessageIngress {
  inspect(message: RuntimeMessageSnapshot): RuntimeMessageIngressDecision {
    const normalizedText = this.normalize(message.text);
    if (!normalizedText) {
      return this.skip("empty", normalizedText, "empty_message");
    }

    if (message.role === "system") {
      return this.skip("system_message", normalizedText, "system_role_not_persisted");
    }

    if (HEARTBEAT_PATTERNS.some((pattern) => pattern.test(normalizedText))) {
      return this.skip("heartbeat", normalizedText, "heartbeat_noise");
    }

    if (this.hasInternalMetadata(message)) {
      return this.skip("control_plane", normalizedText, "internal_metadata_signal");
    }

    if (CONTROL_PLANE_PATTERNS.some((pattern) => pattern.test(normalizedText))) {
      return this.skip("control_plane", normalizedText, "control_plane_pattern");
    }

    if (this.looksLikeWrapperOnly(normalizedText)) {
      return this.skip("host_wrapper", normalizedText, "wrapper_only_message");
    }

    if (message.role === "user" && this.looksLikePseudoUser(normalizedText, message)) {
      return this.skip("pseudo_user", normalizedText, "pseudo_user_or_host_proxy");
    }

    if (message.role === "tool") {
      if (this.isLowValueToolReceipt(normalizedText)) {
        return this.skip("tool_receipt", normalizedText, "low_value_tool_receipt");
      }
      return this.keep(
        "tool_output",
        normalizedText,
        "substantive_tool_output",
        "observation",
      );
    }

    if (message.role === "assistant") {
      return this.keep(
        "assistant_message",
        normalizedText,
        "assistant_content",
        "raw_message",
      );
    }

    return this.keep("user_message", normalizedText, "user_content", "raw_message");
  }

  private normalize(text: string): string {
    return this.stripHostMetadataEnvelope(text)
      .replace(/\s+/g, " ")
      .trim();
  }

  private stripHostMetadataEnvelope(text: string): string {
    let normalized = text;
    normalized = normalized.replace(
      /^(?:Sender|Conversation info|Message info)\s*\(untrusted metadata\)\s*:\s*```json[\s\S]*?```\s*/i,
      "",
    );
    normalized = normalized.replace(
      /^\[[^\]\r\n]{0,80}\]\s*/i,
      "",
    );
    normalized = normalized.replace(
      /^(?:Sender|Conversation info|Message info)\s*\(untrusted metadata\)\s*:\s*/i,
      "",
    );
    return normalized;
  }

  private looksLikeWrapperOnly(text: string): boolean {
    return /^(?:Conversation|Message) info\b/i.test(text);
  }

  private looksLikePseudoUser(
    text: string,
    message: RuntimeMessageSnapshot,
  ): boolean {
    if (PSEUDO_USER_PATTERNS.some((pattern) => pattern.test(text))) {
      return true;
    }

    const metadata = message.metadata;
    if (!metadata) {
      return false;
    }

    const suspectValues = [
      metadata.name,
      metadata.type,
      metadata.kind,
      metadata.source,
      metadata.origin,
      metadata.channel,
      metadata.subtype,
      metadata.status,
    ];

    return suspectValues.some((value) => {
      if (typeof value !== "string") {
        return false;
      }
      return /tool|command|process|control|system|hook|orchestr|host/i.test(value);
    });
  }

  private isLowValueToolReceipt(text: string): boolean {
    if (TOOL_RECEIPT_PATTERNS.some((pattern) => pattern.test(text))) {
      return true;
    }

    if (text.length > 120) {
      return false;
    }

    if (/\b(error|exception|failed|warning|stderr|traceback)\b/i.test(text)) {
      return false;
    }

    if (/[\r\n]/.test(text) || /```/.test(text)) {
      return false;
    }

    if (/[{}[\]=:\\/]/.test(text)) {
      return false;
    }

    return /^(?:ok|done|complete|completed|finished|success|succeeded)\b/i.test(text);
  }

  private hasInternalMetadata(message: RuntimeMessageSnapshot): boolean {
    const metadata = message.metadata;
    if (!metadata) {
      return false;
    }

    const internalCandidates = [
      metadata.internal,
      metadata.hidden,
      metadata.ephemeral,
      metadata.controlPlane,
      metadata.hostGenerated,
      metadata.persist === false,
      metadata.visibility,
      metadata.channel,
      metadata.source,
      metadata.origin,
      metadata.type,
      metadata.kind,
      metadata.subtype,
      metadata.status,
      metadata.name,
    ];

    return internalCandidates.some((value) => {
      if (value === true) {
        return true;
      }
      if (typeof value !== "string") {
        return false;
      }

      return /internal|system|control|heartbeat|host|orchestr|hook|panel|command/i.test(value);
    });
  }

  private keep(
    classification: RuntimeMessageClassification,
    normalizedText: string,
    reason: string,
    storageTarget: RuntimeMessageStorageTarget,
  ): RuntimeMessageIngressDecision {
    return {
      persist: true,
      classification,
      normalizedText,
      reason,
      storageTarget,
    };
  }

  private skip(
    classification: RuntimeMessageClassification,
    normalizedText: string,
    reason: string,
  ): RuntimeMessageIngressDecision {
    return {
      persist: false,
      classification,
      normalizedText,
      reason,
      storageTarget: "drop",
    };
  }
}
