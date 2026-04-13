import * as vscode from "vscode";

import { buildHighlightSegments, estimateSegmentEndTimes } from "./textProcessing";

interface TimedSegment {
  range: vscode.Range;
  endTime: number;
}

interface ActiveSession {
  editor: vscode.TextEditor;
  segments: TimedSegment[];
  activeIndex: number;
}

export class PlaybackHighlighter implements vscode.Disposable {
  private readonly decorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("editor.wordHighlightStrongBackground"),
    border: "1px solid",
    borderColor: new vscode.ThemeColor("editor.wordHighlightStrongBorder"),
    borderRadius: "4px"
  });

  private activeSession?: ActiveSession;

  start(editor: vscode.TextEditor, startOffset: number, rawText: string, durationSeconds: number): void {
    this.clear();

    const segments = buildHighlightSegments(rawText);
    if (!segments.length || durationSeconds <= 0) {
      return;
    }

    const endTimes = estimateSegmentEndTimes(segments, durationSeconds);
    const timedSegments = segments.map((segment, index) => ({
      range: new vscode.Range(
        editor.document.positionAt(startOffset + segment.rawStart),
        editor.document.positionAt(startOffset + segment.rawEnd)
      ),
      endTime: endTimes[index] ?? durationSeconds
    }));

    this.activeSession = {
      editor,
      segments: timedSegments,
      activeIndex: -1
    };
  }

  update(currentTimeSeconds: number): void {
    const session = this.activeSession;
    if (!session) {
      return;
    }

    const activeIndex = session.segments.findIndex((segment) => currentTimeSeconds <= segment.endTime);
    if (activeIndex === session.activeIndex) {
      return;
    }

    session.activeIndex = activeIndex;
    if (activeIndex < 0) {
      session.editor.setDecorations(this.decorationType, []);
      return;
    }

    session.editor.setDecorations(this.decorationType, [session.segments[activeIndex].range]);
  }

  clear(): void {
    if (this.activeSession) {
      this.activeSession.editor.setDecorations(this.decorationType, []);
    }

    this.activeSession = undefined;
  }

  dispose(): void {
    this.clear();
    this.decorationType.dispose();
  }
}
