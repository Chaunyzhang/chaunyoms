import {
  RawMessageRepository,
  RecallResult,
  SummaryRepository,
} from "../types";
import { RawRecallResolver } from "./RawRecallResolver";
import { RecallQueryAnalyzer } from "./RecallQueryAnalyzer";
import { RecallOptions } from "./RecallShared";
import { SummaryNavigationRecallResolver } from "./SummaryNavigationRecallResolver";

export class RecallResolver {
  private readonly queryAnalyzer = new RecallQueryAnalyzer();
  private readonly rawRecall = new RawRecallResolver();
  private readonly summaryNavigation = new SummaryNavigationRecallResolver();

  resolve(
    query: string,
    summaryStore: SummaryRepository,
    rawStore: RawMessageRepository,
    recallBudget: number,
    options: RecallOptions = {},
  ): RecallResult {
    const understanding = this.queryAnalyzer.analyze(query);
    if (this.queryAnalyzer.shouldUseRawFirst(understanding, options)) {
      const rawResult = this.rawRecall.resolve(query, understanding, rawStore, recallBudget, options);
      if (rawResult.items.length > 0 || (rawResult.answerCandidates?.length ?? 0) > 0) {
        return rawResult;
      }
    }

    return this.summaryNavigation.resolve(query, summaryStore, rawStore, recallBudget, options);
  }
}

export type { RecallOptions } from "./RecallShared";
