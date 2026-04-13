import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface SynthesisRequest {
  port: number;
  text: string;
  voice: string;
  speed: number;
  streamAudio: boolean;
  outputPath: string;
  signal?: AbortSignal;
}

export interface SynthesisResult {
  outputPath: string;
  durationSeconds: number;
  bytesWritten: number;
  requestMode: "stream" | "file";
}

function buildWavFromPcm16(pcmData: Buffer, sampleRate: number): Buffer {
  const headerSize = 44;
  const wav = Buffer.alloc(headerSize + pcmData.length);

  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + pcmData.length, 4);
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
  wav.writeUInt32LE(pcmData.length, 40);
  pcmData.copy(wav, headerSize);

  return wav;
}

export function readWavDuration(wavData: Buffer): number {
  if (wavData.length < 44) {
    return 0;
  }

  const byteRate = wavData.readUInt32LE(28);
  const dataSize = wavData.readUInt32LE(40);
  if (byteRate <= 0) {
    return 0;
  }

  return dataSize / byteRate;
}

async function readResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

export async function synthesizeSpeech(request: SynthesisRequest): Promise<SynthesisResult> {
  await fs.mkdir(path.dirname(request.outputPath), { recursive: true });

  try {
    if (request.streamAudio) {
      const response = await fetch(`http://127.0.0.1:${request.port}/v1/audio/speech`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        signal: request.signal,
        body: JSON.stringify({
          model: "tts-1",
          input: request.text,
          voice: request.voice,
          response_format: "pcm",
          stream: true,
          speed: request.speed
        })
      });

      if (!response.ok || !response.body) {
        throw new Error(`Kokoros streaming request failed: ${response.status} ${await readResponseText(response)}`);
      }

      const reader = response.body.getReader();
      const chunks: Buffer[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        if (request.signal?.aborted) {
          await reader.cancel();
          throw new Error("Kokoros generation cancelled.");
        }

        if (value) {
          chunks.push(Buffer.from(value));
        }
      }

      const pcm = Buffer.concat(chunks);
      const wav = buildWavFromPcm16(pcm, 24_000);
      await fs.writeFile(request.outputPath, wav);

      return {
        outputPath: request.outputPath,
        durationSeconds: pcm.length / (24_000 * 2),
        bytesWritten: wav.length,
        requestMode: "stream"
      };
    }

    const response = await fetch(`http://127.0.0.1:${request.port}/v1/audio/speech`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      signal: request.signal,
      body: JSON.stringify({
        model: "tts-1",
        input: request.text,
        voice: request.voice,
        response_format: "wav",
        stream: false,
        speed: request.speed
      })
    });

    if (!response.ok) {
      throw new Error(`Kokoros request failed: ${response.status} ${await readResponseText(response)}`);
    }

    const wav = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(request.outputPath, wav);

    return {
      outputPath: request.outputPath,
      durationSeconds: readWavDuration(wav),
      bytesWritten: wav.length,
      requestMode: "file"
    };
  } catch (error) {
    await fs.rm(request.outputPath, { force: true }).catch(() => undefined);

    if (request.signal?.aborted) {
      throw new Error("Kokoros generation cancelled.");
    }

    throw error;
  }
}
