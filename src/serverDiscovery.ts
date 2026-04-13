import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export interface KokorosProcess {
  pid: number;
  command: string;
}

export interface DiscoveredServer {
  pid: number;
  command: string;
  ports: number[];
  managed: boolean;
  configuredPortMatch: boolean;
}

export function parseKokorosProcessOutput(stdout: string): KokorosProcess[] {
  const processes: KokorosProcess[] = [];

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

    processes.push({ pid, command });
  }

  return processes.sort((a, b) => a.pid - b.pid);
}

export function parseListeningPortsOutput(stdout: string): number[] {
  const ports = new Set<number>();

  for (const line of stdout.split("\n")) {
    const match = line.match(/TCP\s+[^:]+:(\d+)\s+\(LISTEN\)/);
    if (match) {
      ports.add(Number(match[1]));
    }
  }

  return [...ports].sort((a, b) => a - b);
}

export function buildDiscoveredServers(
  processes: KokorosProcess[],
  configuredPort: number,
  portLookup: ReadonlyMap<number, readonly number[]>,
  managedPid?: number
): DiscoveredServer[] {
  return processes.map((processInfo) => {
    const ports = [...(portLookup.get(processInfo.pid) ?? [])].sort((a, b) => a - b);

    return {
      pid: processInfo.pid,
      command: processInfo.command,
      ports,
      managed: managedPid === processInfo.pid,
      configuredPortMatch: ports.includes(configuredPort)
    };
  });
}

export async function discoverKokorosServers(
  configuredPort: number,
  managedPid?: number
): Promise<DiscoveredServer[]> {
  const { stdout } = await execFile("ps", ["-axo", "pid=,command="]);
  const processes = parseKokorosProcessOutput(stdout);
  const portLookup = new Map<number, readonly number[]>();

  for (const processInfo of processes) {
    portLookup.set(processInfo.pid, await getListeningPorts(processInfo.pid));
  }

  return buildDiscoveredServers(processes, configuredPort, portLookup, managedPid);
}

export function stopServerPid(pid: number): void {
  process.kill(pid, "SIGTERM");
}

async function getListeningPorts(pid: number): Promise<number[]> {
  try {
    const { stdout } = await execFile("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN"]);
    return parseListeningPortsOutput(stdout);
  } catch {
    return [];
  }
}
