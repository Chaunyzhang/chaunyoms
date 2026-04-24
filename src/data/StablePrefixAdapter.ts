import { StablePrefixStore } from "../stores/StablePrefixStore";
import { FixedPrefixProvider, NavigationRepository, PrefixLoadOptions } from "../types";

export class StablePrefixAdapter implements FixedPrefixProvider, NavigationRepository {
  constructor(private readonly store = new StablePrefixStore()) {}

  async load(
    sharedDataDir: string,
    workspaceDir: string,
    budget: number,
    options?: PrefixLoadOptions,
  ) {
    return await this.store.load(sharedDataDir, workspaceDir, budget, options);
  }

  async getSharedInsightHit(sharedDataDir: string, query: string) {
    return await this.store.getSharedInsightHit(sharedDataDir, query);
  }

  async getKnowledgeBaseHit(sharedDataDir: string, query: string) {
    return await this.store.getKnowledgeBaseHit(sharedDataDir, query);
  }

  async hasSharedInsightHint(sharedDataDir: string, query: string) {
    return await this.store.hasSharedInsightHint(sharedDataDir, query);
  }

  async hasKnowledgeBaseTopicHit(sharedDataDir: string, query: string) {
    return await this.store.hasKnowledgeBaseTopicHit(sharedDataDir, query);
  }

  async getNavigationHit(workspaceDir: string, query: string) {
    return await this.store.getNavigationHit(workspaceDir, query);
  }

  async getNavigationStateHit(workspaceDir: string, query: string) {
    return await this.store.getNavigationStateHit(workspaceDir, query);
  }

  async hasNavigationHint(workspaceDir: string, query: string) {
    return await this.store.hasNavigationHint(workspaceDir, query);
  }

  async hasStructuredNavigationState(workspaceDir: string) {
    return await this.store.hasStructuredNavigationState(workspaceDir);
  }

  async writeNavigationSnapshot(workspaceDir: string, content: string) {
    return await this.store.writeNavigationSnapshot(workspaceDir, content);
  }
}
