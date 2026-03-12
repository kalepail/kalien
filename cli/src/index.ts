#!/usr/bin/env bun

import { cpus } from "os";
import { cleanupCommand, psCommand } from "./commands/processes";
import { replayCommand } from "./commands/replay";
import { runCommand } from "./commands/run";
import * as ansi from "./display/ansi";
import { NETWORKS, type NetworkName } from "./constants";

const HELP = `
${ansi.brightCyan}KALIEN${ansi.reset} - Autonomous Asteroids Farming CLI

${ansi.bold}USAGE${ansi.reset}
  kalien run --address <STELLAR_ADDRESS> [options]
  kalien replay <tape-file>
  kalien ps
  kalien cleanup [options]

${ansi.bold}COMMANDS${ansi.reset}
  run       Start autonomous farming (play games + submit tapes)
  replay    ASCII replay of a .tape file in the terminal
  ps        List active kalien run processes
  cleanup   Terminate stale kalien run processes

${ansi.bold}RUN OPTIONS${ansi.reset}
  --address <addr>      Stellar wallet address for claims (required)
  --threads <n|max|%>   Worker count: number, "max", or percentage (e.g. "25%"). Default: 50%
  --api-url <url>       API base URL (default: per network)
  --network <net>          Stellar network: testnet or mainnet (default: testnet)
  --rpc-url <url>          Stellar RPC URL override (default: per network)
  --contract-id <addr>     Score contract address (default: per network)
  --relayer-api-key <key>  OZ channels relayer API key — materializes/indexes epoch seed if cron hasn't fired yet

${ansi.bold}CLEANUP OPTIONS${ansi.reset}
  --dry-run             Show matching processes without terminating them
  --orphan-only         Only target orphaned runs (default unless --all)
  --all                 Target all matching kalien run processes
  --older-than <dur>    Minimum process age, e.g. 30s, 10m, 2h, 1d

${ansi.bold}EXAMPLES${ansi.reset}
  kalien run --address GABC...XYZ
  kalien run --address GABC...XYZ --threads 4
  kalien run --address GABC...XYZ --threads 25%
  kalien run --address GABC...XYZ --threads max
  kalien replay game.tape
  kalien ps
  kalien cleanup --dry-run
  kalien cleanup --orphan-only --older-than 5m
`;

function parseArgs(argv: string[]): {
  command: string;
  args: Record<string, string>;
  positional: string[];
} {
  const booleanFlags = new Set(["help", "dry-run", "all", "orphan-only"]);
  const args: Record<string, string> = {};
  const positional: string[] = [];
  let command = "";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!command && !arg.startsWith("-")) {
      command = arg;
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (booleanFlags.has(key)) {
        args[key] = "true";
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        args[key] = argv[++i];
      }
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    }
  }

  return { command, args, positional };
}

async function main(): Promise<void> {
  const { command, args, positional } = parseArgs(process.argv.slice(2));

  if (args["help"] || (!command && positional.length === 0)) {
    console.log(HELP);
    process.exit(0);
  }

  switch (command) {
    case "run": {
      const address = args["address"];
      if (!address) {
        console.error("Error: --address is required for the run command");
        console.error("Usage: kalien run --address <STELLAR_ADDRESS>");
        process.exit(1);
      }

      if (!/^[GC][A-Z2-7]{55}$/.test(address)) {
        console.error(
          "Error: Invalid Stellar address format (must be 56 chars, starting with G or C)",
        );
        process.exit(1);
      }

      const network = (args["network"] || "testnet") as NetworkName;
      if (!(network in NETWORKS)) {
        console.error(`Error: --network must be "testnet" or "mainnet"`);
        process.exit(1);
      }

      const { relayerUrl: relayerBaseUrl } = NETWORKS[network];
      const rpcUrl = args["rpc-url"] || NETWORKS[network].rpcUrl;
      const contractId = args["contract-id"] || NETWORKS[network].contractId;
      const tokenContractId = NETWORKS[network].tokenContractId;
      const relayerApiKey = args["relayer-api-key"] || null;

      const coreCount = cpus().length;
      const threads =
        args["threads"] === "max"
          ? coreCount
          : args["threads"]?.endsWith("%")
            ? Math.max(1, Math.round((coreCount * parseInt(args["threads"])) / 100))
            : args["threads"]
              ? parseInt(args["threads"], 10)
              : 0;

      await runCommand({
        network,
        networkPassphrase: NETWORKS[network].networkPassphrase,
        address,
        threads,
        apiUrl: args["api-url"] || NETWORKS[network].apiUrl,
        rpcUrl,
        contractId,
        tokenContractId,
        relayerBaseUrl,
        relayerApiKey,
      });
      break;
    }

    case "replay": {
      const tapePath = positional[0];
      if (!tapePath) {
        console.error("Error: tape file path is required");
        console.error("Usage: kalien replay <tape-file>");
        process.exit(1);
      }

      await replayCommand(tapePath);
      break;
    }

    case "ps": {
      await psCommand();
      break;
    }

    case "cleanup": {
      await cleanupCommand({
        all: args["all"] === "true",
        dryRun: args["dry-run"] === "true",
        orphanOnly: args["all"] === "true" ? false : args["orphan-only"] !== "false",
        olderThan: args["older-than"] || null,
      });
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Fatal error: ${message}`);
  if (process.env.KALIEN_DEBUG === "1" && err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
