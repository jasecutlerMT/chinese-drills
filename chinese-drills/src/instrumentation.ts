export async function register() {
  // Exact comparison required: it's statically replaced at build time, so the
  // edge bundle dead-code-eliminates the node-only import below.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
