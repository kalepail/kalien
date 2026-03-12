import http from "node:http";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { scValToNative, xdr } from "@stellar/stellar-base";

const PORT = Number.parseInt(process.env.ADAPTER_PORT || "4041", 10);
const RPC_URL = process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org";

const SCORE_EVENT_KEYS = new Set(["score_submitted"]);

interface RawEvent {
  id?: string;
  topic?: string[];
  value?: string;
  txHash?: string;
  operationIndex?: number;
  ledger?: number;
  ledgerClosedAt?: string;
}

interface NormalizedEvent {
  id: string | undefined;
  claimant: string;
  seed: number;
  frame_count: number;
  final_score: number;
  previous_best: number;
  new_best: number;
  minted_delta: number;
  tx_hash: string | null;
  event_index: number;
  ledger: number | null;
  closed_at: string | null;
}

function normalizeEventKey(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "");
}

function decodeScValBase64(base64: unknown): unknown {
  if (typeof base64 !== "string" || base64.length === 0) {
    return null;
  }

  try {
    const bytes = Buffer.from(base64, "base64");
    const scVal = xdr.ScVal.fromXDR(bytes);
    return scValToNative(scVal);
  } catch {
    return null;
  }
}

function toInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      return null;
    }
    return Number(value);
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function readMapValue(mapLike: unknown, keys: string[]): unknown {
  if (mapLike instanceof Map) {
    for (const key of keys) {
      if (mapLike.has(key)) {
        return mapLike.get(key);
      }
    }

    for (const [key, value] of mapLike.entries()) {
      if (typeof key === "string" && keys.includes(key)) {
        return value;
      }
    }

    return undefined;
  }

  if (mapLike && typeof mapLike === "object") {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(mapLike, key)) {
        return (mapLike as Record<string, unknown>)[key];
      }
    }
  }

  return undefined;
}

function normalizeEvent(raw: RawEvent): NormalizedEvent | null {
  const topic =
    Array.isArray(raw.topic) && raw.topic.length > 0 ? decodeScValBase64(raw.topic[0]) : null;
  const eventName = normalizeEventKey(typeof topic === "string" ? topic : null);
  if (!eventName || !SCORE_EVENT_KEYS.has(eventName)) {
    return null;
  }

  const nativeData = decodeScValBase64(raw.value);
  if (!nativeData) {
    return null;
  }

  const claimant = readMapValue(nativeData, ["claimant"]);
  const seed = toInt(readMapValue(nativeData, ["seed"]));
  const frameCount = toInt(readMapValue(nativeData, ["frame_count"]));
  const finalScore = toInt(readMapValue(nativeData, ["final_score"]));
  const previousBest = toInt(readMapValue(nativeData, ["previous_best"]));
  const newBest = toInt(readMapValue(nativeData, ["new_best"]));
  const mintedDelta = toInt(readMapValue(nativeData, ["minted_delta"]));

  if (
    typeof claimant !== "string" ||
    claimant.trim().length === 0 ||
    seed === null ||
    seed < 0 ||
    frameCount === null ||
    frameCount < 0 ||
    finalScore === null ||
    finalScore <= 0 ||
    previousBest === null ||
    previousBest < 0 ||
    newBest === null ||
    newBest <= 0 ||
    mintedDelta === null ||
    mintedDelta < 0 ||
    finalScore !== newBest ||
    previousBest > newBest ||
    mintedDelta !== newBest - previousBest
  ) {
    return null;
  }

  return {
    id: raw.id,
    claimant,
    seed,
    frame_count: frameCount,
    final_score: finalScore,
    previous_best: previousBest,
    new_best: newBest,
    minted_delta: mintedDelta,
    tx_hash: typeof raw.txHash === "string" ? raw.txHash : null,
    event_index:
      raw.operationIndex != null && Number.isFinite(raw.operationIndex) ? raw.operationIndex : 0,
    ledger: raw.ledger != null && Number.isFinite(raw.ledger) ? raw.ledger : null,
    closed_at: typeof raw.ledgerClosedAt === "string" ? raw.ledgerClosedAt : null,
  };
}

interface RpcEventFilter {
  type: string;
  contractIds?: string[];
}

interface RpcGetEventsParams {
  filters: RpcEventFilter[];
  pagination: { limit: number; cursor?: string };
  startLedger?: number;
  endLedger?: number;
}

async function handleEvents(url: URL, res: http.ServerResponse): Promise<void> {
  const requestedEventName = url.searchParams.get("event_name");
  const requestedEventKey = normalizeEventKey(requestedEventName || "score_submitted");
  if (!requestedEventKey || !SCORE_EVENT_KEYS.has(requestedEventKey)) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ events: [], next_cursor: null }));
    return;
  }

  const limit = Number.parseInt(url.searchParams.get("limit") || "200", 10);
  const cursor = url.searchParams.get("cursor");
  const fromLedgerRaw = url.searchParams.get("from_ledger");
  const toLedgerRaw = url.searchParams.get("to_ledger");
  const contractId = url.searchParams.get("contract_id");

  const pagination: { limit: number; cursor?: string } = {
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 200,
  };

  if (cursor && cursor.trim().length > 0) {
    pagination.cursor = cursor.trim();
  }

  const params: RpcGetEventsParams = {
    filters: [
      {
        type: "contract",
      },
    ],
    pagination,
  };

  if (contractId && contractId.trim().length > 0) {
    const [firstFilter] = params.filters;
    if (firstFilter) {
      firstFilter.contractIds = [contractId.trim()];
    }
  }

  const fromLedger = Number.parseInt(fromLedgerRaw || "", 10);
  const toLedger = Number.parseInt(toLedgerRaw || "", 10);
  if (Number.isFinite(fromLedger) && fromLedger >= 2) {
    params.startLedger = fromLedger;
  }
  if (Number.isFinite(toLedger) && toLedger >= 2) {
    params.endLedger = toLedger;
  }

  const rpcResponse = await fetch(RPC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getEvents",
      params,
    }),
  });

  if (!rpcResponse.ok) {
    const body = await rpcResponse.text();
    res.writeHead(502, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: `rpc error ${rpcResponse.status}: ${body.slice(0, 300)}`,
      }),
    );
    return;
  }

  const payload = (await rpcResponse.json()) as {
    result?: { events?: RawEvent[]; cursor?: string; latestLedger?: number };
  };
  const events = Array.isArray(payload?.result?.events) ? (payload.result?.events ?? []) : [];
  const normalized: NormalizedEvent[] = [];
  for (const event of events) {
    const mapped = normalizeEvent(event);
    if (mapped) {
      normalized.push(mapped);
    }
  }

  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      events: normalized,
      next_cursor: typeof payload?.result?.cursor === "string" ? payload.result.cursor : null,
      latest_ledger: payload?.result?.latestLedger ?? null,
    }),
  );
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

    if (req.method === "GET" && url.pathname === "/events") {
      await handleEvents(url, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`adapter_ready http://127.0.0.1:${PORT}\n`);
});
