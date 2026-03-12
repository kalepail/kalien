import type { ProofCoordinatorDO } from "./durable/coordinator";
import type { ClaimQueueMessage, ProofQueueMessage } from "./types";

export interface WorkerEnv {
  ASSETS: Fetcher;
  PROOF_QUEUE: Queue<ProofQueueMessage>;
  VAST_QUEUE: Queue<ProofQueueMessage>;
  CLAIM_QUEUE: Queue<ClaimQueueMessage>;
  PROOF_COORDINATOR: DurableObjectNamespace<ProofCoordinatorDO>;
  PROOF_ARTIFACTS: R2Bucket;
  LEADERBOARD_DB: D1Database;
  PROVER_BASE_URL: string;
  PROVER_API_KEY?: string;
  PROVER_ACCESS_CLIENT_ID?: string;
  PROVER_ACCESS_CLIENT_SECRET?: string;
  PROVER_EXPECTED_IMAGE_ID?: string;
  MAX_PROOF_TOTAL_WALL_TIME_MS?: string;
  MAX_PROVER_RUN_TIME_MS?: string;
  COMPLETED_JOB_RETENTION_MS?: string;
  ALLOW_INSECURE_PROVER_URL?: string;
  RELAYER_URL?: string;
  RELAYER_API_KEY?: string;
  RELAYER_PLUGIN_ID?: string;
  DEV_API_KEY?: string;
  SCORE_CONTRACT_ID?: string;
  LEADERBOARD_SYNC_CRON_ENABLED?: string;
  LEADERBOARD_SYNC_CRON_LIMIT?: string;
  LEADERBOARD_CATCHUP_INTERVAL_MINUTES?: string;
  LEADERBOARD_CATCHUP_WINDOW_LEDGERS?: string;
  LEADERBOARD_TAPE_BACKFILL_ENABLED?: string;
  LEADERBOARD_TAPE_BACKFILL_INTERVAL_MINUTES?: string;
  LEADERBOARD_TAPE_STALE_PRUNE_ENABLED?: string;
  LEADERBOARD_TAPE_STALE_PRUNE_INTERVAL_MINUTES?: string;
  SMART_ACCOUNT_INDEXER_URL?: string;
  STELLAR_RPC_URL?: string;
  GALEXIE_SOURCE_MODE?: string;
  GALEXIE_DATASTORE_ROOT_PATH?: string;
  GALEXIE_DATASTORE_OBJECT_EXTENSION?: string;
  GALEXIE_API_BASE_URL?: string;
  GALEXIE_API_KEY?: string;
  GALEXIE_RPC_BASE_URL?: string;
  GALEXIE_REQUEST_TIMEOUT_MS?: string;
  GALEXIE_SCORE_EVENTS_PATH?: string;
  GALEXIE_ENABLE_EVENTS_API_FALLBACK?: string;
  GALEXIE_DATALAKE_MAX_MISSING_FILES?: string;
  CLAIM_NETWORK_PASSPHRASE?: string;
  // Boundless proving (alternative to PROVER_BASE_URL)
  BOUNDLESS_RPC_URL?: string;
  BOUNDLESS_PRIVATE_KEY?: string;
  BOUNDLESS_IMAGE_URL?: string;
  BOUNDLESS_IMAGE_ID?: string;
  BOUNDLESS_MIN_PRICE_USD?: string;
  BOUNDLESS_MAX_PRICE_USD?: string;
  BOUNDLESS_LOCK_COLLATERAL_ZKC?: string;
  // JIT top-up buffer (basis points) applied to the funding deficit.
  BOUNDLESS_TOP_UP_BUFFER_BPS?: string;
  BOUNDLESS_POLL_TIMEOUT_MS?: string;
  // Auction shape
  BOUNDLESS_FLAT_PERIOD_SEC?: string;
  BOUNDLESS_RAMP_PERIOD_SEC?: string;
  BOUNDLESS_LOCK_TIMEOUT_SEC?: string;
  BOUNDLESS_TIMEOUT_SEC?: string;
  // Optional overrides for non-default Boundless deployments
  BOUNDLESS_CHAIN_ID?: string;
  BOUNDLESS_MARKET_ADDRESS?: string;
  BOUNDLESS_ORDER_STREAM_URL?: string;
  BOUNDLESS_DEPLOYMENT_BLOCK?: string;
  // IPFS (Pinata) — used by Boundless for stdin upload when inline exceeds order stream limits
  PINATA_JWT?: string;
}
