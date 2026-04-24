import { OpenClawBridge } from "./src/OpenClawBridge";
import { pluginConfigSchema } from "./src/pluginConfigSchema";
import { OpenClawApiLike } from "./src/host/OpenClawHostTypes";

const bridge = new OpenClawBridge();

const plugin = {
  id: "chaunyoms",
  name: "Chaunyoms",
  description: "Lightweight oms context engine plugin for OpenClaw",
  kind: "context-engine",
  configSchema: pluginConfigSchema,
  register(api: OpenClawApiLike): void {
    bridge.register(api);
  },
};

export default plugin;
