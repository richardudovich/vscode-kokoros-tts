import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readWavDuration, synthesizeSpeech } from "../src/audioClient";
import {
  deleteAllGeneratedAudioFiles,
  formatFileSize,
  listGeneratedAudioFiles
} from "../src/library";

function createWavBuffer(durationSeconds: number, sampleRate = 24_000): Buffer {
  const dataSize = durationSeconds * sampleRate * 2;
  const wav = Buffer.alloc(44 + dataSize);

  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataSize, 40);

  return wav;
}

const tempDirectories: string[] = [];
const fetchMock = vi.fn<typeof fetch>();

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("audio and library helpers", () => {
  it("reads WAV duration from the header", () => {
    expect(readWavDuration(Buffer.alloc(10))).toBe(0);
    expect(readWavDuration(createWavBuffer(2))).toBeCloseTo(2, 5);
  });

  it("formats file sizes in readable units", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(1024)).toBe("1.0 KB");
    expect(formatFileSize(1536)).toBe("1.5 KB");
  });

  it("lists generated wav files in newest-first order and deletes them in bulk", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "kokoros-library-"));
    tempDirectories.push(directory);

    const olderFile = path.join(directory, "older.wav");
    const newerFile = path.join(directory, "newer.wav");
    const ignoredFile = path.join(directory, "ignored.txt");

    await writeFile(olderFile, createWavBuffer(1));
    await writeFile(newerFile, createWavBuffer(2));
    await writeFile(ignoredFile, "ignore me");

    await utimes(olderFile, new Date("2024-01-01T00:00:00Z"), new Date("2024-01-01T00:00:00Z"));
    await utimes(newerFile, new Date("2024-01-02T00:00:00Z"), new Date("2024-01-02T00:00:00Z"));

    const files = await listGeneratedAudioFiles(directory);

    expect(files.map((file) => file.name)).toEqual(["newer.wav", "older.wav"]);
    expect(files[0].durationSeconds).toBeCloseTo(2, 5);
    expect(files[1].durationSeconds).toBeCloseTo(1, 5);

    expect(await deleteAllGeneratedAudioFiles(directory)).toBe(2);
    expect(await readdir(directory)).toEqual(["ignored.txt"]);
  });

  it("synthesizes streaming audio into a wav file", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "kokoros-stream-"));
    tempDirectories.push(directory);

    fetchMock.mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([0, 1, 2, 3]));
        controller.close();
      }
    }), { status: 200 }));

    const outputPath = path.join(directory, "stream.wav");
    const result = await synthesizeSpeech({
      port: 3001,
      text: "hello from stream mode",
      voice: "af_sky",
      speed: 1,
      streamAudio: true,
      outputPath
    });

    const written = await readFile(outputPath);

    expect(result.requestMode).toBe("stream");
    expect(result.bytesWritten).toBe(48);
    expect(result.durationSeconds).toBeCloseTo(4 / (24_000 * 2), 8);
    expect(readWavDuration(written)).toBeCloseTo(result.durationSeconds, 8);
  });

  it("synthesizes file-mode audio and cleans up failed outputs", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "kokoros-file-"));
    tempDirectories.push(directory);

    const wav = createWavBuffer(1.5);
    fetchMock.mockResolvedValueOnce(new Response(wav, { status: 200 }));

    const outputPath = path.join(directory, "file.wav");
    const success = await synthesizeSpeech({
      port: 3001,
      text: "hello from file mode",
      voice: "af_sky",
      speed: 1,
      streamAudio: false,
      outputPath
    });

    expect(success.requestMode).toBe("file");
    expect(success.durationSeconds).toBeCloseTo(1.5, 5);

    fetchMock.mockResolvedValueOnce(new Response("bad", { status: 500, statusText: "Broken" }));

    const failedPath = path.join(directory, "failed.wav");
    await expect(synthesizeSpeech({
      port: 3001,
      text: "this should fail",
      voice: "af_sky",
      speed: 1,
      streamAudio: false,
      outputPath: failedPath
    })).rejects.toThrow("Kokoros request failed: 500 bad");

    await expect(readFile(failedPath)).rejects.toThrow();
  });
});
