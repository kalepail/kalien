export interface PlayerScoreInfo {
  bestScore: number;
  totalRuns: number;
}

/**
 * Fetch the player's current on-chain best score from the leaderboard API.
 * Returns { bestScore: 0, totalRuns: 0 } if the API is unreachable or the player has no history.
 */
export async function fetchPlayerScore(address: string, apiUrl: string): Promise<PlayerScoreInfo> {
  try {
    const response = await fetch(`${apiUrl}/api/leaderboard/player/${address}`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return { bestScore: 0, totalRuns: 0 };
    }

    const data = (await response.json()) as {
      success: boolean;
      player?: {
        stats?: {
          best_score?: number;
          total_runs?: number;
        };
      };
    };

    if (!data.success || !data.player?.stats) {
      return { bestScore: 0, totalRuns: 0 };
    }

    return {
      bestScore: data.player.stats.best_score ?? 0,
      totalRuns: data.player.stats.total_runs ?? 0,
    };
  } catch {
    // Network error, timeout, etc. — don't block startup
    return { bestScore: 0, totalRuns: 0 };
  }
}
