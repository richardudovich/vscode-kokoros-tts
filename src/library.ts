import { promises as fs } from "node:fs";
import * as path from "node:path";

import { readWavDuration } from "./audioClient";

export interface GeneratedAudioFile {
  path: string;
  name: string;
  sizeBytes: number;
  durationSeconds: number;
  modifiedAt: number;
}

export async function ensureAudioLibrary(storagePath: string): Promise<void> {
  await fs.mkdir(storagePath, { recursive: true });
}

export async function listGeneratedAudioFiles(storagePath: string): Promise<GeneratedAudioFile[]> {
  await ensureAudioLibrary(storagePath);
  const entries = await fs.readdir(storagePath, { withFileTypes: true });
  const files: GeneratedAudioFile[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".wav")) {
      continue;
    }

    const fullPath = path.join(storagePath, entry.name);
    const [stats, buffer] = await Promise.all([
      fs.stat(fullPath),
      fs.readFile(fullPath)
    ]);

    files.push({
      path: fullPath,
      name: entry.name,
      sizeBytes: stats.size,
      durationSeconds: readWavDuration(buffer),
      modifiedAt: stats.mtimeMs
    });
  }

  return files.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

export async function deleteGeneratedAudioFile(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true });
}

export async function deleteAllGeneratedAudioFiles(storagePath: string): Promise<number> {
  const files = await listGeneratedAudioFiles(storagePath);
  await Promise.all(files.map((file) => deleteGeneratedAudioFile(file.path)));
  return files.length;
}

export function formatFileSize(sizeBytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let size = sizeBytes;
  let unit = 0;

  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }

  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
