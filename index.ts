import { OpenClawBridge } from "./src/OpenClawBridge";

const bridge = new OpenClawBridge();

const plugin = {
  id: "chaunyoms",
  name: "Chaunyoms",
  description: "Lightweight oms context engine plugin for OpenClaw",
  kind: "context-engine",
  configSchema: {
    type: "object",
    additionalProperties: true,
    properties: {},
  },
  register(api: unknown): void {
    bridge.register(api);
  },
};

export default plugin;
