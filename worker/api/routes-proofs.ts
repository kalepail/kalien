import { Hono } from "hono";
import { cache } from "hono/cache";
import { fetchBoundlessCycles } from "../boundless/sdk/client";
import { resolveBoundlessConfig } from "../boundless/config";
import { DEFAULT_MAX_TAPE_BYTES } from "../constants";
import { asPublicJob, coordinatorStub } from "../durable/coordinator";
import type { WorkerEnv } from "../env";
import { resultKey, tapeKey } from "../keys";
import { parseAndValidateTape } from "../tape";
import type { ProofJobRecord, ProverAttempt } from "../types";
import { isTerminalProofStatus, safeErrorMessage } from "../utils";
import {
  JOB_LIST_CACHE_CONTROL,
  JOB_STATUS_CACHE_CONTROL,
  JOB_STATUS_TERMINAL_CACHE_CONTROL,
  RESULT_CACHE_CONTROL,
  TAPE_CACHE_CONTROL,
} from "../cache-control";
import { validateClaimantStrKeyFromUserInput } from "../../shared/stellar/strkey";
import { computeReplayIdentity } from "../replay-hash";
import {
  hasCapacity,
  recordSubmission,
  retryAfterSeconds,
  SUBMISSION_LIMIT,
  SUBMISSION_WINDOW_MS,
} from "./rate-limit";

class PayloadTooLargeError extends Error {
  readonly sizeBytes: number;
  readonly maxBytes: number;

  constructor(sizeBytes: number, maxBytes: number) {
    super(`tape payload too large: ${sizeBytes} bytes (max ${maxBytes})`);
    this.name = "PayloadTooLargeError";
    this.sizeBytes = sizeBytes;
    this.maxBytes = maxBytes;
  }
}

function parseContentLength(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return parsed;
}

async function readRequestBodyWithLimit(
  request: Request,
  maxTapeBytes: number,
): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) {
    return new Uint8Array();
  }

  const chunks: Uint8Array[] = [];
  let totalSize = 0;

  try {
    /* eslint-disable no-await-in-loop */
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (!value || value.byteLength === 0) {
        continue;
      }

      totalSize += value.byteLength;
      if (totalSize > maxTapeBytes) {
        void reader.cancel("payload too large");
        throw new PayloadTooLargeError(totalSize, maxTapeBytes);
      }
      chunks.push(value);
    }
    /* eslint-enable no-await-in-loop */
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body;
}

function jsonError(
  c: { json: (body: unknown, status?: number) => Response },
  status: number,
  error: string,
): Response {
  return c.json(
    {
      success: false,
      error,
    },
    status,
  );
}

function clientIp(c: { req: { raw: Request } }): string {
  return c.req.raw.headers.get("cf-connecting-ip") ?? "unknown";
}

const DEFAULT_BOUNDLESS_CHAIN_ID = "8453"; // Base mainnet

function latestSuccessfulAttempt(job: ProofJobRecord): ProverAttempt | null {
  for (let i = job.proverAttempts.length - 1; i >= 0; i -= 1) {
    const attempt = job.proverAttempts[i];
    if (attempt.outcome === "success") return attempt;
  }
  return null;
}

function normalizeBoundlessRequestId(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.startsWith("boundless:")
    ? trimmed.slice("boundless:".length)
    : trimmed;
  if (!/^0x[0-9a-f]+$/i.test(normalized)) return null;
  return normalized;
}

function resolveBoundlessChainId(env: WorkerEnv): string {
  const raw = env.BOUNDLESS_CHAIN_ID?.trim();
  if (!raw) return DEFAULT_BOUNDLESS_CHAIN_ID;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_BOUNDLESS_CHAIN_ID;
  return String(parsed);
}

function normalizeCycleMetric(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
}

function withCycleStats(
  job: ProofJobRecord,
  programCycles: number | null | undefined,
  totalCycles: number | null | undefined,
): ProofJobRecord {
  const result = job.result;
  const stats = result?.summary?.stats;
  if (!result || !stats) return job;

  const normalizedTotal = normalizeCycleMetric(totalCycles);
  if (normalizedTotal == null || normalizedTotal <= 0) return job;

  const normalizedProgram = normalizeCycleMetric(programCycles);
  const nextStats = {
    ...stats,
    total_cycles: normalizedTotal,
    user_cycles: normalizedProgram ?? stats.user_cycles,
  };

  if (
    nextStats.total_cycles === stats.total_cycles &&
    nextStats.user_cycles === stats.user_cycles
  ) {
    return job;
  }

  return {
    ...job,
    result: {
      ...result,
      summary: {
        ...result.summary,
        stats: nextStats,
      },
    },
  };
}

async function enrichBoundlessCyclesForResponse(
  env: WorkerEnv,
  job: ProofJobRecord,
): Promise<ProofJobRecord> {
  if (job.status !== "succeeded") return job;
  if (!job.proverAttempts || job.proverAttempts.length === 0) return job;

  const attempt = latestSuccessfulAttempt(job);
  if (!attempt) return job;

  const isBoundlessAttempt =
    attempt.backend === "boundless" ||
    attempt.statusUrl?.startsWith("boundless:") === true ||
    job.prover.statusUrl?.startsWith("boundless:") === true;
  if (!isBoundlessAttempt) return job;

  if (attempt.totalCycles != null) {
    return withCycleStats(job, attempt.programCycles, attempt.totalCycles);
  }

  if ((job.result?.summary?.stats.total_cycles ?? 0) > 0) {
    return job;
  }

  const requestId =
    normalizeBoundlessRequestId(attempt.proverJobId) ??
    normalizeBoundlessRequestId(attempt.statusUrl) ??
    normalizeBoundlessRequestId(job.prover.jobId) ??
    normalizeBoundlessRequestId(job.prover.statusUrl);
  if (!requestId) return job;

  try {
    const chainId = resolveBoundlessChainId(env);
    const { programCycles, totalCycles } = await fetchBoundlessCycles(chainId, requestId);
    if (totalCycles == null) return job;

    const successfulIndex = job.proverAttempts.findIndex(
      (candidate) => candidate.index === attempt.index && candidate.outcome === "success",
    );
    if (successfulIndex < 0) return job;

    const updatedAttempts = [...job.proverAttempts];
    updatedAttempts[successfulIndex] = {
      ...updatedAttempts[successfulIndex],
      programCycles,
      totalCycles,
    };
    return withCycleStats(
      {
        ...job,
        proverAttempts: updatedAttempts,
      },
      programCycles,
      totalCycles,
    );
  } catch {
    return job;
  }
}

function resolveSubmissionQueue(env: WorkerEnv): {
  queue: Queue<{ jobId: string }>;
  backend: "boundless" | "vast";
} | null {
  if (resolveBoundlessConfig(env)) {
    return {
      queue: env.PROOF_QUEUE as Queue<{ jobId: string }>,
      backend: "boundless",
    };
  }

  if (env.PROVER_BASE_URL?.trim()) {
    return {
      queue: env.VAST_QUEUE as Queue<{ jobId: string }>,
      backend: "vast",
    };
  }

  return null;
}

export function createProofsRouter(): Hono<{ Bindings: WorkerEnv }> {
  const router = new Hono<{ Bindings: WorkerEnv }>();

  router.post("/jobs", async (c) => {
    const maxTapeBytes = DEFAULT_MAX_TAPE_BYTES;
    const declaredLength = parseContentLength(c.req.header("content-length"));
    if (declaredLength !== null && declaredLength > maxTapeBytes) {
      return jsonError(
        c,
        413,
        `tape payload too large: ${declaredLength} bytes (max ${maxTapeBytes})`,
      );
    }

    let tapeBytes: Uint8Array;
    try {
      tapeBytes = await readRequestBodyWithLimit(c.req.raw, maxTapeBytes);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        return jsonError(c, 413, error.message);
      }
      return jsonError(c, 400, `failed reading request body: ${safeErrorMessage(error)}`);
    }

    let metadata;
    try {
      metadata = parseAndValidateTape(tapeBytes, maxTapeBytes);
    } catch (error) {
      return jsonError(c, 400, safeErrorMessage(error));
    }
    const replayIdentity = await computeReplayIdentity(tapeBytes, maxTapeBytes, metadata);

    const rawClaimant = c.req.query("claimant") ?? "";
    let claimantAddress: string;
    try {
      claimantAddress = validateClaimantStrKeyFromUserInput(rawClaimant);
    } catch (error) {
      return jsonError(c, 400, `invalid claimant query param: ${safeErrorMessage(error)}`);
    }

    const rawSeedId = c.req.query("seed_id") ?? "";
    const parsedSeedId = Number.parseInt(rawSeedId.trim(), 10);
    if (!Number.isFinite(parsedSeedId) || parsedSeedId < 0 || parsedSeedId > 0xffff_ffff) {
      return jsonError(c, 400, "invalid seed_id query param: expected unsigned 32-bit integer");
    }
    metadata = {
      ...metadata,
      seedId: parsedSeedId >>> 0,
    };

    // Sliding-window rate limit: 10 submissions per 10 minutes, per IP and per address.
    const ipKey = `ip:${clientIp(c)}`;
    const addrKey = `addr:${claimantAddress}`;
    if (
      !hasCapacity(ipKey, SUBMISSION_LIMIT, SUBMISSION_WINDOW_MS) ||
      !hasCapacity(addrKey, SUBMISSION_LIMIT, SUBMISSION_WINDOW_MS)
    ) {
      const retryIp = retryAfterSeconds(ipKey, SUBMISSION_LIMIT, SUBMISSION_WINDOW_MS);
      const retryAddr = retryAfterSeconds(addrKey, SUBMISSION_LIMIT, SUBMISSION_WINDOW_MS);
      const retryAfter = Math.max(retryIp, retryAddr, 1);
      c.header("Retry-After", String(retryAfter));
      return jsonError(c, 429, "too many proof submissions; try again later");
    }
    recordSubmission(ipKey, SUBMISSION_WINDOW_MS);
    recordSubmission(addrKey, SUBMISSION_WINDOW_MS);

    const coordinator = coordinatorStub(c.env);
    let createResult: Awaited<ReturnType<typeof coordinator.createJob>>;
    try {
      createResult = await coordinator.createJob({
        sizeBytes: tapeBytes.byteLength,
        metadata,
        claimantAddress,
        replayHash: replayIdentity.replayHash,
      });
    } catch (error) {
      return jsonError(c, 409, safeErrorMessage(error));
    }

    const { job } = createResult;

    if (createResult.duplicate) {
      return c.json(
        {
          success: true,
          duplicate: true,
          replay_hash: replayIdentity.replayHash,
          status_url: `/api/proofs/jobs/${job.jobId}`,
          job: asPublicJob(job),
        },
        202,
      );
    }

    // Store the tape in R2 and verify it is durably readable before
    // proceeding.  A silent R2 inconsistency here caused tape loss in
    // production — the put() resolved without error but the object was
    // not readable when the queue consumer fetched it seconds later.
    const TAPE_STORE_MAX_ATTEMPTS = 3;
    const TAPE_VERIFY_DELAY_MS = 250;
    let tapeStored = false;

    for (let attempt = 1; attempt <= TAPE_STORE_MAX_ATTEMPTS; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await c.env.PROOF_ARTIFACTS.put(job.tape.key, tapeBytes, {
          httpMetadata: {
            contentType: "application/octet-stream",
          },
          customMetadata: {
            jobId: job.jobId,
          },
        });
      } catch (error) {
        if (attempt === TAPE_STORE_MAX_ATTEMPTS) {
          // eslint-disable-next-line no-await-in-loop
          await coordinator.markFailed(
            job.jobId,
            `failed storing tape in R2 after ${attempt} attempts: ${safeErrorMessage(error)}`,
          );
          return jsonError(c, 503, "failed storing tape artifact");
        }
        continue;
      }

      // Read-back verification: confirm the tape is actually retrievable.
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, TAPE_VERIFY_DELAY_MS));

      // eslint-disable-next-line no-await-in-loop
      const head = await c.env.PROOF_ARTIFACTS.head(job.tape.key);
      if (head && head.size === tapeBytes.byteLength) {
        tapeStored = true;
        break;
      }

      if (attempt === TAPE_STORE_MAX_ATTEMPTS) {
        // eslint-disable-next-line no-await-in-loop
        await coordinator.markFailed(
          job.jobId,
          `tape verification failed after ${attempt} attempts: R2 head returned ${head ? `size ${head.size}` : "null"}`,
        );
        return jsonError(c, 503, "tape storage verification failed");
      }
    }

    if (!tapeStored) {
      await coordinator.markFailed(job.jobId, "tape storage failed: exhausted all attempts");
      return jsonError(c, 503, "failed storing tape artifact");
    }

    const selectedQueue = resolveSubmissionQueue(c.env);
    if (!selectedQueue) {
      await coordinator.markFailed(job.jobId, "no prover backends configured");
      await c.env.PROOF_ARTIFACTS.delete(job.tape.key);
      return jsonError(c, 503, "no prover backends configured");
    }

    try {
      await selectedQueue.queue.send(
        {
          jobId: job.jobId,
        },
        {
          contentType: "json",
        },
      );
    } catch (error) {
      await coordinator.markFailed(
        job.jobId,
        `failed enqueueing proof job (${selectedQueue.backend}): ${safeErrorMessage(error)}`,
      );
      await c.env.PROOF_ARTIFACTS.delete(job.tape.key);
      return jsonError(c, 503, "failed enqueueing proof job");
    }

    const refreshed = await coordinator.getJob(job.jobId);
    if (!refreshed) {
      return jsonError(c, 500, "job disappeared after enqueue");
    }

    return c.json(
      {
        success: true,
        duplicate: false,
        replay_hash: replayIdentity.replayHash,
        status_url: `/api/proofs/jobs/${job.jobId}`,
        job: asPublicJob(refreshed),
      },
      202,
    );
  });

  router.get("/jobs", async (c) => {
    const rawAddress = c.req.query("address") ?? "";
    if (!rawAddress.trim()) {
      return jsonError(c, 400, "address query param required");
    }

    let claimantAddress: string;
    try {
      claimantAddress = validateClaimantStrKeyFromUserInput(rawAddress);
    } catch (error) {
      return jsonError(c, 400, `invalid address: ${safeErrorMessage(error)}`);
    }

    const limitRaw = Number.parseInt(c.req.query("limit") ?? "25", 10);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 25, 1), 100);
    const offsetRaw = Number.parseInt(c.req.query("offset") ?? "0", 10);
    const offset = Math.max(Number.isFinite(offsetRaw) ? offsetRaw : 0, 0);

    const coordinator = coordinatorStub(c.env);
    const { jobs, total } = await coordinator.listJobsForClaimant(claimantAddress, limit, offset);

    const jobsWithCycleBackfill = await Promise.all(
      jobs.map(async (job) => {
        if (job.status !== "succeeded") {
          return job;
        }

        const successfulAttempt = latestSuccessfulAttempt(job);
        if (!successfulAttempt) {
          return job;
        }

        const isBoundlessAttempt =
          successfulAttempt.backend === "boundless" ||
          successfulAttempt.statusUrl?.startsWith("boundless:") === true ||
          job.prover.statusUrl?.startsWith("boundless:") === true;
        if (!isBoundlessAttempt) {
          return job;
        }

        const hasAttemptCycles = successfulAttempt.totalCycles != null;
        const summaryMissingCycles = (job.result?.summary?.stats.total_cycles ?? 0) <= 0;
        if (hasAttemptCycles && !summaryMissingCycles) {
          return job;
        }

        try {
          const persisted = (await coordinator.enrichBoundlessCycles(
            job.jobId,
          )) as ProofJobRecord | null;
          return enrichBoundlessCyclesForResponse(c.env, persisted ?? job);
        } catch {
          // Best-effort only; never fail list reads because of enrichment.
          return enrichBoundlessCyclesForResponse(c.env, job);
        }
      }),
    );

    const nextOffset = offset + jobs.length < total ? offset + limit : null;

    c.header("Cache-Control", JOB_LIST_CACHE_CONTROL);
    return c.json({
      success: true,
      jobs: jobsWithCycleBackfill.map(asPublicJob),
      total,
      offset,
      limit,
      next_offset: nextOffset,
    });
  });

  router.get(
    "/jobs/:jobId/tape",
    cache({
      cacheName: "kalien-tape-v1",
      cacheControl: TAPE_CACHE_CONTROL,
    }),
    async (c) => {
      const jobId = c.req.param("jobId");
      if (!jobId) {
        return jsonError(c, 400, "invalid job id in path");
      }

      const coordinator = coordinatorStub(c.env);
      const job = await coordinator.getJob(jobId);
      let tape: R2ObjectBody | null = null;
      if (job?.tape.key) {
        tape = await c.env.PROOF_ARTIFACTS.get(job.tape.key);
      }
      if (!tape) {
        // Fall back to deterministic key so replay remains available even if the
        // coordinator row has been pruned or reset.
        tape = await c.env.PROOF_ARTIFACTS.get(tapeKey(jobId));
      }
      if (!tape) {
        if (!job) {
          return jsonError(c, 404, `job not found: ${jobId}`);
        }
        return jsonError(c, 404, "tape not found");
      }

      return new Response(tape.body, {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="${jobId}.tape"`,
          "cache-control": TAPE_CACHE_CONTROL,
        },
      });
    },
  );

  router.get("/jobs/:jobId", async (c) => {
    const jobId = c.req.param("jobId");
    if (!jobId) {
      return jsonError(c, 400, "invalid job id in path");
    }

    const coordinator = coordinatorStub(c.env);
    let job = (await coordinator.getJob(jobId)) as ProofJobRecord | null;
    if (!job) {
      return jsonError(c, 404, `job not found: ${jobId}`);
    }

    // Lazy backfill: if this is a succeeded Boundless job missing cycle data,
    // re-check the indexer (Bento populates cycles asynchronously).
    if (job.status === "succeeded") {
      try {
        const enriched = (await coordinator.enrichBoundlessCycles(jobId)) as ProofJobRecord | null;
        if (enriched) {
          job = enriched;
        }
      } catch {
        // Best-effort — don't fail the read if enrichment errors.
      }
      job = await enrichBoundlessCyclesForResponse(c.env, job);
    }

    // Terminal jobs never change — cache longer. In-progress jobs need fresh data.
    c.header(
      "Cache-Control",
      isTerminalProofStatus(job.status)
        ? JOB_STATUS_TERMINAL_CACHE_CONTROL
        : JOB_STATUS_CACHE_CONTROL,
    );

    return c.json({
      success: true,
      job: asPublicJob(job),
    });
  });

  // Job IDs are public capability-free identifiers, so they must never authorize
  // destructive lifecycle changes. Cancellation can be reintroduced only with
  // claimant-bound authentication or an unguessable per-job capability.
  router.delete("/jobs/:jobId", (c) => {
    c.header("Allow", "GET");
    return jsonError(c, 405, "proof jobs cannot be cancelled through the public API");
  });

  router.post("/jobs/:jobId/retry-claim", async (c) => {
    const jobId = c.req.param("jobId");
    if (!jobId) {
      return jsonError(c, 400, "invalid job id in path");
    }

    const coordinator = coordinatorStub(c.env);
    try {
      const job = await coordinator.retryFailedClaim(jobId);
      if (!job) {
        return jsonError(c, 404, `job not found: ${jobId}`);
      }
      return c.json({ success: true, job: asPublicJob(job) });
    } catch (error) {
      return jsonError(c, 409, safeErrorMessage(error));
    }
  });

  router.post("/jobs/:jobId/retry-proof", async (c) => {
    const jobId = c.req.param("jobId");
    if (!jobId) {
      return jsonError(c, 400, "invalid job id in path");
    }

    const backendRaw = (c.req.query("backend") ?? "auto").trim().toLowerCase();
    if (backendRaw !== "auto" && backendRaw !== "boundless" && backendRaw !== "vast") {
      return jsonError(c, 400, "invalid backend query param: expected auto|boundless|vast");
    }

    const coordinator = coordinatorStub(c.env);
    try {
      const job = await coordinator.retryFailedProof(
        jobId,
        backendRaw as "auto" | "boundless" | "vast",
      );
      if (!job) {
        return jsonError(c, 404, `job not found: ${jobId}`);
      }
      return c.json({ success: true, job: asPublicJob(job) });
    } catch (error) {
      return jsonError(c, 409, safeErrorMessage(error));
    }
  });

  router.get(
    "/jobs/:jobId/result",
    cache({
      cacheName: "kalien-result-v1",
      cacheControl: RESULT_CACHE_CONTROL,
    }),
    async (c) => {
      const jobId = c.req.param("jobId");
      if (!jobId) {
        return jsonError(c, 400, "invalid job id in path");
      }

      // Try the DO first for the canonical artifact key.
      const coordinator = coordinatorStub(c.env);
      const job = await coordinator.getJob(jobId);

      let artifact: R2ObjectBody | null = null;

      if (job?.result?.artifactKey) {
        artifact = await c.env.PROOF_ARTIFACTS.get(job.result.artifactKey);
      } else if (!job) {
        // DO record was pruned — fall back to the well-known R2 key.
        // result.json is retained in R2 beyond DO pruning so users can
        // fetch proof data for on-chain submission.
        artifact = await c.env.PROOF_ARTIFACTS.get(resultKey(jobId));
      }

      if (!artifact) {
        if (job && !job.result?.artifactKey) {
          return jsonError(c, 409, "proof result is not available for this job");
        }
        return jsonError(c, 404, "proof result not found");
      }

      return new Response(artifact.body, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": RESULT_CACHE_CONTROL,
        },
      });
    },
  );

  return router;
}
