import { StablePrefixAdapter } from "../data/StablePrefixAdapter";
import { ContextViewStore } from "../stores/ContextViewStore";
import { WorkspaceBootstrapTokenEstimator } from "../host/WorkspaceBootstrapTokenEstimator";
import { RuntimeLayerDependencies } from "./ChaunyomsSessionRuntime";

export function createRuntimeLayerDependencies(): RuntimeLayerDependencies {
  const sharedAdapter = new StablePrefixAdapter();
  return {
    contextViewStore: new ContextViewStore(),
    fixedPrefixProvider: sharedAdapter,
    navigationRepository: sharedAdapter,
    hostFixedContextProvider: new WorkspaceBootstrapTokenEstimator(),
  };
}
