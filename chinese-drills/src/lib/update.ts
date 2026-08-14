import fs from "fs";
import path from "path";
import { spawn } from "child_process";

// Updates are served from a PUBLIC release repo (the main development repo is
// private, and the app must be able to download updates without a GitHub
// login). Both pointers live in version.json so a future release can repoint
// them without touching code.
const DEFAULT_REPO = "jasecutlerMT/chinese-drills";
const DEFAULT_BRANCH = "main";

export interface VersionInfo {
  version: number;
  label: string;
  repo?: string;
  branch?: string;
}

export function currentVersion(): VersionInfo {
  const file = path.join(process.cwd(), "version.json");
  return JSON.parse(fs.readFileSync(file, "utf-8")) as VersionInfo;
}

function releaseSource(): { repo: string; branch: string } {
  const v = currentVersion();
  return { repo: v.repo ?? DEFAULT_REPO, branch: v.branch ?? DEFAULT_BRANCH };
}

export function zipUrl(): string {
  const { repo, branch } = releaseSource();
  return `https://codeload.github.com/${repo}/zip/refs/heads/${branch}`;
}

export interface UpdateCheck {
  current: VersionInfo;
  latest: VersionInfo | null;
  updateAvailable: boolean;
  error?: string;
}

export async function checkForUpdate(): Promise<UpdateCheck> {
  const current = currentVersion();
  const { repo, branch } = releaseSource();
  const url = `https://raw.githubusercontent.com/${repo}/${branch}/chinese-drills/version.json`;
  try {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
    const latest = (await res.json()) as VersionInfo;
    return { current, latest, updateAvailable: latest.version > current.version };
  } catch (err) {
    return {
      current,
      latest: null,
      updateAvailable: false,
      error: `Couldn't reach GitHub to check for updates (${
        err instanceof Error ? err.message : "network error"
      }). Are you online?`,
    };
  }
}

/**
 * Launches the detached update worker and returns immediately. The worker
 * survives this server process dying (which is the point: applying an
 * update restarts the server). Progress lands in update-log.txt.
 */
export function startUpdate(): void {
  const appDir = process.cwd();
  const worker = path.join(appDir, "scripts", "update-worker.mjs");
  const child = spawn(process.execPath, [worker, appDir, String(process.pid), zipUrl()], {
    detached: true,
    stdio: "ignore",
    cwd: appDir,
  });
  child.unref();
}

export function updateLog(): string {
  const file = path.join(process.cwd(), "update-log.txt");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
}
