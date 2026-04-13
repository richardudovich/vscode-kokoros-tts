import * as vscode from "vscode";

type QueueEntryState = "queued" | "running";

interface QueueEntry {
  id: string;
  label: string;
  detail: string;
  enqueuedAt: number;
  state: QueueEntryState;
  resolveTurn: () => void;
  rejectTurn: (error: Error) => void;
}

export interface QueueTicket {
  id: string;
  aheadCount: number;
  waitForTurn(): Promise<void>;
  cancelQueued(): boolean;
  finish(): void;
}

export class QueueTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    description: string | undefined,
    tooltip: string,
    public readonly kind: "summary" | "active" | "queued",
    public readonly entryId?: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.tooltip = tooltip;

    if (kind === "active") {
      this.iconPath = new vscode.ThemeIcon("sync~spin");
      this.contextValue = "activeItem";
      return;
    }

    if (kind === "queued") {
      this.iconPath = new vscode.ThemeIcon("clock");
      this.contextValue = "queuedItem";
      return;
    }

    this.iconPath = new vscode.ThemeIcon("list-unordered");
    this.contextValue = "summaryItem";
  }
}

export class SpeechQueueManager implements vscode.TreeDataProvider<QueueTreeItem>, vscode.Disposable {
  private active?: QueueEntry;
  private readonly pending: QueueEntry[] = [];
  private readonly treeEmitter = new vscode.EventEmitter<QueueTreeItem | undefined | void>();
  private readonly stateEmitter = new vscode.EventEmitter<void>();

  readonly onDidChangeTreeData = this.treeEmitter.event;
  readonly onDidChangeState = this.stateEmitter.event;

  enqueue(label: string, detail: string): QueueTicket {
    let resolveTurn: () => void = () => undefined;
    let rejectTurn: (error: Error) => void = () => undefined;
    const turn = new Promise<void>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = (error) => reject(error);
    });

    const entry: QueueEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      label,
      detail,
      enqueuedAt: Date.now(),
      state: "queued",
      resolveTurn,
      rejectTurn
    };

    const aheadCount = (this.active ? 1 : 0) + this.pending.length;

    if (aheadCount === 0) {
      entry.state = "running";
      this.active = entry;
      entry.resolveTurn();
    } else {
      this.pending.push(entry);
    }

    this.emitChange();

    return {
      id: entry.id,
      aheadCount,
      waitForTurn: () => turn,
      cancelQueued: () => this.removeQueued(entry.id),
      finish: () => {
        if (this.active?.id !== entry.id) {
          return;
        }

        this.active = undefined;
        this.promoteNext();
        this.emitChange();
      }
    };
  }

  getPendingCount(): number {
    return this.pending.length;
  }

  clearPending(): number {
    const removed = this.pending.splice(0, this.pending.length);
    for (const entry of removed) {
      entry.rejectTurn(new Error("Kokoros request removed from queue."));
    }

    if (removed.length) {
      this.emitChange();
    }

    return removed.length;
  }

  removeQueued(id: string): boolean {
    const index = this.pending.findIndex((entry) => entry.id === id);
    if (index === -1) {
      return false;
    }

    const [entry] = this.pending.splice(index, 1);
    entry.rejectTurn(new Error("Kokoros request removed from queue."));
    this.emitChange();
    return true;
  }

  getTreeItem(element: QueueTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): QueueTreeItem[] {
    const items: QueueTreeItem[] = [];

    if (!this.active && !this.pending.length) {
      items.push(new QueueTreeItem("Queue empty", undefined, "No Kokoros requests are waiting.", "summary"));
      return items;
    }

    const summary = `${this.active ? "1 running" : "0 running"} · ${this.pending.length} queued`;
    items.push(new QueueTreeItem("Kokoros queue", summary, "Serialized Kokoros speech requests.", "summary"));

    if (this.active) {
      items.push(new QueueTreeItem(
        this.active.label,
        this.active.detail,
        `Running now\n${this.active.detail}`,
        "active",
        this.active.id
      ));
    }

    this.pending.forEach((entry, index) => {
      items.push(new QueueTreeItem(
        entry.label,
        `#${index + 1} · ${entry.detail}`,
        `Queued\n${entry.detail}`,
        "queued",
        entry.id
      ));
    });

    return items;
  }

  dispose(): void {
    this.clearPending();
    this.treeEmitter.dispose();
    this.stateEmitter.dispose();
  }

  private promoteNext(): void {
    const next = this.pending.shift();
    if (!next) {
      return;
    }

    next.state = "running";
    this.active = next;
    next.resolveTurn();
  }

  private emitChange(): void {
    this.treeEmitter.fire();
    this.stateEmitter.fire();
  }
}
