import { OpenClawBridge } from "./src/OpenClawBridge";
import { pluginConfigSchema } from "./src/pluginConfigSchema";
import { OpenClawApiLike } from "./src/host/OpenClawHostTypes";

const bridge = new OpenClawBridge();

const plugin = {
  id: "oms",
  name: "ChaunyOMS",
  description:
    "Authoritative OpenClaw memory and contextEngine substrate backed by ChaunyOMS SQLite. Markdown is export-only, never a runtime fact source.",
  kind: "memory",
  configSchema: pluginConfigSchema,
  register(api: OpenClawApiLike): void {
    bridge.register(api);
  },
};

export default plugin;
