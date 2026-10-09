import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { DEFAULT_HOST, DEFAULT_PORT, getDaemonPidPath } from "./config.js";

export type DaemonState = "running" | "unhealthy" | "stale_pid" | "stopped" | "wrong_process";

export interface PidRecord {
  pid: number;
  host?: string;
  port?: number;
  startedAt?: string;
}

export interface DaemonStatus {
  state: DaemonState;
  pid?: number;
  host?: string;
  port?: number;
  uptimeSeconds?: number;
  startedAt?: string;
  message: string;
}

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1";
}

export function assertLoopbackHost(host: string): void {
  if (!isLoopbackHost(host)) {
    throw new Error(
      `Refusing to bind non-loopback host "${host}". Use 127.0.0.1 (loopback only).`
    );
  }
}

export function readPidFile(pidPath = getDaemonPidPath()): PidRecord | null {
  if (!existsSync(pidPath)) return null;
  try {
    const data = JSON.parse(readFileSync(pidPath, "utf-8"));
    const pid = Number(data?.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return {
      pid,
      host: typeof data.host === "string" ? data.host : undefined,
      port: typeof data.port === "number" ? data.port : undefined,
      startedAt: typeof data.startedAt === "string" ? data.startedAt : undefined,
    };
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code !== "ESRCH";
  }
}

export function processLooksLikeBridge(pid: number): boolean {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "args="], {
      encoding: "utf-8",
      timeout: 1000,
    }).trim();
    return out.includes("codex-stella-web");
  } catch {
    return false;
  }
}

export function removePidFileIfOwned(expectedPid?: number, pidPath = getDaemonPidPath()): void {
  if (!existsSync(pidPath)) return;
  try {
    if (expectedPid !== undefined) {
      const rec = readPidFile(pidPath);
      if (rec && rec.pid !== expectedPid) return;
    }
    unlinkSync(pidPath);
  } catch {
    // ignore
  }
}

export async function classifyDaemon(
  host = DEFAULT_HOST,
  port = DEFAULT_PORT
): Promise<DaemonStatus> {
  const rec = readPidFile();
  const target = `http://${host}:${port}/health`;

  let health: { ok: boolean; pid?: number; uptimeSeconds?: number; startedAt?: string } = {
    ok: false,
  };
  try {
    const res = await fetch(target, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const json = (await res.json()) as any;
      health = {
        ok: true,
        pid: typeof json.pid === "number" ? json.pid : undefined,
        uptimeSeconds: typeof json.uptimeSeconds === "number" ? json.uptimeSeconds : undefined,
        startedAt: typeof json.startedAt === "string" ? json.startedAt : undefined,
      };
    } else {
      return {
        state: "unhealthy",
        pid: rec?.pid,
        host,
        port,
        message: `Daemon UNHEALTHY (HTTP ${res.status}) at ${target}`,
      };
    }
  } catch {
    health = { ok: false };
  }

  if (health.ok) {
    const pid = health.pid || rec?.pid;
    if (rec && pid && rec.pid !== pid) {
      return {
        state: "running",
        pid,
        host,
        port,
        uptimeSeconds: health.uptimeSeconds,
        startedAt: health.startedAt,
        message: `Daemon RUNNING (health PID ${pid}, pid-file PID ${rec.pid} mismatch) at ${target}`,
      };
    }
    return {
      state: "running",
      pid,
      host,
      port,
      uptimeSeconds: health.uptimeSeconds,
      startedAt: health.startedAt,
      message: `Daemon RUNNING (PID: ${pid ?? "unknown"}, uptime: ${health.uptimeSeconds ?? 0}s) at ${target}`,
    };
  }

  if (rec) {
    if (!isProcessAlive(rec.pid)) {
      return {
        state: "stale_pid",
        pid: rec.pid,
        host: rec.host,
        port: rec.port,
        startedAt: rec.startedAt,
        message: `Daemon STOPPED (stale pid file for PID ${rec.pid}; not listening on ${target})`,
      };
    }
    if (!processLooksLikeBridge(rec.pid)) {
      return {
        state: "wrong_process",
        pid: rec.pid,
        host: rec.host,
        port: rec.port,
        message: `Pid file PID ${rec.pid} is alive but is not the Stella bridge; not killing it.`,
      };
    }
    return {
      state: "unhealthy",
      pid: rec.pid,
      host: rec.host,
      port: rec.port,
      startedAt: rec.startedAt,
      message: `Daemon UNHEALTHY (PID ${rec.pid} alive but ${target} did not respond)`,
    };
  }

  return {
    state: "stopped",
    host,
    port,
    message: `Daemon STOPPED (not listening on ${target})`,
  };
}

export function stopRunningDaemon(): { stopped: boolean; pid?: number; message: string } {
  const pidPath = getDaemonPidPath();
  const rec = readPidFile(pidPath);
  if (!rec) {
    if (existsSync(pidPath)) {
      try {
        unlinkSync(pidPath);
      } catch {
        // ignore
      }
      return { stopped: false, message: "Pid file was malformed and was removed. No process was killed." };
    }
    return { stopped: false, message: "No running bridge daemon found (pid file missing)." };
  }

  if (!isProcessAlive(rec.pid)) {
    removePidFileIfOwned(rec.pid, pidPath);
    return {
      stopped: false,
      pid: rec.pid,
      message: `Pid file referred to dead PID ${rec.pid}; stale pid file removed.`,
    };
  }

  if (!processLooksLikeBridge(rec.pid)) {
    return {
      stopped: false,
      pid: rec.pid,
      message: `Refusing to kill PID ${rec.pid}: it does not look like codex-stella-web.`,
    };
  }

  try {
    process.kill(rec.pid, "SIGTERM");
  } catch (err: any) {
    if (err?.code === "ESRCH") {
      removePidFileIfOwned(rec.pid, pidPath);
      return { stopped: false, pid: rec.pid, message: `PID ${rec.pid} already exited.` };
    }
    return {
      stopped: false,
      pid: rec.pid,
      message: `Failed to signal PID ${rec.pid}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(rec.pid)) break;
    const spinUntil = Date.now() + 50;
    while (Date.now() < spinUntil) {
      /* wait for process exit */
    }
  }

  if (isProcessAlive(rec.pid)) {
    try {
      process.kill(rec.pid, "SIGKILL");
    } catch {
      // ignore
    }
  }

  const gone = !isProcessAlive(rec.pid);
  if (gone) removePidFileIfOwned(rec.pid, pidPath);
  return {
    stopped: gone,
    pid: rec.pid,
    message: gone
      ? `Bridge daemon stopped (PID: ${rec.pid}).`
      : `PID ${rec.pid} did not exit after SIGTERM/SIGKILL.`,
  };
}
