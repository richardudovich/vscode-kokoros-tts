import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

import type { KokorosSettings } from "./config";
import { detectLocalKokorosSetup } from "./serverManager";

export function getDefaultInstallDirectory(): string {
  return path.join(os.homedir(), ".local", "share", "Kokoros");
}

export function isInstallRelatedError(error: unknown): boolean {
  const message = toErrorMessage(error);
  return message.includes("Could not find the `koko` executable")
    || message.includes("Kokoros server is not reachable")
    || message.includes("Kokoros exited before becoming healthy")
    || message.includes("Kokoros did not become healthy");
}

export async function promptToInstallKokoros(
  error: unknown
): Promise<"install" | "guide" | undefined> {
  if (!isInstallRelatedError(error)) {
    return undefined;
  }

  const message = toErrorMessage(error);
  const choice = await vscode.window.showErrorMessage(
    `Kokoros is not ready yet. ${message}`,
    "Install Kokoros",
    "Show Setup Guide"
  );

  if (choice === "Install Kokoros") {
    return "install";
  }

  if (choice === "Show Setup Guide") {
    return "guide";
  }

  return undefined;
}

export async function installKokorosDependencies(
  context: vscode.ExtensionContext,
  settings: KokorosSettings
): Promise<boolean> {
  const detected = await adoptDetectedKokorosSetup(settings);
  if (detected) {
    void vscode.window.showInformationMessage(`Using existing Kokoros at ${detected.workingDirectory}.`);
    return true;
  }

  if (process.platform !== "darwin") {
    throw new Error("Automatic Kokoros installation is currently supported on macOS only.");
  }

  const installDirectory = settings.kokorosWorkingDirectory || getDefaultInstallDirectory();
  const executablePath = path.join(installDirectory, "target", "release", "koko");
  const config = vscode.workspace.getConfiguration("kokorosTts");

  await config.update("kokorosWorkingDirectory", installDirectory, vscode.ConfigurationTarget.Global);
  await config.update("kokorosExecutable", executablePath, vscode.ConfigurationTarget.Global);

  const scriptPath = path.join(context.extensionPath, "scripts", "bootstrap-kokoros-macos.sh");
  const task = new vscode.Task(
    { type: "kokorosInstaller" },
    vscode.TaskScope.Global,
    "Install or Repair Kokoros",
    "Kokoros TTS",
    new vscode.ShellExecution("bash", [scriptPath, installDirectory], {
      cwd: os.homedir()
    })
  );

  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    focus: true,
    panel: vscode.TaskPanelKind.Dedicated,
    clear: true
  };

  const execution = await vscode.tasks.executeTask(task);
  const exitCode = await waitForTaskToFinish(execution);

  if (exitCode === 0) {
    void vscode.window.showInformationMessage("Kokoros installation finished.");
    return true;
  }

  void vscode.window.showWarningMessage(
    "Kokoros installation did not complete successfully. Check the “Install or Repair Kokoros” terminal output."
  );
  return false;
}

export async function adoptDetectedKokorosSetup(settings: KokorosSettings): Promise<{ executablePath: string; workingDirectory: string } | undefined> {
  const detected = await detectLocalKokorosSetup(settings);
  if (!detected) {
    return undefined;
  }

  await persistKokorosSetup(detected.workingDirectory, detected.executablePath);
  return detected;
}

async function waitForTaskToFinish(execution: vscode.TaskExecution): Promise<number | undefined> {
  return new Promise((resolve) => {
    const disposable = vscode.tasks.onDidEndTaskProcess((event) => {
      if (event.execution === execution) {
        disposable.dispose();
        resolve(event.exitCode);
      }
    });
  });
}

async function persistKokorosSetup(workingDirectory: string, executablePath: string): Promise<void> {
  const config = vscode.workspace.getConfiguration("kokorosTts");
  await config.update("kokorosWorkingDirectory", workingDirectory, vscode.ConfigurationTarget.Global);
  await config.update("kokorosExecutable", executablePath, vscode.ConfigurationTarget.Global);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
