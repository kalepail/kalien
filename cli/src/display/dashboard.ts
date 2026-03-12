import * as ansi from "./ansi";

export interface DashboardStats {
  totalGamesPlayed: number;
  epochGamesPlayed: number;
  bestScore: number;
  lastSubmittedScore: number;
  totalSubmissions: number;
  lastSubmitStatus: string;
  epochRemainingSec: number;
  currentSeed: number | null;
  threads: number;
  availableCores: number;
  address: string;
  startTime: number;
  workerBests: number[];
  onChainBestScore: number;
  epochSubmissions: number;
  maxSubmissionsPerEpoch: number;
  settleRemainingSec: number;
}

const LOGO = [
  "  _  __   _   _     ___ ___ _  _ ",
  " | |/ /  /_\\ | |   |_ _| __| \\| |",
  " | ' <  / _ \\| |__  | || _|| .` |",
  " |_|\\_\\/_/ \\_\\____||___|___|_|\\_|",
];

let lastLineCount = 0;

export function renderDashboard(stats: DashboardStats): void {
  const {
    totalGamesPlayed,
    epochGamesPlayed,
    bestScore,
    lastSubmittedScore,
    totalSubmissions,
    lastSubmitStatus,
    epochRemainingSec,
    currentSeed,
    threads,
    availableCores,
    address,
    startTime,
    workerBests,
    onChainBestScore,
    epochSubmissions,
    maxSubmissionsPerEpoch,
    settleRemainingSec,
  } = stats;

  const elapsedSec = (Date.now() - startTime) / 1000;
  const gamesPerMin = elapsedSec > 0 ? ((totalGamesPlayed / elapsedSec) * 60).toFixed(1) : "0.0";
  const elapsedStr = formatDuration(elapsedSec);
  const epochStr = formatDuration(epochRemainingSec);
  const shortAddr = address.length > 12 ? `${address.slice(0, 6)}...${address.slice(-4)}` : address;

  const hasThreshold = lastSubmittedScore > 0;
  const scoreColor = hasThreshold ? ansi.green : ansi.brightGreen;
  const scoreLabel = hasThreshold
    ? `${bestScore} (to beat: ${lastSubmittedScore})`
    : String(bestScore);

  const budgetColor =
    epochSubmissions >= maxSubmissionsPerEpoch
      ? ansi.red
      : epochSubmissions >= maxSubmissionsPerEpoch - 2
        ? ansi.yellow
        : ansi.green;
  const budgetLabel = `${maxSubmissionsPerEpoch - epochSubmissions}/${maxSubmissionsPerEpoch}`;

  // Build per-thread score chips.
  // Worker 0 = exploit (shown in green), rest = explore (shown in blue).
  // The worker with the global best score gets a ★ marker.
  const globalBest = Math.max(...workerBests);
  const threadChips = workerBests.map((score, i) => {
    const isExploit = i === 0;
    const isGlobalBest = score > 0 && score === globalBest;
    const label = isExploit ? "E" : "x";
    const star = isGlobalBest ? "★" : " ";
    const scoreStr = score > 0 ? String(score) : "…";
    const chipColor = isExploit ? ansi.green : ansi.cyan;
    return ansi.color(chipColor, `[${label}:${scoreStr}${star}]`);
  });

  // Wrap chips into rows of 6
  const CHIPS_PER_ROW = 6;
  const chipRows: string[] = [];
  for (let i = 0; i < threadChips.length; i += CHIPS_PER_ROW) {
    chipRows.push(threadChips.slice(i, i + CHIPS_PER_ROW).join(" "));
  }

  const lines: string[] = [];

  // Logo
  for (const line of LOGO) {
    lines.push(ansi.color(ansi.brightCyan, line));
  }
  lines.push("");

  // Status
  lines.push(
    `  ${ansi.color(ansi.gray, "Address:")}    ${ansi.color(ansi.white, shortAddr)}    ${ansi.color(ansi.gray, "Uptime:")} ${ansi.color(ansi.white, elapsedStr)}`,
  );
  lines.push("");

  // Epoch info
  const seedStr =
    currentSeed !== null
      ? `0x${currentSeed.toString(16).padStart(8, "0").toUpperCase()}`
      : ansi.color(ansi.dim, "fetching...");
  lines.push(
    `  ${ansi.color(ansi.gray, "Seed:")}       ${ansi.color(ansi.brightWhite, seedStr)}    ${ansi.color(ansi.gray, "Next seed:")} ${ansi.color(ansi.cyan, epochStr)}`,
  );
  lines.push(
    `  ${ansi.color(ansi.gray, "Games:")}      ${ansi.color(ansi.brightWhite, String(epochGamesPlayed))} ${ansi.color(ansi.dim, `this epoch (${totalGamesPlayed} total)`)}    ${ansi.color(ansi.gray, "Rate:")} ${ansi.color(ansi.white, gamesPerMin + "/min")}`,
  );

  // Per-thread scores (E = exploit, x = explore, ★ = global best holder)
  const threadLabel = `  ${ansi.color(ansi.gray, `Threads (${threads}/${availableCores}):`)} `;
  lines.push(threadLabel + chipRows[0]);
  for (let r = 1; r < chipRows.length; r++) {
    lines.push(" ".repeat(16) + chipRows[r]);
  }
  lines.push("");

  // Score section
  lines.push(`  ${ansi.color(ansi.gray, "Best:")}       ${ansi.color(scoreColor, scoreLabel)}`);

  if (onChainBestScore > 0) {
    lines.push(
      `  ${ansi.color(ansi.gray, "On-chain:")}   ${ansi.color(ansi.brightYellow, String(onChainBestScore))} ${ansi.color(ansi.dim, "(your best, all seeds)")}`,
    );
  }

  // Settle indicator
  if (settleRemainingSec > 0) {
    lines.push(
      `  ${ansi.color(ansi.gray, "Settling:")}   ${ansi.color(ansi.cyan, `${settleRemainingSec}s`)} ${ansi.color(ansi.dim, "waiting for score to stabilize")}`,
    );
  }
  lines.push("");

  // Submission info
  lines.push(
    `  ${ansi.color(ansi.gray, "Submissions:")} ${ansi.color(ansi.brightYellow, String(totalSubmissions))}    ${ansi.color(ansi.gray, "Budget:")} ${ansi.color(budgetColor, budgetLabel)} ${ansi.color(ansi.dim, "remaining this epoch")}`,
  );
  if (lastSubmitStatus) {
    lines.push(`  ${ansi.color(ansi.gray, "Status:")}     ${lastSubmitStatus}`);
  }
  lines.push("");
  lines.push(`  ${ansi.color(ansi.dim, "E=exploit  x=explore  ★=global best    Ctrl+C to stop")}`);

  // Clear previous output, write new
  const output =
    (lastLineCount > 0 ? ansi.cursorUp(lastLineCount) : "") +
    lines.map((l) => ansi.clearLine + l).join("\n") +
    ansi.clearDown;

  process.stdout.write(output + "\n");
  lastLineCount = lines.length;
}

function formatDuration(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}
