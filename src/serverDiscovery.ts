import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export interface DiscoveredServer {
  pid: number;
  command: string;
  ports: number[];
  managed: boolean;
  configuredPortMatch: boolean;
}

export async function discoverKokorosServers(
  configuredPort: number,
  managedPid?: number
): Promise<DiscoveredServer[]> {
  const { stdout } = await execFile("ps", ["-axo", "pid=,command="]);
  const servers: DiscoveredServer[] = [];

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const match = trimmed.match(/^(\d+)\s+(.*)$/);
    if (!match) {
      continue;
    }

    const pid = Number(match[1]);
    const command = match[2];
    if (!/\bkoko\b/.test(command) || !/\bopenai\b/.test(command)) {
      continue;
    }

    const ports = await getListeningPorts(pid);
    servers.push({
      pid,
      command,
      ports,
      managed: managedPid === pid,
      configuredPortMatch: ports.includes(configuredPort)
    });
  }

  return servers.sort((a, b) => a.pid - b.pid);
}

export function stopServerPid(pid: number): void {
  process.kill(pid, "SIGTERM");
}

async function getListeningPorts(pid: number): Promise<number[]> {
  try {
    const { stdout } = await execFile("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN"]);
    const ports = new Set<number>();

    for (const line of stdout.split("\n")) {
      const match = line.match(/TCP\s+[^:]+:(\d+)\s+\(LISTEN\)/);
      if (match) {
        ports.add(Number(match[1]));
      }
    }

    return [...ports].sort((a, b) => a - b);
  } catch {
    return [];
  }
}
