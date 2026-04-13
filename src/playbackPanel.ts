import * as path from "node:path";
import * as vscode from "vscode";

export interface PlaybackPanelOptions {
  audioPath: string;
  title: string;
  sourceLabel: string;
  onTimeUpdate: (seconds: number) => void;
  onPlaybackEnded: () => void;
  onPanelClosed: () => void;
}

export class PlaybackPanel {
  private static currentPanel?: PlaybackPanel;

  static show(extensionUri: vscode.Uri, options: PlaybackPanelOptions): PlaybackPanel {
    PlaybackPanel.currentPanel?.dispose();
    PlaybackPanel.currentPanel = new PlaybackPanel(extensionUri, options);
    return PlaybackPanel.currentPanel;
  }

  static closeCurrent(): void {
    PlaybackPanel.currentPanel?.dispose();
    PlaybackPanel.currentPanel = undefined;
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(extensionUri: vscode.Uri, private readonly options: PlaybackPanelOptions) {
    this.panel = vscode.window.createWebviewPanel(
      "kokorosTtsPlayer",
      options.title,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(path.dirname(options.audioPath)), extensionUri]
      }
    );

    this.panel.webview.html = this.renderHtml();
    this.panel.onDidDispose(() => {
      this.options.onPanelClosed();
      PlaybackPanel.currentPanel = undefined;
    }, null, this.disposables);

    this.panel.webview.onDidReceiveMessage((message) => {
      if (message?.type === "time" && typeof message.currentTime === "number") {
        this.options.onTimeUpdate(message.currentTime);
      }

      if (message?.type === "ended") {
        this.options.onPlaybackEnded();
      }
    }, null, this.disposables);
  }

  dispose(): void {
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  private renderHtml(): string {
    const webview = this.panel.webview;
    const audioUri = webview.asWebviewUri(vscode.Uri.file(this.options.audioPath));
    const sourceName = escapeHtml(this.options.sourceLabel);
    const title = escapeHtml(this.options.title);
    const audioFileName = escapeHtml(path.basename(this.options.audioPath));

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      body {
        margin: 0;
        padding: 20px;
        background: linear-gradient(180deg, rgba(56, 178, 172, 0.16), transparent 160px);
        color: var(--vscode-editor-foreground);
      }

      .card {
        max-width: 840px;
        margin: 0 auto;
        background: color-mix(in srgb, var(--vscode-editor-background) 92%, #0f766e 8%);
        border: 1px solid color-mix(in srgb, var(--vscode-editor-foreground) 12%, transparent);
        border-radius: 14px;
        padding: 20px;
        box-shadow: 0 16px 48px rgba(0, 0, 0, 0.12);
      }

      h1 {
        margin: 0 0 6px;
        font-size: 1.3rem;
      }

      p {
        margin: 0 0 16px;
        line-height: 1.5;
        opacity: 0.85;
      }

      audio {
        width: 100%;
      }

      .path {
        margin-top: 16px;
        font-family: ui-monospace, "SFMono-Regular", Menlo, monospace;
        font-size: 0.84rem;
        opacity: 0.75;
        word-break: break-word;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${title}</h1>
      <p>${sourceName}</p>
      <audio id="player" controls autoplay src="${audioUri}"></audio>
      <div class="path">Generated file: ${audioFileName}</div>
    </div>
    <script>
      const vscode = acquireVsCodeApi();
      const player = document.getElementById("player");

      player.addEventListener("timeupdate", () => {
        vscode.postMessage({ type: "time", currentTime: player.currentTime });
      });

      player.addEventListener("ended", () => {
        vscode.postMessage({ type: "ended" });
      });

      player.play().catch(() => {});
    </script>
  </body>
</html>`;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
