import {
  startAuthentication,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import type { ClaimStatus } from "@/proof/api";
import { fetchWithTimeout as baseFetchWithTimeout, parseJson } from "@/lib/api";

export type { ClaimStatus };

export type LeaderboardWindow = "10m" | "day" | "all";

export interface PlayerProfile {
  claimantAddress: string;
  username: string | null;
  linkUrl: string | null;
  updatedAt: string;
}

export interface LeaderboardEntry {
  rank: number;
  jobId: string;
  claimantAddress: string;
  profile: PlayerProfile | null;
  score: number;
  mintedDelta: number;
  seed: number;
  frameCount: number | null;
  completedAt: string;
  claimStatus: ClaimStatus;
  claimTxHash: string | null;
  proofJobId: string | null;
}

export interface LeaderboardPageResponse {
  success: true;
  source?: string;
  provider?: string;
  source_mode?: string;
  window: LeaderboardWindow;
  generated_at: string;
  window_range: {
    start_at: string | null;
    end_at: string | null;
  };
  pagination: {
    limit: number;
    offset: number;
    total: number;
    next_offset: number | null;
  };
  entries: LeaderboardEntry[];
  me: LeaderboardEntry | null;
  ingestion?: {
    last_synced_at: string | null;
    highest_ledger: number | null;
    total_events: number | null;
  };
}

export interface LeaderboardPlayerResponse {
  success: true;
  player: {
    claimant_address: string;
    profile: PlayerProfile | null;
    stats: {
      total_runs: number;
      best_score: number;
      total_minted: number;
      last_played_at: string | null;
    };
    ranks: {
      ten_min: number | null;
      day: number | null;
      all: number | null;
    };
    recent_runs: Array<Omit<LeaderboardEntry, "rank" | "profile">>;
    runs_pagination: {
      limit: number;
      offset: number;
      total: number;
      next_offset: number | null;
    };
  };
}

interface LeaderboardProfileAuthOptionsResponse {
  success: true;
  challenge_id: string;
  options: PublicKeyCredentialRequestOptionsJSON;
}

interface ApiErrorResponse {
  success: false;
  error?: string;
}

export class LeaderboardApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "LeaderboardApiError";
    this.status = status;
  }
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await baseFetchWithTimeout(input, init, timeoutMs);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new LeaderboardApiError("request timed out", 0);
    }
    throw error;
  }
}

async function parseError(response: Response): Promise<LeaderboardApiError> {
  let message = `request failed (${response.status})`;
  try {
    const payload = (await response.json()) as ApiErrorResponse;
    if (payload.error && payload.error.trim().length > 0) {
      message = payload.error;
    }
  } catch {
    // ignored
  }

  return new LeaderboardApiError(message, response.status);
}

export async function getLeaderboard({
  window,
  limit = 25,
  offset = 0,
  address,
}: {
  window: LeaderboardWindow;
  limit?: number;
  offset?: number;
  address?: string | null;
}): Promise<LeaderboardPageResponse> {
  const params = new URLSearchParams();
  params.set("window", window);
  params.set("limit", `${limit}`);
  params.set("offset", `${offset}`);
  if (address && address.trim().length > 0) {
    params.set("address", address.trim());
  }

  const response = await fetchWithTimeout(
    `/api/leaderboard?${params.toString()}`,
    { method: "GET" },
    10_000,
  );
  if (!response.ok) {
    throw await parseError(response);
  }

  return parseJson<LeaderboardPageResponse>(response);
}

export async function getLeaderboardPlayer(
  claimantAddress: string,
  options?: { runsLimit?: number; runsOffset?: number },
): Promise<LeaderboardPlayerResponse> {
  const params = new URLSearchParams();
  if (options?.runsLimit != null) {
    params.set("runs_limit", `${options.runsLimit}`);
  }
  if (options?.runsOffset != null) {
    params.set("runs_offset", `${options.runsOffset}`);
  }
  const qs = params.toString();
  const url = `/api/leaderboard/player/${encodeURIComponent(claimantAddress)}${qs ? `?${qs}` : ""}`;
  const response = await fetchWithTimeout(url, { method: "GET" }, 10_000);
  if (!response.ok) {
    throw await parseError(response);
  }

  return parseJson<LeaderboardPlayerResponse>(response);
}

export async function updateLeaderboardProfile(
  claimantAddress: string,
  updates: { username: string | null; linkUrl: string | null },
  credentialId: string,
): Promise<{ success: true; profile: PlayerProfile }> {
  // Step 1: Request authentication options (15s timeout for RPC latency)
  const optionsResponse = await fetchWithTimeout(
    `/api/leaderboard/player/${encodeURIComponent(claimantAddress)}/profile/auth/options`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential_id: credentialId }),
    },
    15_000,
  );
  if (!optionsResponse.ok) {
    throw await parseError(optionsResponse);
  }
  const optionsData = await parseJson<LeaderboardProfileAuthOptionsResponse>(optionsResponse);

  // Step 2: Sign with passkey via browser WebAuthn API
  const authResponse = await startAuthentication({
    optionsJSON: optionsData.options,
  });

  // Step 3: Submit profile update with WebAuthn proof
  const response = await fetchWithTimeout(
    `/api/leaderboard/player/${encodeURIComponent(claimantAddress)}/profile`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: updates.username,
        link_url: updates.linkUrl,
        auth: {
          challenge_id: optionsData.challenge_id,
          response: authResponse,
        },
      }),
    },
    10_000,
  );
  if (!response.ok) {
    throw await parseError(response);
  }

  return parseJson<{ success: true; profile: PlayerProfile }>(response);
}
