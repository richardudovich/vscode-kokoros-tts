import * as vscode from "vscode";

export type HighlightMode = "off" | "estimated";

export interface KokorosSettings {
  kokorosExecutable: string;
  kokorosWorkingDirectory: string;
  modelPath: string;
  voiceDataPath: string;
  port: number;
  instances: number;
  voice: string;
  speed: number;
  autoStartServer: boolean;
  streamAudio: boolean;
  stripMarkdown: boolean;
  highlightMode: HighlightMode;
}

export function getSettings(): KokorosSettings {
  const config = vscode.workspace.getConfiguration("kokorosTts");

  return {
    kokorosExecutable: config.get<string>("kokorosExecutable", "").trim(),
    kokorosWorkingDirectory: config.get<string>("kokorosWorkingDirectory", "/tmp/Kokoros").trim(),
    modelPath: config.get<string>("modelPath", "").trim(),
    voiceDataPath: config.get<string>("voiceDataPath", "").trim(),
    port: config.get<number>("port", 3001),
    instances: config.get<number>("instances", 4),
    voice: config.get<string>("voice", "af_sky").trim() || "af_sky",
    speed: config.get<number>("speed", 1),
    autoStartServer: config.get<boolean>("autoStartServer", true),
    streamAudio: config.get<boolean>("streamAudio", true),
    stripMarkdown: config.get<boolean>("stripMarkdown", true),
    highlightMode: config.get<HighlightMode>("highlightMode", "estimated")
  };
}

export function isServerConfigurationChange(event: vscode.ConfigurationChangeEvent): boolean {
  return [
    "kokorosTts.kokorosExecutable",
    "kokorosTts.kokorosWorkingDirectory",
    "kokorosTts.modelPath",
    "kokorosTts.voiceDataPath",
    "kokorosTts.port",
    "kokorosTts.instances"
  ].some((key) => event.affectsConfiguration(key));
}
