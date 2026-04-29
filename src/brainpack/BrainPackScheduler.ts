import { BridgeConfig } from "../types";

export interface BrainPackScheduleState {
  lastSnapshotAt?: string;
  lastSnapshotTurn?: number;
  currentTurn?: number;
  now?: Date;
  manual?: boolean;
}

export interface BrainPackScheduleDecision {
  shouldExport: boolean;
  reason: "manual" | "turn_count" | "interval" | "disabled" | "not_due";
  dueInTurns?: number;
  dueInMs?: number;
}

export class BrainPackScheduler {
  shouldExport(config: BridgeConfig, state: BrainPackScheduleState): BrainPackScheduleDecision {
    if (!config.brainPackEnabled) {
      return { shouldExport: false, reason: "disabled" };
    }
    if (state.manual) {
      return { shouldExport: true, reason: "manual" };
    }
    const currentTurn = state.currentTurn ?? 0;
    const lastTurn = state.lastSnapshotTurn ?? 0;
    const dueInTurns = Math.max(config.brainPackTurnInterval - Math.max(currentTurn - lastTurn, 0), 0);
    if (currentTurn > 0 && dueInTurns === 0) {
      return { shouldExport: true, reason: "turn_count", dueInTurns: 0 };
    }
    const now = state.now ?? new Date();
    const lastSnapshotAt = state.lastSnapshotAt ? Date.parse(state.lastSnapshotAt) : Number.NaN;
    const intervalMs = config.brainPackIntervalHours * 60 * 60 * 1000;
    if (Number.isFinite(lastSnapshotAt)) {
      const dueInMs = Math.max(intervalMs - (now.getTime() - lastSnapshotAt), 0);
      if (dueInMs === 0) {
        return { shouldExport: true, reason: "interval", dueInTurns };
      }
      return { shouldExport: false, reason: "not_due", dueInTurns, dueInMs };
    }
    return { shouldExport: false, reason: "not_due", dueInTurns, dueInMs: intervalMs };
  }
}
