import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import { synthesizeSpeech } from "./audioClient";
import { getSettings, isServerConfigurationChange } from "./config";
import { PlaybackHighlighter } from "./highlighting";
import { adoptDetectedKokorosSetup, installKokorosDependencies, promptToInstallKokoros } from "./installer";
import { deleteAllGeneratedAudioFiles, deleteGeneratedAudioFile, ensureAudioLibrary, formatFileSize, listGeneratedAudioFiles } from "./library";
import { PlaybackPanel } from "./playbackPanel";
import { QueueTreeItem, SpeechQueueManager } from "./queue";
import { discoverKokorosServers, stopServerPid } from "./serverDiscovery";
import { KokorosServerManager } from "./serverManager";
import { stripMarkdownForSpeech } from "./textProcessing";

type SpeakMode = "selection" | "document";
type RuntimePhase = "idle" | "starting" | "generating" | "playing";

interface SpeakTarget {
  rawText: string;
  startOffset: number;
  sourceLabel: string;
}

interface RuntimeState {
  phase: RuntimePhase;
  queuedCount: number;
  abortController?: AbortController;
  playbackPath?: string;
}

interface SpeakRequest {
  target: SpeakTarget;
  editor: vscode.TextEditor;
  settings: ReturnType<typeof getSettings>;
  spokenText: string;
}

interface ReadyAudio extends SpeakRequest {
  outputPath: string;
  durationSeconds: number;
}

export function activate(context: vscode.ExtensionContext): void {
  const serverManager = new KokorosServerManager();
  const highlighter = new PlaybackHighlighter();
  const queueManager = new SpeechQueueManager();
  const runtimeState: RuntimeState = { phase: "idle", queuedCount: 0 };
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  const queueView = vscode.window.createTreeView("kokorosTts.queueView", {
    treeDataProvider: queueManager,
    showCollapseAll: false
  });

  context.subscriptions.push(serverManager, highlighter, statusBar, queueManager, queueView);
  updateStatusBar(statusBar, runtimeState);
  context.subscriptions.push(queueManager.onDidChangeState(() => {
    syncQueueState(runtimeState, queueManager, statusBar);
  }));

  context.subscriptions.push(registerSafeCommand("kokorosTts.speakSelection", serverManager, async (...args: unknown[]) => {
    await speakFromEditor(context, serverManager, highlighter, queueManager, runtimeState, statusBar, "selection", args);
  }));

  context.subscriptions.push(registerSafeCommand("kokorosTts.speakDocument", serverManager, async (...args: unknown[]) => {
    await speakFromEditor(context, serverManager, highlighter, queueManager, runtimeState, statusBar, "document", args);
  }));

  context.subscriptions.push(registerSafeCommand("kokorosTts.startServer", serverManager, async () => {
    const settings = getSettings();
    let ready = false;
    setPhase(runtimeState, statusBar, "starting");
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Kokoros TTS",
        cancellable: false
      },
      async (progress) => {
        progress.report({ message: "Making sure a Kokoros server is available..." });
        ready = await ensureServerReady(context, serverManager, settings, (message) => {
          progress.report({ message });
          serverManager.log(message);
        });
      }
    );
    setPhase(runtimeState, statusBar, "idle");
    if (ready) {
      vscode.window.showInformationMessage(`Kokoros server is ready on port ${settings.port}.`);
    }
  }));

  context.subscriptions.push(registerSafeCommand("kokorosTts.stopServer", serverManager, async () => {
    const settings = getSettings();
    const stopped = await stopConfiguredServers(serverManager, settings.port);
    highlighter.clear();
    if (runtimeState.phase === "playing") {
      PlaybackPanel.closeCurrent();
    }
    setPhase(runtimeState, statusBar, "idle");
    if (stopped) {
      vscode.window.showInformationMessage(`Stopped ${stopped} Kokoros server process${stopped === 1 ? "" : "es"} on port ${settings.port}.`);
    } else {
      vscode.window.showInformationMessage(`No Kokoros server was running on port ${settings.port}.`);
    }
  }));

  context.subscriptions.push(registerSafeCommand("kokorosTts.restartServer", serverManager, async () => {
    const settings = getSettings();
    setPhase(runtimeState, statusBar, "starting");
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Kokoros TTS",
        cancellable: false
      },
      async (progress) => {
        progress.report({ message: "Stopping any existing Kokoros server..." });
        await stopConfiguredServers(serverManager, settings.port);
        progress.report({ message: "Restarting local Kokoros server..." });
        await serverManager.restart(settings);
      }
    );
    setPhase(runtimeState, statusBar, "idle");
    vscode.window.showInformationMessage(`Kokoros server restarted on port ${settings.port}.`);
  }));

  context.subscriptions.push(registerSafeCommand("kokorosTts.checkSetup", serverManager, async () => {
    const settings = getSettings();
    const report = await serverManager.buildSetupReport(settings);
    const document = await vscode.workspace.openTextDocument({
      content: report,
      language: "text"
    });

    await vscode.window.showTextDocument(document, { preview: false });
    serverManager.revealLogs();
  }));

  context.subscriptions.push(registerSafeCommand("kokorosTts.installDependencies", serverManager, async () => {
    const installed = await installKokorosDependencies(context, getSettings());
    if (installed) {
      const refreshedSettings = getSettings();
      await serverManager.ensureRunning(refreshedSettings, (message) => {
        serverManager.log(message);
      });
      vscode.window.showInformationMessage(`Kokoros was installed and started on port ${refreshedSettings.port}.`);
    }
  }));

  context.subscriptions.push(registerSafeCommand("kokorosTts.cancelGeneration", serverManager, async () => {
    if (!runtimeState.abortController) {
      vscode.window.showInformationMessage("Kokoros TTS is not generating audio right now.");
      return;
    }

    runtimeState.abortController.abort();
    serverManager.log("Generation cancellation requested by user.");
    vscode.window.showInformationMessage("Cancelling Kokoros audio generation...");
  }));

  context.subscriptions.push(registerSafeCommand("kokorosTts.stopPlayback", serverManager, async () => {
    PlaybackPanel.closeCurrent();
    highlighter.clear();
    runtimeState.playbackPath = undefined;
    if (runtimeState.phase === "playing") {
      setPhase(runtimeState, statusBar, "idle");
    }
    vscode.window.showInformationMessage("Playback stopped.");
  }));

  context.subscriptions.push(registerSafeCommand("kokorosTts.manageAudioFiles", serverManager, async () => {
    await manageGeneratedAudioFiles(context, runtimeState, statusBar, highlighter);
  }));

  context.subscriptions.push(registerSafeCommand("kokorosTts.manageServers", serverManager, async () => {
    await manageServers(serverManager, runtimeState, statusBar, highlighter);
  }));

  context.subscriptions.push(registerSafeCommand("kokorosTts.manageAudio", serverManager, async () => {
    await manageAudio(context, serverManager, highlighter, queueManager, runtimeState, statusBar);
  }));

  context.subscriptions.push(registerSafeCommand("kokorosTts.clearQueue", serverManager, async () => {
    const cleared = queueManager.clearPending();
    if (!cleared) {
      vscode.window.showInformationMessage("The Kokoros queue is already empty.");
      return;
    }

    vscode.window.showInformationMessage(`Removed ${cleared} queued Kokoros request${cleared === 1 ? "" : "s"}.`);
  }));

  context.subscriptions.push(registerSafeCommand("kokorosTts.removeQueuedItem", serverManager, async (...args: unknown[]) => {
    const item = args[0] as QueueTreeItem | undefined;
    if (!item?.entryId || item.kind !== "queued") {
      return;
    }

    if (queueManager.removeQueued(item.entryId)) {
      vscode.window.showInformationMessage(`Removed "${item.label}" from the Kokoros queue.`);
    }
  }));

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (isServerConfigurationChange(event)) {
      serverManager.markConfigurationDirty();
    }
  }));
}

export function deactivate(): void {
  // VS Code disposes subscriptions for us.
}

async function speakFromEditor(
  context: vscode.ExtensionContext,
  serverManager: KokorosServerManager,
  highlighter: PlaybackHighlighter,
  queueManager: SpeechQueueManager,
  runtimeState: RuntimeState,
  statusBar: vscode.StatusBarItem,
  mode: SpeakMode,
  commandArgs: unknown[]
): Promise<void> {
  const abortController = new AbortController();
  const request = buildSpeakRequest(commandArgs, mode);
  const queueTicket = queueManager.enqueue(request.target.sourceLabel, `${request.spokenText.length} chars`);
  let readyAudio: ReadyAudio | undefined;
  let turnAcquired = false;
  let setupHandled = false;

  if (queueTicket.aheadCount > 0) {
    vscode.window.showInformationMessage(
      `Queued "${request.target.sourceLabel}" behind ${queueTicket.aheadCount} Kokoros request${queueTicket.aheadCount === 1 ? "" : "s"}.`
    );
  }

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Kokoros TTS",
        cancellable: true
      },
      async (progress, token) => {
        token.onCancellationRequested(() => {
          abortController.abort();
          queueTicket.cancelQueued();
        });

        progress.report({
          message: queueTicket.aheadCount > 0
            ? `Waiting in queue (${queueTicket.aheadCount} ahead)...`
            : "Preparing text..."
        });

        await queueTicket.waitForTurn();
        turnAcquired = true;
        runtimeState.abortController = abortController;

        setPhase(runtimeState, statusBar, "starting");
        progress.report({ message: "Checking local Kokoros server..." });
        const ready = await ensureServerReady(context, serverManager, request.settings, (message) => {
          progress.report({ message });
          serverManager.log(message);
        });
        if (!ready) {
          setupHandled = true;
          return;
        }

        if (abortController.signal.aborted) {
          throw new Error("Kokoros generation cancelled.");
        }

        const storagePath = context.globalStorageUri.fsPath;
        await ensureAudioLibrary(storagePath);

        const outputPath = path.join(storagePath, `kokoros-${Date.now()}.wav`);
        setPhase(runtimeState, statusBar, "generating");
        progress.report({ message: "Generating audio..." });
        const synthesis = await synthesizeSpeech({
          port: request.settings.port,
          text: request.spokenText,
          voice: request.settings.voice,
          speed: request.settings.speed,
          streamAudio: request.settings.streamAudio,
          outputPath,
          signal: abortController.signal
        });

        progress.report({ message: "Opening player..." });
        readyAudio = {
          ...request,
          outputPath: synthesis.outputPath,
          durationSeconds: synthesis.durationSeconds
        };
      }
    );

    if (setupHandled) {
      return;
    }

    if (!readyAudio) {
      throw new Error("Speech generation completed without producing an audio result.");
    }

    const { editor, target, settings, outputPath, durationSeconds } = readyAudio;

    highlighter.clear();
    if (settings.highlightMode === "estimated") {
      highlighter.start(editor, target.startOffset, target.rawText, durationSeconds);
    }

    runtimeState.playbackPath = outputPath;
    setPhase(runtimeState, statusBar, "playing");

    PlaybackPanel.show(context.extensionUri, {
      audioPath: outputPath,
      title: "Kokoros TTS Preview",
      sourceLabel: `${target.sourceLabel} · ${settings.streamAudio ? "streaming" : "file"} · ${durationSeconds.toFixed(1)}s`,
      onTimeUpdate: (seconds) => {
        if (settings.highlightMode === "estimated") {
          highlighter.update(seconds);
        }
      },
      onPlaybackEnded: () => {
        highlighter.clear();
        runtimeState.playbackPath = undefined;
        setPhase(runtimeState, statusBar, "idle");
      },
      onPanelClosed: () => {
        highlighter.clear();
        runtimeState.playbackPath = undefined;
        setPhase(runtimeState, statusBar, "idle");
      }
    });
  } catch (error) {
    const message = toErrorMessage(error);
    if (abortController.signal.aborted) {
      highlighter.clear();
      runtimeState.playbackPath = undefined;
      setPhase(runtimeState, statusBar, "idle");
      vscode.window.showInformationMessage("Kokoros audio generation cancelled.");
      return;
    }

    if (message === "Kokoros request removed from queue.") {
      highlighter.clear();
      runtimeState.playbackPath = undefined;
      setPhase(runtimeState, statusBar, runtimeState.playbackPath ? "playing" : "idle");
      return;
    }

    setPhase(runtimeState, statusBar, runtimeState.playbackPath ? "playing" : "idle");
    throw error;
  } finally {
    if (runtimeState.abortController === abortController) {
      runtimeState.abortController = undefined;
    }
    if (turnAcquired) {
      queueTicket.finish();
    }
    if (runtimeState.phase !== "playing") {
      setPhase(runtimeState, statusBar, "idle");
    }
  }
}

async function manageAudio(
  context: vscode.ExtensionContext,
  serverManager: KokorosServerManager,
  highlighter: PlaybackHighlighter,
  queueManager: SpeechQueueManager,
  runtimeState: RuntimeState,
  statusBar: vscode.StatusBarItem
): Promise<void> {
  const actions: Array<{ label: string; detail: string; run: () => Promise<void> }> = [
    {
      label: "$(cloud-download) Install or repair Kokoros",
      detail: "Run the built-in macOS installer for Homebrew, Rust, and Kokoros",
      run: async () => vscode.commands.executeCommand("kokorosTts.installDependencies")
    },
    {
      label: "$(play) Speak selection",
      detail: "Generate speech for the current editor selection",
      run: async () => speakFromEditor(context, serverManager, highlighter, queueManager, runtimeState, statusBar, "selection", [])
    },
    {
      label: "$(book) Speak active document",
      detail: "Generate speech for the whole active document",
      run: async () => speakFromEditor(context, serverManager, highlighter, queueManager, runtimeState, statusBar, "document", [])
    },
    {
      label: "$(files) Manage generated audio files",
      detail: "Play, reveal, delete, or clean generated audio",
      run: async () => manageGeneratedAudioFiles(context, runtimeState, statusBar, highlighter)
    },
    {
      label: "$(server-process) Manage Kokoros servers",
      detail: "See running servers, stop them, or restart the configured one",
      run: async () => manageServers(serverManager, runtimeState, statusBar, highlighter)
    },
    {
      label: "$(list-unordered) Open queue view",
      detail: "See what is running or queued for Kokoros",
      run: async () => vscode.commands.executeCommand("kokorosTts.queueView.focus")
    },
    {
      label: "$(pulse) Check Kokoros setup",
      detail: "Open a setup report and reveal extension logs",
      run: async () => vscode.commands.executeCommand("kokorosTts.checkSetup")
    }
  ];

  if (runtimeState.abortController) {
    actions.unshift({
      label: "$(debug-stop) Cancel current generation",
      detail: "Abort the active speech generation request",
      run: async () => vscode.commands.executeCommand("kokorosTts.cancelGeneration")
    });
  }

  if (runtimeState.phase === "playing") {
    actions.unshift({
      label: "$(stop-circle) Stop playback",
      detail: "Close the playback panel and clear highlighting",
      run: async () => vscode.commands.executeCommand("kokorosTts.stopPlayback")
    });
  }

  if (queueManager.getPendingCount() > 0) {
    actions.unshift({
      label: "$(trash) Clear queued requests",
      detail: `Remove ${queueManager.getPendingCount()} queued Kokoros request${queueManager.getPendingCount() === 1 ? "" : "s"}`,
      run: async () => vscode.commands.executeCommand("kokorosTts.clearQueue")
    });
  }

  const picked = await vscode.window.showQuickPick(actions, {
    title: "Manage Kokoros Audio",
    matchOnDetail: true
  });

  if (picked) {
    await picked.run();
  }
}

async function manageGeneratedAudioFiles(
  context: vscode.ExtensionContext,
  runtimeState: RuntimeState,
  statusBar: vscode.StatusBarItem,
  highlighter: PlaybackHighlighter
): Promise<void> {
  const storagePath = context.globalStorageUri.fsPath;
  const files = await listGeneratedAudioFiles(storagePath);

  const entries: Array<vscode.QuickPickItem & { itemType: "cleanAll" | "file"; filePath?: string }> = [
    {
      label: "$(trash) Clean all generated audio",
      description: files.length ? `${files.length} file${files.length === 1 ? "" : "s"}` : "No files",
      itemType: "cleanAll"
    },
    ...files.map((file) => ({
      label: file.name,
      description: `${file.durationSeconds.toFixed(1)}s · ${formatFileSize(file.sizeBytes)}`,
      detail: new Date(file.modifiedAt).toLocaleString(),
      itemType: "file" as const,
      filePath: file.path
    }))
  ];

  const picked = await vscode.window.showQuickPick(entries, {
    title: "Generated Kokoros Audio Files",
    matchOnDescription: true,
    matchOnDetail: true
  });

  if (!picked) {
    return;
  }

  if (picked.itemType === "cleanAll") {
    const confirm = await vscode.window.showWarningMessage(
      "Delete all generated Kokoros audio files?",
      { modal: true },
      "Delete All"
    );

    if (confirm === "Delete All") {
      const deleted = await deleteAllGeneratedAudioFiles(storagePath);
      if (runtimeState.phase === "playing") {
        PlaybackPanel.closeCurrent();
        highlighter.clear();
        runtimeState.playbackPath = undefined;
        setPhase(runtimeState, statusBar, "idle");
      }
      vscode.window.showInformationMessage(`Deleted ${deleted} generated audio file${deleted === 1 ? "" : "s"}.`);
    }
    return;
  }

  const filePath = picked.filePath;
  if (!filePath) {
    return;
  }

  const action = await vscode.window.showQuickPick(
    [
      { label: "$(play) Play in preview panel", action: "play" },
      { label: "$(go-to-file) Reveal in Finder", action: "reveal" },
      { label: "$(trash) Delete this file", action: "delete" }
    ],
    { title: picked.label }
  );

  if (!action) {
    return;
  }

  if (action.action === "play") {
    runtimeState.playbackPath = filePath;
    setPhase(runtimeState, statusBar, "playing");
    PlaybackPanel.show(context.extensionUri, {
      audioPath: filePath,
      title: "Kokoros TTS Preview",
      sourceLabel: `Library playback · ${picked.description ?? ""}`,
      onTimeUpdate: () => undefined,
      onPlaybackEnded: () => {
        runtimeState.playbackPath = undefined;
        setPhase(runtimeState, statusBar, "idle");
      },
      onPanelClosed: () => {
        runtimeState.playbackPath = undefined;
        setPhase(runtimeState, statusBar, "idle");
      }
    });
    return;
  }

  if (action.action === "reveal") {
    await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(filePath));
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Delete ${path.basename(filePath)}?`,
    { modal: true },
    "Delete"
  );

  if (confirm === "Delete") {
    await deleteGeneratedAudioFile(filePath);
    if (runtimeState.playbackPath === filePath) {
      PlaybackPanel.closeCurrent();
      highlighter.clear();
      runtimeState.playbackPath = undefined;
      setPhase(runtimeState, statusBar, "idle");
    }
    vscode.window.showInformationMessage(`Deleted ${path.basename(filePath)}.`);
  }
}

async function manageServers(
  serverManager: KokorosServerManager,
  runtimeState: RuntimeState,
  statusBar: vscode.StatusBarItem,
  highlighter: PlaybackHighlighter
): Promise<void> {
  const settings = getSettings();
  const servers = await discoverKokorosServers(settings.port, serverManager.getManagedPid());
  const quickPickItems: Array<vscode.QuickPickItem & { action: string; pid?: number }> = [
    {
      label: "$(play) Start configured server",
      detail: `Port ${settings.port} · ${settings.instances} instance(s)`,
      action: "startConfigured"
    },
    {
      label: "$(refresh) Restart configured server",
      detail: `Port ${settings.port} · ${settings.instances} instance(s)`,
      action: "restartConfigured"
    }
  ];

  if (servers.length) {
    quickPickItems.push({
      label: "$(debug-stop) Stop all discovered Kokoros servers",
      detail: `${servers.length} process${servers.length === 1 ? "" : "es"} detected`,
      action: "stopAllDiscovered"
    });
  }

  if (serverManager.getManagedPid()) {
    quickPickItems.push({
      label: "$(debug-stop) Stop managed server",
      detail: `PID ${serverManager.getManagedPid()} · port ${settings.port}`,
      action: "stopManaged"
    });
  }

  quickPickItems.push(...servers.map((server) => ({
    label: `${server.managed ? "$(vm-active)" : "$(server-process)"} PID ${server.pid}`,
    description: server.ports.length ? `port ${server.ports.join(", ")}` : "port unknown",
    detail: server.command,
    action: "serverRow",
    pid: server.pid
  })));

  const picked = await vscode.window.showQuickPick(quickPickItems, {
    title: "Manage Kokoros Servers",
    matchOnDescription: true,
    matchOnDetail: true
  });

  if (!picked) {
    return;
  }

  if (picked.action === "startConfigured") {
    await vscode.commands.executeCommand("kokorosTts.startServer");
    return;
  }

  if (picked.action === "restartConfigured") {
    await vscode.commands.executeCommand("kokorosTts.restartServer");
    return;
  }

  if (picked.action === "stopManaged") {
    await vscode.commands.executeCommand("kokorosTts.stopServer");
    return;
  }

  if (picked.action === "stopAllDiscovered") {
    const confirm = await vscode.window.showWarningMessage(
      `Stop ${servers.length} discovered Kokoros server process${servers.length === 1 ? "" : "es"}?`,
      { modal: true },
      "Stop All"
    );

    if (confirm === "Stop All") {
      for (const server of servers) {
        stopServerPid(server.pid);
      }
      await waitForServerToStop(settings.port);
      highlighter.clear();
      PlaybackPanel.closeCurrent();
      runtimeState.playbackPath = undefined;
      setPhase(runtimeState, statusBar, "idle");
      vscode.window.showInformationMessage(`Stop signal sent to ${servers.length} Kokoros process${servers.length === 1 ? "" : "es"}.`);
    }
    return;
  }

  if (!picked.pid) {
    return;
  }

  const action = await vscode.window.showQuickPick(
    [
      { label: "$(debug-stop) Stop this server process", action: "stop" },
      { label: "$(copy) Copy command line", action: "copy" }
    ],
    { title: picked.label }
  );

  if (!action) {
    return;
  }

  const server = servers.find((item) => item.pid === picked.pid);
  if (!server) {
    return;
  }

  if (action.action === "copy") {
    await vscode.env.clipboard.writeText(server.command);
    vscode.window.showInformationMessage(`Copied command line for PID ${server.pid}.`);
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Stop Kokoros server process ${server.pid}?`,
    { modal: true },
    "Stop Server"
  );

  if (confirm === "Stop Server") {
    stopServerPid(server.pid);
    if (server.managed) {
      highlighter.clear();
      PlaybackPanel.closeCurrent();
      runtimeState.playbackPath = undefined;
      setPhase(runtimeState, statusBar, "idle");
    }
    vscode.window.showInformationMessage(`Stop signal sent to PID ${server.pid}.`);
  }
}

function registerSafeCommand(
  commandId: string,
  serverManager: KokorosServerManager,
  handler: (...args: unknown[]) => Promise<void>
): vscode.Disposable {
  return vscode.commands.registerCommand(commandId, async (...args: unknown[]) => {
    try {
      await handler(...args);
    } catch (error) {
      const message = toErrorMessage(error);
      serverManager.log(`${commandId} failed: ${message}`);

      const choice = await vscode.window.showErrorMessage(`Kokoros TTS: ${message}`, "Show Logs");
      if (choice === "Show Logs") {
        serverManager.revealLogs();
      }
    }
  });
}

function resolveEditor(commandArgs: unknown[]): vscode.TextEditor | undefined {
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor && activeEditor.document.uri.scheme !== "output") {
    return activeEditor;
  }

  for (const argument of commandArgs) {
    const uri = getUriFromArgument(argument);
    if (!uri) {
      continue;
    }

    const visibleEditor = vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === uri.toString());
    if (visibleEditor) {
      return visibleEditor;
    }
  }

  return vscode.window.visibleTextEditors.find((editor) => editor.document.uri.scheme === "file");
}

async function ensureServerReady(
  context: vscode.ExtensionContext,
  serverManager: KokorosServerManager,
  settings: ReturnType<typeof getSettings>,
  onStatus?: (message: string) => void
): Promise<boolean> {
  try {
    await serverManager.ensureRunning(settings, onStatus);
    return true;
  } catch (error) {
    const adopted = await adoptDetectedKokorosSetup(settings);
    if (adopted) {
      serverManager.log(`Auto-detected existing Kokoros at ${adopted.workingDirectory}`);
      const refreshedSettings = getSettings();
      await serverManager.ensureRunning(refreshedSettings, onStatus);
      void vscode.window.showInformationMessage(`Detected and connected existing Kokoros at ${adopted.workingDirectory}.`);
      return true;
    }

    const action = await promptToInstallKokoros(error);
    if (action === "guide") {
      await vscode.commands.executeCommand("kokorosTts.checkSetup");
      return false;
    }

    if (action === "install") {
      const installed = await installKokorosDependencies(context, settings);
      if (!installed) {
        return false;
      }

      const refreshedSettings = getSettings();
      await serverManager.ensureRunning(refreshedSettings, onStatus);
      return true;
    }
    throw error;
  }
}

function buildSpeakRequest(commandArgs: unknown[], mode: SpeakMode): SpeakRequest {
  const editor = resolveEditor(commandArgs);
  if (!editor) {
    throw new Error("No active text editor was found for this command.");
  }

  const target = getSpeakTarget(editor, mode);
  if (!target.rawText.trim()) {
    throw new Error("There is no text to speak.");
  }

  const settings = getSettings();
  const spokenText = settings.stripMarkdown ? stripMarkdownForSpeech(target.rawText) : target.rawText.trim();
  if (!spokenText) {
    throw new Error("The selected content became empty after markdown cleanup.");
  }

  return {
    editor,
    target,
    settings,
    spokenText
  };
}

function getSpeakTarget(editor: vscode.TextEditor, mode: SpeakMode): SpeakTarget {
  if (mode === "document") {
    return {
      rawText: editor.document.getText(),
      startOffset: 0,
      sourceLabel: path.basename(editor.document.fileName)
    };
  }

  const nonEmptySelections = editor.selections.filter((selection) => !selection.isEmpty);
  if (!nonEmptySelections.length) {
    throw new Error("Select some text first, or use the Speak Active Document command.");
  }

  if (nonEmptySelections.length === 1) {
    const selection = nonEmptySelections[0];
    return {
      rawText: editor.document.getText(selection),
      startOffset: editor.document.offsetAt(selection.start),
      sourceLabel: `${path.basename(editor.document.fileName)} selection`
    };
  }

  const chunks = nonEmptySelections.map((selection) => editor.document.getText(selection));
  return {
    rawText: chunks.join("\n\n"),
    startOffset: editor.document.offsetAt(nonEmptySelections[0].start),
    sourceLabel: `${path.basename(editor.document.fileName)} multi-selection`
  };
}

function getUriFromArgument(argument: unknown): vscode.Uri | undefined {
  if (argument instanceof vscode.Uri) {
    return argument;
  }

  if (argument && typeof argument === "object" && "resourceUri" in argument) {
    const value = (argument as { resourceUri?: unknown }).resourceUri;
    if (value instanceof vscode.Uri) {
      return value;
    }
  }

  return undefined;
}

function setPhase(runtimeState: RuntimeState, statusBar: vscode.StatusBarItem, phase: RuntimePhase): void {
  runtimeState.phase = phase;
  updateStatusBar(statusBar, runtimeState);
}

function syncQueueState(
  runtimeState: RuntimeState,
  queueManager: SpeechQueueManager,
  statusBar: vscode.StatusBarItem
): void {
  runtimeState.queuedCount = queueManager.getPendingCount();
  updateStatusBar(statusBar, runtimeState);
}

function updateStatusBar(statusBar: vscode.StatusBarItem, runtimeState: RuntimeState): void {
  statusBar.command = "kokorosTts.manageAudio";
  const queueSuffix = runtimeState.queuedCount ? ` +${runtimeState.queuedCount}` : "";

  if (runtimeState.abortController) {
    statusBar.text = `$(sync~spin) Kokoros: Generating${queueSuffix}`;
    statusBar.tooltip = `Kokoros is generating audio${runtimeState.queuedCount ? ` with ${runtimeState.queuedCount} more queued` : ""}. Click to manage audio, cancel generation, or inspect files and servers.`;
    statusBar.show();
    return;
  }

  switch (runtimeState.phase) {
    case "starting":
      statusBar.text = `$(sync~spin) Kokoros: Starting${queueSuffix}`;
      statusBar.tooltip = "Kokoros server is starting.";
      statusBar.show();
      return;
    case "playing":
      statusBar.text = `$(unmute) Kokoros: Playing${queueSuffix}`;
      statusBar.tooltip = `Audio is playing${runtimeState.queuedCount ? ` and ${runtimeState.queuedCount} more request${runtimeState.queuedCount === 1 ? " is" : "s are"} queued` : ""}. Click to manage playback, files, or servers.`;
      statusBar.show();
      return;
    default:
      if (runtimeState.queuedCount) {
        statusBar.text = `$(list-unordered) Kokoros: ${runtimeState.queuedCount} queued`;
        statusBar.tooltip = "Kokoros has queued requests waiting to run.";
      } else {
        statusBar.text = "$(unmute) Kokoros";
        statusBar.tooltip = "Manage Kokoros speech, generated audio files, and local servers.";
      }
      statusBar.show();
  }
}

async function stopConfiguredServers(serverManager: KokorosServerManager, port: number): Promise<number> {
  const managedPid = serverManager.getManagedPid();
  const discovered = await discoverKokorosServers(port, managedPid);
  const matching = discovered.filter((server) => server.configuredPortMatch);
  let stopped = 0;

  if (managedPid) {
    await serverManager.stop();
    if (matching.some((server) => server.pid === managedPid)) {
      stopped += 1;
    }
  }

  for (const server of matching) {
    if (server.pid === managedPid) {
      continue;
    }

    stopServerPid(server.pid);
    stopped += 1;
  }

  if (stopped) {
    await waitForServerToStop(port);
  }

  return stopped;
}

async function waitForServerToStop(port: number): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 5_000) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(400)
      });

      if (!response.ok) {
        return;
      }
    } catch {
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
