import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { EvalCaseDefinition, EvalExplicitMessage, EvalSuiteDefinition } from "./types";

const LOCOMO_DATA_URL = "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json";
const DEFAULT_OUTPUT = path.join("artifacts", "evals", "locomo-medium-suite.json");
const DEFAULT_CACHE = path.join("artifacts", "datasets", "locomo", "locomo10.json");
const TARGET_CASES = 24;
const CATEGORY_QUOTA = 8;

interface LoCoMoTurn {
  speaker: string;
  dia_id: string;
  text: string;
  blip_caption?: string;
}

interface LoCoMoQa {
  question: string;
  answer: string | number | boolean;
  category: number;
  evidence?: string[];
}

interface LoCoMoSample {
  sample_id: string;
  qa: LoCoMoQa[];
  conversation: Record<string, unknown> & {
    speaker_a?: string;
    speaker_b?: string;
  };
}

interface BuildOptions {
  outputPath: string;
  cachePath: string;
  maxCases: number;
}

function parseArgs(argv: string[]): BuildOptions {
  const options: BuildOptions = {
    outputPath: process.env.CHAUNYOMS_LOCOMO_SUITE ?? DEFAULT_OUTPUT,
    cachePath: process.env.CHAUNYOMS_LOCOMO_CACHE ?? DEFAULT_CACHE,
    maxCases: Number(process.env.CHAUNYOMS_LOCOMO_MAX_CASES ?? TARGET_CASES),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") {
      options.outputPath = argv[index + 1] ?? options.outputPath;
      index += 1;
      continue;
    }
    if (arg.startsWith("--out=")) {
      options.outputPath = arg.slice("--out=".length);
      continue;
    }
    if (arg === "--cache") {
      options.cachePath = argv[index + 1] ?? options.cachePath;
      index += 1;
      continue;
    }
    if (arg.startsWith("--cache=")) {
      options.cachePath = arg.slice("--cache=".length);
      continue;
    }
    if (arg === "--max-cases") {
      options.maxCases = Number(argv[index + 1] ?? options.maxCases);
      index += 1;
      continue;
    }
    if (arg.startsWith("--max-cases=")) {
      options.maxCases = Number(arg.slice("--max-cases=".length));
    }
  }

  if (!Number.isFinite(options.maxCases) || options.maxCases <= 0) {
    options.maxCases = TARGET_CASES;
  }
  return options;
}

async function readCachedOrDownload(cachePath: string): Promise<string> {
  try {
    return await readFile(cachePath, "utf8");
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== "ENOENT") {
      throw error;
    }
  }

  const response = await fetch(LOCOMO_DATA_URL);
  if (!response.ok) {
    throw new Error(`Failed to download LoCoMo data: ${response.status} ${response.statusText}`);
  }
  const data = await response.text();
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, data, "utf8");
  return data;
}

function sessionNumber(key: string): number {
  return Number(key.match(/^session_(\d+)$/)?.[1] ?? 0);
}

function conversationMessages(sample: LoCoMoSample): EvalExplicitMessage[] {
  const speakerA = sample.conversation.speaker_a;
  const sessionKeys = Object.keys(sample.conversation)
    .filter((key) => /^session_\d+$/.test(key))
    .sort((left, right) => sessionNumber(left) - sessionNumber(right));
  const messages: EvalExplicitMessage[] = [];

  for (const sessionKey of sessionKeys) {
    const turns = sample.conversation[sessionKey];
    if (!Array.isArray(turns)) {
      continue;
    }
    const sessionDate = String(sample.conversation[`${sessionKey}_date_time`] ?? "unknown date");
    for (const turn of turns as LoCoMoTurn[]) {
      const role: EvalExplicitMessage["role"] = turn.speaker === speakerA ? "user" : "assistant";
      const imageCaption = turn.blip_caption ? ` Image caption: ${turn.blip_caption}` : "";
      messages.push({
        role,
        content: [
          `LoCoMo ${sample.sample_id}`,
          `${sessionKey} date ${sessionDate}`,
          `${turn.dia_id}`,
          `${turn.speaker}: ${turn.text}${imageCaption}`,
        ].join(" | "),
      });
    }
  }

  return messages;
}

function dialogIndex(sample: LoCoMoSample): Map<string, LoCoMoTurn> {
  const index = new Map<string, LoCoMoTurn>();
  for (const [key, value] of Object.entries(sample.conversation)) {
    if (!/^session_\d+$/.test(key) || !Array.isArray(value)) {
      continue;
    }
    for (const turn of value as LoCoMoTurn[]) {
      index.set(turn.dia_id, turn);
    }
  }
  return index;
}

function findCasePreservedNeedle(haystack: string, needle: string): string | null {
  const start = haystack.toLowerCase().indexOf(needle.toLowerCase());
  return start >= 0 ? haystack.slice(start, start + needle.length) : null;
}

function answerNeedle(qa: LoCoMoQa, evidenceText: string): string | null {
  const answer = String(qa.answer).replace(/\s+/g, " ").trim();
  if (answer.length < 2 || answer.length > 90) {
    return null;
  }
  return findCasePreservedNeedle(evidenceText, answer);
}

function sanitizeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

function allCandidateCases(samples: LoCoMoSample[]): Map<number, EvalCaseDefinition[]> {
  const byCategory = new Map<number, EvalCaseDefinition[]>();

  for (const sample of samples) {
    const messages = conversationMessages(sample);
    const dialogs = dialogIndex(sample);
    for (const qa of sample.qa) {
      const category = Number(qa.category);
      if (category < 1 || category > 4) {
        continue;
      }
      const evidenceTurns = (qa.evidence ?? []).flatMap((id) => {
        const turn = dialogs.get(id);
        return turn ? [turn] : [];
      });
      if (evidenceTurns.length === 0) {
        continue;
      }
      const evidenceText = evidenceTurns.map((turn) => `${turn.dia_id} ${turn.speaker}: ${turn.text} ${turn.blip_caption ?? ""}`).join("\n");
      const expectedAnswer = answerNeedle(qa, evidenceText);
      if (!expectedAnswer) {
        continue;
      }

      const caseDef: EvalCaseDefinition = {
        id: `locomo-${sample.sample_id}-cat${category}-${sanitizeId(qa.question)}`,
        title: `LoCoMo ${sample.sample_id} category ${category}`,
        description: `Real LoCoMo QA item. Expected answer phrase is checked against source dialogue evidence (${(qa.evidence ?? []).join(", ")}).`,
        tags: ["locomo", `locomo_category_${category}`, "exact_fact", "source_verified"],
        mode: "retrieve",
        query: `History recall: ${qa.question}`,
        messages,
        afterTurnEvery: 8,
        configOverrides: {
          contextWindow: 520,
          contextThreshold: 0.34,
          freshTailTokens: 36,
          maxFreshTailTurns: 1,
          compactionBatchTurns: 8,
          summaryMaxOutputTokens: 360,
          strictCompaction: true,
          compactionBarrierEnabled: true,
        },
        expected: {
          mustInclude: [expectedAnswer],
          requireSourceVerified: true,
          minSummaryCount: 4,
          detailEquals: {
            retrievalHitType: "raw_history_recall",
          },
        },
      };
      const candidates = byCategory.get(category) ?? [];
      candidates.push(caseDef);
      byCategory.set(category, candidates);
    }
  }

  return byCategory;
}

function candidateCases(samples: LoCoMoSample[], maxCases: number): EvalCaseDefinition[] {
  const byCategory = allCandidateCases(samples);
  const selected: EvalCaseDefinition[] = [];
  const categories = [1, 2, 3, 4];
  let cursor = 0;

  while (selected.length < maxCases && categories.some((category) => (byCategory.get(category) ?? []).length > 0)) {
    const category = categories[cursor % categories.length];
    cursor += 1;
    const candidates = byCategory.get(category) ?? [];
    const next = candidates.shift();
    if (next) {
      selected.push(next);
    }
  }

  return selected;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const raw = await readCachedOrDownload(options.cachePath);
  const samples = JSON.parse(raw) as LoCoMoSample[];
  const cases = candidateCases(samples, options.maxCases);
  const categories = cases.reduce<Record<string, number>>((counts, item) => {
    const tag = item.tags.find((candidate) => candidate.startsWith("locomo_category_")) ?? "locomo_category_unknown";
    counts[tag] = (counts[tag] ?? 0) + 1;
    return counts;
  }, {});

  const suite: EvalSuiteDefinition = {
    suiteId: "locomo-medium-source-recall-v1",
    title: "ChaunyOMS LoCoMo Medium Source Recall Evaluation",
    description: [
      "Medium deterministic evaluation derived from the official LoCoMo locomo10.json release.",
      "The suite checks whether ChaunyOMS can traverse compacted history back to source dialogue evidence and recover answer phrases that appear in annotated evidence turns.",
      `Source: ${LOCOMO_DATA_URL}`,
      `Generated cases: ${cases.length}; category mix: ${JSON.stringify(categories)}.`,
      "The downloaded dataset and generated suite live under artifacts/ and are intentionally not committed.",
    ].join(" "),
    cases,
  };

  await mkdir(path.dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${JSON.stringify(suite, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ outputPath: options.outputPath, cachePath: options.cachePath, cases: cases.length, categories }, null, 2));
}

void main();
