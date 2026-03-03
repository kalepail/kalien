import { spawnSync } from "node:child_process";

if (process.platform === "win32") {
  console.log("[format:check] Skipping on Windows due CRLF checkout behavior.");
  process.exit(0);
}

const result = spawnSync("bun", ["x", "oxfmt", "src", "worker", "--check"], {
  stdio: "inherit",
});

process.exit(result.status ?? 1);
