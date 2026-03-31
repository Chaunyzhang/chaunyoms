import { ContextItem } from "../types";

export class ContextViewStore {
  private items: ContextItem[] = [];

  setItems(items: ContextItem[]): void {
    this.items = [...items];
  }

  getItems(): ContextItem[] {
    return [...this.items];
  }

  clear(): void {
    this.items = [];
  }
}
