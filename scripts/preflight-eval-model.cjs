const fsp = require("node:fs/promises");
const path = require("node:path");

const {
  resolveDefaultEvalBaseUrl,
  resolveDefaultEvalModel,
  resolveDefaultEvalApi,
  resolveEvalApiKey,
  preflightEvalModel,
} = require("./eval-model-client.cjs");

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

async function main() {
  const argv = process.argv.slice(2);
  const baseUrl = argValue("--base-url", resolveDefaultEvalBaseUrl(argv));
  const model = argValue("--model", resolveDefaultEvalModel(baseUrl, argv));
  const api = argValue("--api", resolveDefaultEvalApi(baseUrl, argv));
  const apiKey = resolveEvalApiKey(baseUrl, api, argv);
  const outPath = argValue("--out", "");
  const result = await preflightEvalModel({
    baseUrl,
    api,
    apiKey,
    model,
  });
  const payload = {
    ...result,
    apiKey: apiKey ? "set" : "missing",
    checkedAt: new Date().toISOString(),
  };
  if (outPath) {
    await fsp.mkdir(path.dirname(outPath), { recursive: true });
    await fsp.writeFile(outPath, JSON.stringify(payload, null, 2), "utf8");
  }
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
