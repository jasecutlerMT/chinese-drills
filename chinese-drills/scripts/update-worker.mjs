#!/usr/bin/env node
/**
 * Detached update worker. Runs OUTSIDE the Next.js server process so the
 * update survives the dev server restarting mid-way (it watches its own
 * config files) and so a failed `npm install` can be rolled back.
 *
 *   node scripts/update-worker.mjs <appDir> <serverPid> <zipUrl>
 *
 * Steps: download ZIP → unzip → back up current code → install new deps →
 * write .restart → swap code in → kill the old server (the launcher's loop
 * restarts it). On any failure: restore the backup and log to update-log.txt.
 */
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const [appDir, serverPidArg, zipUrl] = process.argv.slice(2);
const serverPid = Number(serverPidArg);
const logFile = path.join(appDir, "update-log.txt");

function log(msg) {
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
}

// Never overwrite or delete these: user data and heavyweight build state.
const KEEP = new Set(["data", "node_modules", ".next", ".restart", "update-log.txt"]);

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/**
 * data/ is the user's — practice history and cached audio live there and are
 * never swapped wholesale. But data/lessons.json is shipped textbook content
 * that the user is also invited to correct by hand, so it needs both: refresh
 * it while it is still exactly as some release shipped it, and once it has been
 * corrected, leave it alone and drop the new one beside it.
 *
 * "As shipped" is decided by comparing against the list of every lessons.json
 * hash this project has released, which travels inside the release itself. A
 * per-install stamp file was tried first and was the wrong shape: it lived in
 * data/, so it had to be written by the updater rather than shipped, which left
 * fresh installs with nothing to compare against.
 */
function updateLessonData(srcDir, appDir) {
  const incomingPath = path.join(srcDir, "data", "lessons.json");
  if (!fs.existsSync(incomingPath)) return;

  const dataDir = path.join(appDir, "data");
  const current = path.join(dataDir, "lessons.json");
  const incoming = fs.readFileSync(incomingPath);
  fs.mkdirSync(dataDir, { recursive: true });

  if (!fs.existsSync(current)) {
    fs.writeFileSync(current, incoming);
    log("lesson data installed");
    return;
  }

  const knownPath = path.join(srcDir, "data", "lessons-known-hashes.txt");
  const known = new Set(
    fs.existsSync(knownPath)
      ? fs
          .readFileSync(knownPath, "utf8")
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("#"))
      : []
  );

  // Unrecognised means corrected — including when the list is missing, because
  // losing someone's corrections is worse than leaving them on older data with
  // the new file sitting beside it and a line in the log saying so.
  if (!known.has(sha(fs.readFileSync(current)))) {
    fs.writeFileSync(path.join(dataDir, "lessons.incoming.json"), incoming);
    log(
      "data/lessons.json differs from every released version, so it looks like you " +
        "have corrected it and it was kept as-is — the new textbook data is in " +
        "data/lessons.incoming.json"
    );
    return;
  }
  fs.writeFileSync(current, incoming);
  log("lesson data refreshed");
}

async function main() {
  fs.writeFileSync(logFile, ""); // fresh log per update
  log(`update started (server pid ${serverPid})`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "drills-update-"));
  const backupDir = path.join(tmp, "backup");
  fs.mkdirSync(backupDir);
  let backedUp = [];
  let depsTouched = false;

  try {
    // 1. Download via curl (ships with macOS, honors system proxies).
    log(`downloading ${zipUrl}`);
    const zipPath = path.join(tmp, "update.zip");
    await execFileAsync(
      "curl",
      ["-sfL", "--max-time", "300", zipUrl, "-o", zipPath],
      { timeout: 320_000 }
    ).catch(() => {
      throw new Error("download failed — is the computer online?");
    });

    // 2. Unzip and locate the app inside the repo ZIP.
    await execFileAsync("unzip", ["-q", "-o", zipPath, "-d", tmp], { timeout: 120_000 });
    const extractedRoot = fs
      .readdirSync(tmp, { withFileTypes: true })
      .find((d) => d.isDirectory() && d.name !== "backup")?.name;
    const srcDir = path.join(tmp, extractedRoot ?? "", "chinese-drills");
    if (!fs.existsSync(path.join(srcDir, "package.json"))) {
      throw new Error("downloaded ZIP did not contain the app");
    }
    const items = fs.readdirSync(srcDir).filter((i) => !KEEP.has(i));

    // 3. Back up everything we're about to touch, for rollback.
    for (const item of items) {
      const cur = path.join(appDir, item);
      if (fs.existsSync(cur)) {
        fs.cpSync(cur, path.join(backupDir, item), { recursive: true });
        backedUp.push(item);
      }
    }

    // 4. Install new dependencies BEFORE swapping code in, so a registry
    //    failure leaves the running app untouched.
    log("installing dependencies…");
    for (const f of ["package.json", "package-lock.json"]) {
      const src = path.join(srcDir, f);
      if (fs.existsSync(src)) fs.cpSync(src, path.join(appDir, f), { force: true });
    }
    // From here node_modules may be half-written, and it is too big to back up.
    // Rollback has to repair it by reinstalling against the restored manifests.
    depsTouched = true;
    await execFileAsync("npm", ["install", "--no-audit", "--no-fund"], {
      cwd: appDir,
      timeout: 600_000,
    });
    depsTouched = false;

    // 5. Arm the launcher's restart loop BEFORE the code swap: if the file
    //    churn crashes the old dev server, the launcher restarts it anyway.
    fs.writeFileSync(path.join(appDir, ".restart"), new Date().toISOString());

    // 6. Swap the code in. src/ is replaced wholesale so files deleted
    //    upstream actually disappear; root files are overwritten in place.
    for (const item of items) {
      const dst = path.join(appDir, item);
      if (item === "src") fs.rmSync(dst, { recursive: true, force: true });
      fs.cpSync(path.join(srcDir, item), dst, { recursive: true, force: true });
    }
    updateLessonData(srcDir, appDir);

    // Stale compiled output would mask the new code on the next boot.
    fs.rmSync(path.join(appDir, ".next"), { recursive: true, force: true });

    log("update applied — restarting the server");
    try {
      process.kill(serverPid);
    } catch {
      log("old server already gone (it likely restarted itself) — that's fine");
    }
    log("done");
  } catch (err) {
    log(`FAILED: ${err instanceof Error ? err.message : err}`);
    for (const item of backedUp) {
      try {
        const dst = path.join(appDir, item);
        fs.rmSync(dst, { recursive: true, force: true });
        fs.cpSync(path.join(backupDir, item), dst, { recursive: true, force: true });
      } catch (restoreErr) {
        log(`rollback of ${item} failed: ${restoreErr}`);
      }
    }
    // Restoring the old package.json is not enough: a half-finished install
    // leaves node_modules matching neither version, and the launcher only
    // reinstalls when node_modules is missing entirely — so a broken one would
    // sit there and the app would refuse to start with no way in.
    if (depsTouched) {
      log("repairing the app's components after the failed install…");
      try {
        await execFileAsync("npm", ["install", "--no-audit", "--no-fund"], {
          cwd: appDir,
          timeout: 600_000,
        });
        log("components repaired");
      } catch {
        log(
          "COULD NOT REPAIR the app's components. Open Terminal, run:  cd " +
            `"${appDir}" && rm -rf node_modules && npm install  ` +
            "— then start the app again."
        );
      }
    }
    fs.rmSync(path.join(appDir, ".restart"), { force: true });
    log("rolled back to the previous version");
    process.exitCode = 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main();
