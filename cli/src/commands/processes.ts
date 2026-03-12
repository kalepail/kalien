import * as ansi from "../display/ansi";

const PS_ARGS = ["-axo", "pid,ppid,etime,%cpu,command"] as const;
const TERM_WAIT_MS = 4000;
const KILL_WAIT_MS = 1000;

interface KalienRunProcess {
  pid: number;
  ppid: number;
  elapsed: string;
  ageSec: number;
  cpuPct: number;
  command: string;
  orphan: boolean;
}

export interface CleanupOptions {
  all: boolean;
  dryRun: boolean;
  orphanOnly: boolean;
  olderThan: string | null;
}

export async function psCommand(): Promise<void> {
  const processes = listKalienRunProcesses();

  if (processes.length === 0) {
    console.log(ansi.color(ansi.dim, "No active kalien run processes."));
    return;
  }

  printProcessTable(processes);
}

export async function cleanupCommand(opts: CleanupOptions): Promise<void> {
  const minAgeSec = parseOlderThan(opts.olderThan);
  if (opts.olderThan && minAgeSec === null) {
    console.error('Error: --older-than expects a duration like "30s", "10m", "2h", or "1d".');
    process.exit(1);
  }

  const orphanOnly = opts.all ? false : opts.orphanOnly;
  const processes = listKalienRunProcesses().filter((p) => {
    if (p.pid === process.pid) return false;
    if (orphanOnly && !p.orphan) return false;
    if (minAgeSec !== null && p.ageSec < minAgeSec) return false;
    return true;
  });

  if (processes.length === 0) {
    console.log(ansi.color(ansi.dim, "No matching kalien run processes."));
    return;
  }

  printProcessTable(processes);

  if (opts.dryRun) {
    console.log(
      ansi.color(ansi.yellow, `Dry run: would terminate ${processes.length} process(es).`),
    );
    return;
  }

  console.log(ansi.color(ansi.yellow, `Sending SIGTERM to ${processes.length} process(es)...`));

  const termSent: number[] = [];
  for (const proc of processes) {
    if (sendSignal(proc.pid, "SIGTERM")) {
      termSent.push(proc.pid);
    }
  }

  await waitForExit(termSent, TERM_WAIT_MS);
  const stillRunning = termSent.filter((pid) => isProcessAlive(pid));

  if (stillRunning.length > 0) {
    console.log(
      ansi.color(ansi.yellow, `Escalating ${stillRunning.length} process(es) to SIGKILL...`),
    );
    for (const pid of stillRunning) {
      sendSignal(pid, "SIGKILL");
    }
    await waitForExit(stillRunning, KILL_WAIT_MS);
  }

  const remaining = processes.map((p) => p.pid).filter((pid) => isProcessAlive(pid));
  const killedCount = processes.length - remaining.length;

  if (remaining.length === 0) {
    console.log(ansi.color(ansi.green, `Cleanup complete. Terminated ${killedCount} process(es).`));
    return;
  }

  console.log(
    ansi.color(
      ansi.red,
      `Cleanup partial. Terminated ${killedCount}, still running: ${remaining.join(", ")}`,
    ),
  );
}

function listKalienRunProcesses(): KalienRunProcess[] {
  const output = runPs();
  const lines = output.split("\n");
  const processes: KalienRunProcess[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("PID")) continue;

    const match = line.match(/^\s*(\d+)\s+(\d+)\s+([^\s]+)\s+([0-9]+(?:\.[0-9]+)?)\s+(.+)$/);
    if (!match) continue;

    const [, pidRaw, ppidRaw, elapsed, cpuRaw, commandRaw] = match;
    if (!isKalienRunCommand(commandRaw)) continue;

    const pid = Number(pidRaw);
    const ppid = Number(ppidRaw);
    const ageSec = parseEtimeSeconds(elapsed);
    processes.push({
      pid,
      ppid,
      elapsed,
      ageSec,
      cpuPct: Number(cpuRaw),
      command: commandRaw,
      orphan: ppid === 1,
    });
  }

  processes.sort((a, b) => b.ageSec - a.ageSec);
  return processes;
}

function runPs(): string {
  const result = Bun.spawnSync({
    cmd: ["ps", ...PS_ARGS],
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    const stderr = decodeText(result.stderr).trim();
    throw new Error(stderr || "ps command failed");
  }

  return decodeText(result.stdout);
}

function decodeText(data: string | Uint8Array): string {
  if (typeof data === "string") return data;
  return new TextDecoder().decode(data);
}

function isKalienRunCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();

  if (/\bbun run src\/index\.ts run(\s|$)/i.test(normalized)) return true;
  if (/\bkalien\s+run(\s|$)/i.test(normalized)) return true;
  if (/\/kalien(?:-[a-z0-9-]+)?\s+run(\s|$)/i.test(normalized)) return true;
  return false;
}

function parseEtimeSeconds(etime: string): number {
  const match = etime.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!match) return 0;

  const days = Number(match[1] || 0);
  const hours = Number(match[2] || 0);
  const minutes = Number(match[3] || 0);
  const seconds = Number(match[4] || 0);

  return days * 24 * 3600 + hours * 3600 + minutes * 60 + seconds;
}

function parseOlderThan(input: string | null): number | null {
  if (!input) return null;
  if (/^\d+$/.test(input)) return Number(input);

  const match = input.match(/^(\d+)([smhd])$/i);
  if (!match) return null;

  const value = Number(match[1]);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case "s":
      return value;
    case "m":
      return value * 60;
    case "h":
      return value * 3600;
    case "d":
      return value * 24 * 3600;
    default:
      return null;
  }
}

function printProcessTable(processes: KalienRunProcess[]): void {
  const header =
    `${"PID".padEnd(8)}${"PPID".padEnd(8)}${"ELAPSED".padEnd(12)}` +
    `${"CPU%".padEnd(8)}${"ORPHAN".padEnd(10)}COMMAND`;

  console.log(ansi.color(ansi.brightWhite, header));
  for (const proc of processes) {
    const orphanLabel = proc.orphan ? "yes" : "no";
    const orphanCell = ansi.color(proc.orphan ? ansi.yellow : ansi.dim, orphanLabel.padEnd(10));
    const row =
      `${String(proc.pid).padEnd(8)}${String(proc.ppid).padEnd(8)}` +
      `${proc.elapsed.padEnd(12)}${proc.cpuPct.toFixed(1).padEnd(8)}` +
      `${orphanCell}${proc.command}`;
    console.log(row);
  }
}

function sendSignal(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(ansi.color(ansi.red, `Failed to send ${signal} to ${pid}: ${msg}`));
    return false;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? (err as { code?: string }).code
        : undefined;
    return code !== "ESRCH";
  }
}

async function waitForExit(pids: number[], timeoutMs: number): Promise<void> {
  if (pids.length === 0) return;
  const deadline = Date.now() + timeoutMs;

  /* eslint-disable no-await-in-loop -- process exit polling must remain sequential */
  while (Date.now() < deadline) {
    const alive = pids.some((pid) => isProcessAlive(pid));
    if (!alive) return;
    await sleep(150);
  }
  /* eslint-enable no-await-in-loop */
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
