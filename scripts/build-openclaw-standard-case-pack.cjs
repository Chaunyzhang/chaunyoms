const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

function argValue(name, fallback) {
  const prefix = `${name}=`;
  const args = process.argv.slice(2);
  const hit = args.find((arg) => arg === name || arg.startsWith(prefix));
  if (!hit) return fallback;
  if (hit === name) {
    const index = args.indexOf(hit);
    return args[index + 1] ?? fallback;
  }
  return hit.slice(prefix.length);
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }
  const [header, ...body] = rows.filter((current) => current.some((cellValue) => cellValue.length > 0));
  return body.map((current) => Object.fromEntries(header.map((key, index) => [key, current[index] ?? ""])));
}

function loadJsonlObjectMap(file) {
  const out = new Map();
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const record = JSON.parse(line);
    for (const [key, value] of Object.entries(record)) {
      out.set(key, value);
    }
  }
  return out;
}

function normalizeText(value) {
  return String(value ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

const FORMAL_QUESTION_PLUGIN_INSTRUCTION =
  "Before answering, call the OpenClaw OMS memory plugin/tool to search historical evidence. The tool query must be exactly the full Question/User question text below; do not rewrite it into keywords or guess extra terms. Answer only from returned or injected raw evidence.";

function chunkText(text, maxChars) {
  const lines = normalizeText(text).split(/\n/);
  const chunks = [];
  let current = "";
  for (const line of lines) {
    const slices = [];
    if (line.length <= maxChars) {
      slices.push(line);
    } else {
      for (let offset = 0; offset < line.length; offset += maxChars) {
        slices.push(line.slice(offset, offset + maxChars));
      }
    }
    for (const slice of slices) {
      const next = current ? `${current}\n${slice}` : slice;
      if (next.length > maxChars && current) {
        chunks.push(current);
        current = slice;
      } else {
        current = next;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function assertCaseFileBudget(text, maxChars) {
  const rendered = oneTurnMarkdown(text);
  if (rendered.length > maxChars + 128) {
    throw new Error(`Generated user message is too large: ${rendered.length} chars, budget ${maxChars}`);
  }
}

function chunkMaterial(text, maxChars) {
  const chunks = chunkText(text, maxChars);
  for (const chunk of chunks) {
    assertCaseFileBudget(chunk, maxChars);
  }
  return chunks;
}

function oneTurnMarkdown(text) {
  return `## Turn 1\n${normalizeText(text)}\n`;
}

async function writeCase(outRoot, answerRows, spec) {
  const caseDir = path.join(outRoot, "cases", spec.caseId);
  await fsp.mkdir(caseDir, { recursive: true });
  const materialFiles = [];
  spec.materialChunks.forEach((chunk, index) => {
    const file = `material-${String(index + 1).padStart(3, "0")}.md`;
    materialFiles.push(file);
    fs.writeFileSync(path.join(caseDir, file), oneTurnMarkdown(chunk), "utf8");
  });
  fs.writeFileSync(path.join(caseDir, "formal-question.md"), oneTurnMarkdown(spec.question), "utf8");
  const readme = [
    `# ${spec.caseId}`,
    "",
    "This is a sender-only OpenClaw case pack.",
    "Send every material file first using the same material session key.",
    "After OpenClaw/OMS after-turn work is ready, send formal-question.md using a fresh question session key.",
    "Do not judge inside the harness. Codex judges from OpenClaw transcript plus OMS runtime diagnostics.",
    "",
    "Material files:",
    ...materialFiles.map((file) => `- ${file}`),
    "",
    "Question file:",
    "- formal-question.md",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(caseDir, "README.md"), readme, "utf8");
  answerRows.push({
    caseId: spec.caseId,
    suite: spec.suite,
    source: spec.source,
    materialFiles: materialFiles.map((file) => path.join("cases", spec.caseId, file).replace(/\\/g, "/")),
    questionFile: path.join("cases", spec.caseId, "formal-question.md").replace(/\\/g, "/"),
    question: spec.question,
    expectedAnswer: spec.expectedAnswer,
    evidence: spec.evidence ?? [],
    metadata: spec.metadata ?? {},
  });
}

function locomoSpecs(repoRoot, limit, maxChars) {
  const source = "artifacts/datasets/locomo/locomo10.json";
  const data = readJson(path.join(repoRoot, source));
  const specs = [];
  for (const sample of data) {
    const conversation = sample.conversation ?? {};
    const sessionKeys = Object.keys(conversation)
      .filter((key) => /^session_\d+$/.test(key))
      .sort((left, right) => Number(left.slice(8)) - Number(right.slice(8)));
    const material = [
      `LOCOMO raw conversation sample_id=${sample.sample_id ?? "unknown"}.`,
      "Store these turns as source material. Do not answer any benchmark question yet.",
      "",
      ...sessionKeys.flatMap((key) => {
        const date = conversation[`${key}_date_time`] ?? "unknown date";
        return [
          `## ${key} date=${date}`,
          ...(conversation[key] ?? []).map((turn) =>
            `[${turn.dia_id ?? "?"}] ${turn.speaker ?? "speaker"}: ${turn.text ?? ""}`),
          "",
        ];
      }),
    ].join("\n");
    for (let index = 0; index < (sample.qa ?? []).length && specs.length < limit; index += 1) {
      const qa = sample.qa[index];
      specs.push({
        suite: "locomo",
        caseId: `locomo-${sample.sample_id ?? "sample"}-q${index + 1}`,
        source,
        materialChunks: chunkMaterial(material, maxChars),
        question: [
          "Answer this LOCOMO memory question from OMS-recalled raw evidence.",
          FORMAL_QUESTION_PLUGIN_INSTRUCTION,
          "Return the concise answer only unless the user asks for explanation.",
          "",
          `Question: ${qa.question}`,
        ].join("\n"),
        expectedAnswer: qa.answer,
        evidence: qa.evidence ?? [],
        metadata: { category: qa.category, sampleId: sample.sample_id },
      });
    }
    if (specs.length >= limit) break;
  }
  return specs;
}

function longMemEvalSpecs(repoRoot, limit, maxChars) {
  const source = "artifacts/datasets/longmemeval/longmemeval_s_cleaned.json";
  const data = readJson(path.join(repoRoot, source));
  return data.slice(0, limit).map((item, index) => {
    const sessions = item.haystack_sessions ?? [];
    const material = [
      `LongMemEval-S source material question_id=${item.question_id ?? index}.`,
      "Store these sessions as source material. Do not answer any benchmark question yet.",
      "",
      ...sessions.flatMap((turns, sessionIndex) => {
        const sid = item.haystack_session_ids?.[sessionIndex] ?? `session-${sessionIndex + 1}`;
        const date = item.haystack_dates?.[sessionIndex] ?? "unknown date";
        return [
          `## ${sid} date=${date}`,
          ...(turns ?? []).map((turn, turnIndex) =>
            `[${sid}:${turnIndex + 1}] ${turn.role ?? "user"}: ${turn.content ?? ""}`),
          "",
        ];
      }),
    ].join("\n");
    return {
      suite: "longmemeval-s",
      caseId: `longmemeval-s-${item.question_id ?? index}`,
      source,
      materialChunks: chunkMaterial(material, maxChars),
      question: [
        "Answer this LongMemEval memory question from OMS-recalled raw evidence.",
        FORMAL_QUESTION_PLUGIN_INSTRUCTION,
        "Return the concise answer only unless the user asks for explanation.",
        "",
        `Question date: ${item.question_date ?? "unknown"}`,
        `Question: ${item.question}`,
      ].join("\n"),
      expectedAnswer: item.answer,
      evidence: item.answer_session_ids ?? [],
      metadata: { questionType: item.question_type, questionId: item.question_id },
    };
  });
}

function personaMemSpecs(repoRoot, limit, maxChars) {
  const questionSource = "artifacts/datasets/personamem/questions_32k.csv";
  const contextSource = "artifacts/datasets/personamem/shared_contexts_32k.jsonl";
  const questions = parseCsv(fs.readFileSync(path.join(repoRoot, questionSource), "utf8"));
  const contexts = loadJsonlObjectMap(path.join(repoRoot, contextSource));
  const specs = [];
  for (const row of questions) {
    const context = contexts.get(row.shared_context_id);
    if (!Array.isArray(context)) continue;
    const material = [
      `PersonaMem 32k source material question_id=${row.question_id}.`,
      "Store this persona conversation as source material. Do not answer any benchmark question yet.",
      "",
      ...context.map((turn, index) => `[P32K:${index + 1}] ${turn.role ?? "user"}: ${turn.content ?? ""}`),
    ].join("\n");
    let options = [];
    try {
      options = JSON.parse(row.all_options);
    } catch {
      options = [];
    }
    specs.push({
      suite: "personamem-32k",
      caseId: `personamem-32k-${row.question_id}`,
      source: `${questionSource} + ${contextSource}`,
      materialChunks: chunkMaterial(material, maxChars),
      question: [
        "Answer this PersonaMem multiple-choice question from OMS-recalled raw evidence.",
        FORMAL_QUESTION_PLUGIN_INSTRUCTION,
        "Return only the option letter, for example (a), (b), (c), or (d).",
        "",
        `User question: ${row.user_question_or_message}`,
        "",
        "Options:",
        ...options.map((option) => String(option)),
      ].join("\n"),
      expectedAnswer: row.correct_answer,
      evidence: [row.shared_context_id],
      metadata: {
        questionType: row.question_type,
        topic: row.topic,
        contextLength: row.context_length_in_tokens,
      },
    });
    if (specs.length >= limit) break;
  }
  return specs;
}

function prefEvalSpecs(repoRoot, limit, maxChars) {
  const source = "artifacts/external/PrefEval/benchmark_dataset/explicit_preference/education_learning_styles.json";
  const data = readJson(path.join(repoRoot, source));
  return data.slice(0, limit).map((item, index) => {
    const material = [
      `PrefEval source preference case index=${index}.`,
      "Store this user preference as source material. Do not answer any benchmark question yet.",
      "",
      `User preference: ${item.preference}`,
    ].join("\n");
    return {
      suite: "prefeval-explicit-min",
      caseId: `prefeval-explicit-education-learning-styles-${index + 1}`,
      source,
      materialChunks: chunkMaterial(material, maxChars),
      question: [
        "Answer this preference-following question from OMS-recalled raw evidence.",
        FORMAL_QUESTION_PLUGIN_INSTRUCTION,
        "Give a helpful answer that respects the stored user preference.",
        "",
        `Question: ${item.question}`,
      ].join("\n"),
      expectedAnswer: {
        preference: item.preference,
        acceptanceCriteria: item.explanation,
      },
      evidence: ["explicit_preference"],
      metadata: { topic: "education_learning_styles", form: "explicit_preference" },
    };
  });
}

async function main() {
  const repoRoot = path.resolve(__dirname, "..");
  const outDir = path.resolve(
    repoRoot,
    argValue("--out-dir", path.join("artifacts", "openclaw-standard-case-packs", `minimal-${new Date().toISOString().replace(/[:.]/g, "-")}`)),
  );
  const casesPerSuite = parsePositiveInt(argValue("--cases-per-suite", "1"), 1);
  const maxChars = parsePositiveInt(argValue("--max-chars-per-message", "8000"), 8000);
  const selectedSuites = new Set(
    String(argValue("--suites", "locomo,longmemeval-s,personamem-32k,prefeval-explicit-min"))
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );

  const builders = {
    locomo: locomoSpecs,
    "longmemeval-s": longMemEvalSpecs,
    "personamem-32k": personaMemSpecs,
    "prefeval-explicit-min": prefEvalSpecs,
  };
  await fsp.mkdir(outDir, { recursive: true });
  const answerRows = [];
  const allSpecs = [];
  for (const [suite, builder] of Object.entries(builders)) {
    if (!selectedSuites.has(suite)) continue;
    allSpecs.push(...builder(repoRoot, casesPerSuite, maxChars));
  }
  for (const spec of allSpecs) {
    await writeCase(outDir, answerRows, spec);
  }
  const answerKeyPath = path.join(outDir, "answer-key.jsonl");
  await fsp.writeFile(answerKeyPath, `${answerRows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  const manifest = {
    createdAt: new Date().toISOString(),
    outDir: path.relative(repoRoot, outDir).replace(/\\/g, "/"),
    kind: "sender_only_openclaw_case_pack",
    casesPerSuite,
    maxCharsPerMessage: maxChars,
    suites: [...selectedSuites],
    caseCount: answerRows.length,
    answerKey: path.relative(outDir, answerKeyPath).replace(/\\/g, "/"),
    uniqueFlow: [
      "Send material-*.md one at a time with npm run openclaw:send and the same material session key.",
      "Wait for each OpenClaw turn to finish before sending the next material file.",
      "After normal OMS after-turn work is ready, send formal-question.md with a fresh question session key.",
      "Do not let the harness read transcripts, inspect OMS, score, or judge.",
      "Codex inspects OpenClaw final reply plus OMS runtime diagnostics outside the harness.",
    ],
  };
  await fsp.writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
