import { execFile } from "child_process";
import { getDb } from "./db";

export interface HealthReport {
  ok: boolean;
  cliFound: boolean;
  version: string | null;
  loggedIn: boolean | null;
  databaseOk: boolean;
  message: string;
}

function run(args: string[], timeoutMs = 10_000): Promise<{ stdout: string; err?: Error }> {
  return new Promise((resolve) => {
    execFile("claude", args, { timeout: timeoutMs, killSignal: "SIGKILL" }, (err, stdout) =>
      resolve({ stdout: stdout ?? "", err: err ?? undefined })
    );
  });
}

/**
 * Can the app reach its own database? Cheap enough to run on every check, and
 * worth running: when the compiled SQLite driver won't load, every page that
 * touches data fails on its own with the same error, and none of them is a
 * place the user would think to look for a diagnosis.
 */
function checkDatabase(): { ok: boolean; message: string | null } {
  try {
    getDb().prepare("SELECT 1").get();
    return { ok: true, message: null };
  } catch (err) {
    return {
      ok: false,
      message:
        err instanceof Error ? err.message : "The app's database could not be opened.",
    };
  }
}

/**
 * Fast, token-free preflight: is the claude CLI installed and logged in, and
 * is the database usable? Both CLI subcommands complete in under a second on a
 * healthy setup.
 */
export async function checkHealth(): Promise<HealthReport> {
  const db = checkDatabase();

  // Reported together when both are broken. They usually are, because they
  // share a cause — the app started with a different Node and PATH than the
  // one everything was installed with — and fixing one silently leaves the
  // other looking like a fresh problem.
  const withDb = (report: Omit<HealthReport, "databaseOk">): HealthReport => ({
    ...report,
    databaseOk: db.ok,
    ok: report.ok && db.ok,
    message: db.ok ? report.message : `${db.message} ${report.ok ? "" : report.message}`.trim(),
  });

  const version = await run(["--version"]);
  if (version.err) {
    const notFound = (version.err as NodeJS.ErrnoException).code === "ENOENT";
    return withDb({
      ok: false,
      cliFound: false,
      version: null,
      loggedIn: null,
      message: notFound
        ? "The claude program isn't installed (or can't be found). In Terminal, run: npm install -g @anthropic-ai/claude-code"
        : `The claude program failed to start: ${version.err.message.slice(0, 200)}`,
    });
  }

  const auth = await run(["auth", "status"]);
  let loggedIn: boolean | null = null;
  try {
    const parsed = JSON.parse(auth.stdout) as { loggedIn?: boolean };
    if (typeof parsed.loggedIn === "boolean") loggedIn = parsed.loggedIn;
  } catch {
    // Older CLI versions may print non-JSON; fall back to a text sniff.
    if (/logged\s*in|loggedIn.*true/i.test(auth.stdout)) loggedIn = true;
  }

  if (loggedIn === false) {
    return withDb({
      ok: false,
      cliFound: true,
      version: version.stdout.trim(),
      loggedIn: false,
      message:
        "Claude is installed but not logged in. In Terminal, run: claude   …then choose “log in with your Claude account”, finish in the browser, and type /exit.",
    });
  }

  return withDb({
    ok: true,
    cliFound: true,
    version: version.stdout.trim(),
    loggedIn,
    message: "Claude CLI is installed and logged in.",
  });
}
