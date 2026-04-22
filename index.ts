import { OpenClawBridge } from "./src/OpenClawBridge";
import { pluginConfigSchema } from "./src/pluginConfigSchema";

const bridge = new OpenClawBridge();

const plugin = {
  id: "chaunyoms",
  name: "Chaunyoms",
  description: "Lightweight oms context engine plugin for OpenClaw",
  kind: "context-engine",
  configSchema: pluginConfigSchema,
  register(api: unknown): void {
    bridge.register(api);
  },
};

export default plugin;
