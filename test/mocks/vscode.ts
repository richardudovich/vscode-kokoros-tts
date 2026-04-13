export enum TreeItemCollapsibleState {
  None = 0
}

export class ThemeIcon {
  constructor(public readonly id: string) {}
}

export class TreeItem {
  description?: string;
  tooltip?: string;
  iconPath?: unknown;
  contextValue?: string;

  constructor(
    public readonly label: string,
    public readonly collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None
  ) {}
}

export class EventEmitter<T> {
  readonly event = () => ({ dispose: () => undefined });

  fire(_data?: T): void {}

  dispose(): void {}
}
