import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams, execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";

import type { KokorosSettings } from "./config";

const execFile = promisify(execFileCallback);

interface ResolvedSetup {
  executablePath: string;
  workingDirectory: string;
  args: string[];
}

export class KokorosServerManager implements vscode.Disposable {
  private readonly outputChannel = vscode.window.createOutputChannel("Kokoros TTS");
  private process?: ChildProcessWithoutNullStreams;
  private signature?: string;

  log(message: string): void {
    this.outputChannel.appendLine(`[extension] ${message}`);
  }

  async ensureRunning(settings: KokorosSettings, onStatus?: (message: string) => void): Promise<void> {
    const signature = this.buildSignature(settings);
    const healthy = await this.isHealthy(settings.port);

    if (healthy && this.signature === signature) {
      onStatus?.(`Using Kokoros server on port ${settings.port}`);
      return;
    }

    if (healthy && !this.process) {
      this.outputChannel.appendLine(`[kokoros] Reusing server already listening on port ${settings.port}.`);
      this.signature = signature;
      onStatus?.(`Connected to existing Kokoros server on port ${settings.port}`);
      return;
    }

    if (healthy && this.process && this.signature !== signature) {
      onStatus?.("Restarting Kokoros server with updated settings");
      await this.restart(settings);
      return;
    }

    if (!healthy && settings.autoStartServer) {
      onStatus?.("Starting local Kokoros server");
      await this.start(settings);
      return;
    }

    throw new Error(
      `Kokoros server is not reachable on port ${settings.port}. Enable auto-start or start it with the "Kokoros TTS: Start Server" command.`
    );
  }

  async start(settings: KokorosSettings): Promise<void> {
    if (await this.isHealthy(settings.port)) {
      this.outputChannel.appendLine(`[kokoros] Reusing existing server already listening on port ${settings.port}.`);
      this.signature = this.buildSignature(settings);
      return;
    }

    if (this.process) {
      await this.stop();
    }

    const setup = await this.resolveSetup(settings);
    this.outputChannel.appendLine(`[kokoros] Starting server with executable ${setup.executablePath}`);
    this.outputChannel.appendLine(`[kokoros] Working directory ${setup.workingDirectory}`);
    this.outputChannel.appendLine(`[kokoros] Arguments ${setup.args.join(" ")}`);
    this.outputChannel.show(true);

    this.process = spawn(setup.executablePath, setup.args, {
      cwd: setup.workingDirectory,
      env: process.env
    });

    this.process.on("error", (error) => {
      this.outputChannel.appendLine(`[kokoros] Failed to start server process: ${toErrorMessage(error)}`);
    });

    this.process.stdout.on("data", (data) => {
      this.outputChannel.append(data.toString());
    });

    this.process.stderr.on("data", (data) => {
      this.outputChannel.append(data.toString());
    });

    this.process.on("exit", (code, signal) => {
      this.outputChannel.appendLine(`[kokoros] Server exited with code=${code ?? "null"} signal=${signal ?? "null"}`);
      this.process = undefined;
      this.signature = undefined;
    });

    this.signature = this.buildSignature(settings);
    await this.waitUntilHealthy(settings.port);
  }

  async stop(): Promise<void> {
    if (!this.process) {
      return;
    }

    const process = this.process;
    this.process = undefined;
    this.signature = undefined;

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        process.kill("SIGKILL");
        resolve();
      }, 1500);

      process.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });

      process.kill("SIGTERM");
    });
  }

  async restart(settings: KokorosSettings): Promise<void> {
    await this.stop();
    await this.start(settings);
  }

  async buildSetupReport(settings: KokorosSettings): Promise<string> {
    const lines: string[] = [];

    try {
      const setup = await this.resolveSetup(settings);
      lines.push(`Executable: ${setup.executablePath}`);
      lines.push(`Working directory: ${setup.workingDirectory}`);
      lines.push(`Arguments: ${setup.args.join(" ")}`);
    } catch (error) {
      lines.push(`Executable resolution failed: ${toErrorMessage(error)}`);
    }

    lines.push(`Port ${settings.port} healthy: ${String(await this.isHealthy(settings.port))}`);
    lines.push(`Managed process active: ${String(Boolean(this.process))}`);
    lines.push(`Managed signature: ${this.signature ?? "none"}`);

    return lines.join("\n");
  }

  revealLogs(): void {
    this.outputChannel.show(true);
  }

  getManagedPid(): number | undefined {
    return this.process?.pid;
  }

  markConfigurationDirty(): void {
    this.signature = undefined;
  }

  dispose(): void {
    void this.stop();
    this.outputChannel.dispose();
  }

  private async resolveSetup(settings: KokorosSettings): Promise<ResolvedSetup> {
    const executablePath = await resolveExecutablePath(settings);
    const workingDirectory = await resolveWorkingDirectory(settings, executablePath);
    const args: string[] = ["--instances", String(settings.instances)];

    if (settings.modelPath) {
      args.push("--model", settings.modelPath);
    }

    if (settings.voiceDataPath) {
      args.push("--data", settings.voiceDataPath);
    }

    args.push("openai", "--ip", "127.0.0.1", "--port", String(settings.port));

    return {
      executablePath,
      workingDirectory,
      args
    };
  }

  private buildSignature(settings: KokorosSettings): string {
    return JSON.stringify({
      executable: settings.kokorosExecutable,
      cwd: settings.kokorosWorkingDirectory,
      model: settings.modelPath,
      data: settings.voiceDataPath,
      port: settings.port,
      instances: settings.instances
    });
  }

  private async waitUntilHealthy(port: number): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 60_000) {
      if (await this.isHealthy(port)) {
        return;
      }

      if (this.process?.exitCode !== null && this.process?.exitCode !== undefined) {
        throw new Error(`Kokoros exited before becoming healthy. Exit code ${this.process.exitCode}.`);
      }

      await sleep(500);
    }

    throw new Error(`Kokoros did not become healthy on port ${port} within 60 seconds.`);
  }

  private async isHealthy(port: number): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(750)
      });

      return response.ok;
    } catch {
      return false;
    }
  }
}

async function resolveExecutablePath(settings: KokorosSettings): Promise<string> {
  const configured = settings.kokorosExecutable;
  if (configured && await pathExists(configured)) {
    return configured;
  }

  const workingDirectory = settings.kokorosWorkingDirectory;
  const candidates = [
    workingDirectory ? path.join(workingDirectory, "target", "release", "koko") : "",
    "/tmp/Kokoros/target/release/koko",
    path.join(os.homedir(), ".local", "share", "Kokoros", "target", "release", "koko"),
    path.join(os.homedir(), ".local", "share", "kokoros", "target", "release", "koko"),
    path.join(os.homedir(), "Desktop", "share", "pulse", "Kokoros", "target", "release", "koko")
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  try {
    const { stdout } = await execFile("which", ["koko"]);
    const pathFromShell = stdout.trim();
    if (pathFromShell) {
      return pathFromShell;
    }
  } catch {
    // Ignore and fall through to user-facing error.
  }

  throw new Error(
    "Could not find the `koko` executable. Set kokorosTts.kokorosExecutable or install/build Kokoros first."
  );
}

async function resolveWorkingDirectory(settings: KokorosSettings, executablePath: string): Promise<string> {
  if (settings.kokorosWorkingDirectory && await pathExists(settings.kokorosWorkingDirectory)) {
    return settings.kokorosWorkingDirectory;
  }

  const inferred = path.resolve(executablePath, "..", "..", "..");
  if (await pathExists(inferred)) {
    return inferred;
  }

  return path.dirname(executablePath);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
