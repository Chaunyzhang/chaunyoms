import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { RawMessage } from "../types";

export class RawMessageStore {
  private readonly filePath: string;
  private readonly messages: RawMessage[] = [];

  constructor(private readonly baseDir: string, private readonly sessionId: string) {
    this.filePath = path.join(baseDir, `${sessionId}.raw.jsonl`);
  }

  async init(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });

    try {
      const content = await readFile(this.filePath, "utf8");
      const lines = content.split(/\r?\n/).filter(Boolean);
      this.messages.length = 0;
      let mutated = false;
      let nextSequence = 1;
      for (const line of lines) {
        const parsed = JSON.parse(line) as RawMessage;
        if (!Number.isFinite(parsed.sequence)) {
          parsed.sequence = nextSequence;
          mutated = true;
        }
        nextSequence = Math.max(nextSequence, (parsed.sequence ?? 0) + 1);
        this.messages.push(parsed);
      }
      if (mutated) {
        await this.flush();
      }
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "ENOENT") {
        throw error;
      }
    }
  }

  async append(message: RawMessage): Promise<void> {
    if (!Number.isFinite(message.sequence)) {
      message.sequence = this.nextSequence();
    }
    this.messages.push(message);
    await this.flush();
  }

  getAll(): RawMessage[] {
    return [...this.messages];
  }

  getByRange(startTurn: number, endTurn: number): RawMessage[] {
    return this.messages.filter(
      (message) => message.turnNumber >= startTurn && message.turnNumber <= endTurn,
    );
  }

  getByIds(ids: string[]): RawMessage[] {
    if (ids.length === 0) {
      return [];
    }

    const wanted = new Set(ids);
    return this.messages.filter((message) => wanted.has(message.id));
  }

  getBySequenceRange(startSequence: number, endSequence: number): RawMessage[] {
    return this.messages.filter((message) => {
      if (!Number.isFinite(message.sequence)) {
        return false;
      }
      return (message.sequence as number) >= startSequence && (message.sequence as number) <= endSequence;
    });
  }

  getRecentTail(turnCount: number): RawMessage[] {
    if (turnCount <= 0) {
      return [];
    }

    const turnNumbers = [...new Set(this.messages.map((message) => message.turnNumber))];
    const protectedTurns = new Set(turnNumbers.slice(-turnCount));
    return this.messages.filter((message) => protectedTurns.has(message.turnNumber));
  }

  getRecentTailByTokens(tokenBudget: number, maxTurns: number): RawMessage[] {
    if (tokenBudget <= 0 || maxTurns <= 0) {
      return [];
    }

    const turnOrder = [...new Set(this.messages.map((message) => message.turnNumber))];
    const selectedTurns: number[] = [];
    let consumed = 0;

    for (let index = turnOrder.length - 1; index >= 0; index -= 1) {
      const turnNumber = turnOrder[index];
      const turnTokens = this.messages
        .filter((message) => message.turnNumber === turnNumber)
        .reduce((sum, message) => sum + message.tokenCount, 0);

      if (selectedTurns.length > 0 && consumed + turnTokens > tokenBudget) {
        break;
      }

      selectedTurns.unshift(turnNumber);
      consumed += turnTokens;

      if (selectedTurns.length >= maxTurns) {
        break;
      }
    }

    const selectedTurnSet = new Set(selectedTurns);
    return this.messages.filter((message) => selectedTurnSet.has(message.turnNumber));
  }

  totalUncompactedTokens(): number {
    return this.messages.reduce((total, message) => {
      return total + (message.compacted ? 0 : message.tokenCount);
    }, 0);
  }

  getUncompactedMessages(): RawMessage[] {
    return this.messages.filter((message) => !message.compacted);
  }

  async markCompacted(startTurn: number, endTurn: number): Promise<void> {
    let changed = false;

    for (const message of this.messages) {
      if (message.turnNumber >= startTurn && message.turnNumber <= endTurn && !message.compacted) {
        message.compacted = true;
        changed = true;
      }
    }

    if (changed) {
      await this.flush();
    }
  }

  private async flush(): Promise<void> {
    const serialized = this.messages.map((message) => JSON.stringify(message)).join("\n");
    await writeFile(this.filePath, serialized.length > 0 ? `${serialized}\n` : "", "utf8");
  }

  private nextSequence(): number {
    const lastSequence = this.messages[this.messages.length - 1]?.sequence;
    return Number.isFinite(lastSequence) ? (lastSequence as number) + 1 : 1;
  }
}
