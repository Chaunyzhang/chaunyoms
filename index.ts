import { OpenClawBridge } from "./src/OpenClawBridge";

const bridge = new OpenClawBridge();

const plugin = {
  id: "lossless-lite",
  name: "Lossless Lite",
  description: "Lightweight lossless context engine plugin for OpenClaw",
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
