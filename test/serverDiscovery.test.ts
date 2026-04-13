import { describe, expect, it } from "vitest";

import {
  buildDiscoveredServers,
  parseKokorosProcessOutput,
  parseListeningPortsOutput
} from "../src/serverDiscovery";

describe("serverDiscovery", () => {
  it("extracts Kokoros OpenAI processes from ps output", () => {
    const stdout = [
      "401 /tmp/Kokoros/target/release/koko --instances 4 openai --port 3001",
      "999 /usr/bin/python3 something.py",
      "402 koko chat --port 3002",
      "403 koko openai --port 3005"
    ].join("\n");

    expect(parseKokorosProcessOutput(stdout)).toEqual([
      {
        pid: 401,
        command: "/tmp/Kokoros/target/release/koko --instances 4 openai --port 3001"
      },
      {
        pid: 403,
        command: "koko openai --port 3005"
      }
    ]);
  });

  it("extracts listening ports from lsof output", () => {
    const stdout = [
      "COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME",
      "koko    40100 user   12u  IPv4 0x123              0t0  TCP 127.0.0.1:3001 (LISTEN)",
      "koko    40100 user   13u  IPv4 0x124              0t0  TCP *:3005 (LISTEN)"
    ].join("\n");

    expect(parseListeningPortsOutput(stdout)).toEqual([3001, 3005]);
  });

  it("marks managed and configured-port servers when building discovery results", () => {
    const processes = parseKokorosProcessOutput([
      "403 koko openai --port 3005",
      "401 /tmp/Kokoros/target/release/koko --instances 4 openai --port 3001"
    ].join("\n"));

    const lookup = new Map<number, readonly number[]>([
      [401, [3001]],
      [403, [3005, 3006]]
    ]);

    expect(buildDiscoveredServers(processes, 3001, lookup, 403)).toEqual([
      {
        pid: 401,
        command: "/tmp/Kokoros/target/release/koko --instances 4 openai --port 3001",
        ports: [3001],
        managed: false,
        configuredPortMatch: true
      },
      {
        pid: 403,
        command: "koko openai --port 3005",
        ports: [3005, 3006],
        managed: true,
        configuredPortMatch: false
      }
    ]);
  });
});
