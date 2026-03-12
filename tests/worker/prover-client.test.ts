import { describe, expect, it } from "bun:test";
import {
  describeProverHealthError,
  summarizeProof,
  getValidatedProverHealth,
  submitToProver,
  pollProverOnce,
} from "../../worker/prover/client";
import { EXPECTED_RULES_DIGEST, EXPECTED_RULESET } from "../../worker/constants";
import type { WorkerEnv } from "../../worker/env";
import type { ProverGetJobResponse } from "../../worker/types";

const VALID_IMAGE_ID = "a".repeat(64);
const TEST_CLAIMANT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function makeEnv(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return {
    PROVER_BASE_URL: "https://prover.test",
    ...overrides,
  } as WorkerEnv;
}

function validHealthPayload() {
  return {
    status: "ok",
    image_id: VALID_IMAGE_ID,
    rules_digest: EXPECTED_RULES_DIGEST,
    ruleset: EXPECTED_RULESET,
  };
}

function validProverGetJobResponse(
  overrides: Partial<ProverGetJobResponse> = {},
): ProverGetJobResponse {
  return {
    job_id: "prover-job-1",
    status: "succeeded",
    created_at_unix_s: 1000,
    tape_size_bytes: 100,
    options: {
      max_frames: 18000,
      receipt_kind: "groth16",
      segment_limit_po2: 21,
      proof_mode: "secure",
      verify_mode: "policy",
      accelerator: "gpu",
    },
    result: {
      proof: {
        journal: {
          seed_id: 123,
          seed: 42,
          frame_count: 100,
          final_score: 1337,
          claimant: TEST_CLAIMANT,
        },
        requested_receipt_kind: "groth16",
        produced_receipt_kind: "groth16",
        stats: {
          segments: 4,
          total_cycles: 10000,
          user_cycles: 8000,
          paging_cycles: 1000,
          reserved_cycles: 1000,
        },
        receipt: {
          inner: {
            Groth16: {
              seal: Array.from({ length: 256 }, (_, index) => index & 0xff),
              verifier_parameters: [0x73c457ba, 0, 0, 0, 0, 0, 0, 0],
            },
          },
        },
      },
      elapsed_ms: 5000,
    },
    ...overrides,
  };
}

describe("prover client", () => {
  describe("describeProverHealthError", () => {
    it("extracts retryable=true from ProverHealthCheckError", async () => {
      // Trigger a real ProverHealthCheckError by calling getValidatedProverHealth
      // with a fetch that returns 500
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response("server error", { status: 500 })) as typeof fetch;
      try {
        await getValidatedProverHealth(makeEnv(), { forceRefresh: true });
      } catch (error) {
        const desc = describeProverHealthError(error);
        expect(desc.retryable).toBe(true);
        expect(desc.message).toContain("500");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("extracts retryable=false from non-retryable ProverHealthCheckError", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            status: "ok",
            image_id: "short",
            rules_digest: 1,
            ruleset: "WRONG",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch;
      try {
        await getValidatedProverHealth(makeEnv(), { forceRefresh: true });
      } catch (error) {
        const desc = describeProverHealthError(error);
        expect(desc.retryable).toBe(false);
        expect(desc.message).toContain("image_id");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("returns retryable=true for generic Error", () => {
      const desc = describeProverHealthError(new Error("network fail"));
      expect(desc.retryable).toBe(true);
      expect(desc.message).toBe("network fail");
    });
  });

  describe("summarizeProof", () => {
    it("returns ProofResultSummary for valid response", () => {
      const response = validProverGetJobResponse();
      const summary = summarizeProof(response);
      expect(summary.elapsedMs).toBe(5000);
      expect(summary.requestedReceiptKind).toBe("groth16");
      expect(summary.producedReceiptKind).toBe("groth16");
      expect(summary.journal.final_score).toBe(1337);
      expect(summary.stats.segments).toBe(4);
    });

    it("throws when result is missing", () => {
      const response = validProverGetJobResponse({ result: undefined });
      expect(() => summarizeProof(response)).toThrow("missing");
    });

    it("throws for zero final_score", () => {
      const response = validProverGetJobResponse();
      if (!response.result) {
        throw new Error("expected prover result");
      }
      response.result.proof.journal.final_score = 0;
      expect(() => summarizeProof(response)).toThrow("zero-score");
    });
  });

  describe("getValidatedProverHealth", () => {
    it("returns validated health for successful response", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(JSON.stringify(validHealthPayload()), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch;
      try {
        const result = await getValidatedProverHealth(makeEnv(), {
          forceRefresh: true,
        });
        expect(result.imageId).toBe(VALID_IMAGE_ID);
        expect(result.rulesDigest).toBe(EXPECTED_RULES_DIGEST >>> 0);
        expect(result.ruleset).toBe(EXPECTED_RULESET);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("throws when PROVER_BASE_URL is missing", async () => {
      await expect(
        getValidatedProverHealth(makeEnv({ PROVER_BASE_URL: "" }), {
          forceRefresh: true,
        }),
      ).rejects.toThrow("PROVER_BASE_URL");
    });

    it("throws retryable error for 500 response", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => new Response("error", { status: 500 })) as typeof fetch;
      try {
        await getValidatedProverHealth(makeEnv(), { forceRefresh: true });
        expect.unreachable("should have thrown");
      } catch (error) {
        const desc = describeProverHealthError(error);
        expect(desc.retryable).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("throws non-retryable for invalid image_id format", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ ...validHealthPayload(), image_id: "not-hex" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch;
      try {
        await getValidatedProverHealth(makeEnv(), { forceRefresh: true });
        expect.unreachable("should have thrown");
      } catch (error) {
        const desc = describeProverHealthError(error);
        expect(desc.retryable).toBe(false);
        expect(desc.message).toContain("image_id");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("throws non-retryable for rules digest mismatch", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ ...validHealthPayload(), rules_digest: 0xdeadbeef }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch;
      try {
        await getValidatedProverHealth(makeEnv(), { forceRefresh: true });
        expect.unreachable("should have thrown");
      } catch (error) {
        const desc = describeProverHealthError(error);
        expect(desc.retryable).toBe(false);
        expect(desc.message).toContain("rules_digest");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("throws non-retryable for ruleset mismatch", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ ...validHealthPayload(), ruleset: "WRONG" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch;
      try {
        await getValidatedProverHealth(makeEnv(), { forceRefresh: true });
        expect.unreachable("should have thrown");
      } catch (error) {
        const desc = describeProverHealthError(error);
        expect(desc.retryable).toBe(false);
        expect(desc.message).toContain("ruleset");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("throws non-retryable for image ID mismatch when PROVER_EXPECTED_IMAGE_ID is set", async () => {
      const otherImageId = "b".repeat(64);
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(JSON.stringify(validHealthPayload()), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch;
      try {
        await getValidatedProverHealth(makeEnv({ PROVER_EXPECTED_IMAGE_ID: otherImageId }), {
          forceRefresh: true,
        });
        expect.unreachable("should have thrown");
      } catch (error) {
        const desc = describeProverHealthError(error);
        expect(desc.retryable).toBe(false);
        expect(desc.message).toContain("image_id mismatch");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("submitToProver", () => {
    const tapeBytes = new Uint8Array([1, 2, 3]);

    it("returns success on successful submission", async () => {
      const originalFetch = globalThis.fetch;
      let callCount = 0;
      globalThis.fetch = (async (url: RequestInfo | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        callCount++;
        if (urlStr.includes("/health")) {
          return new Response(JSON.stringify(validHealthPayload()), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            success: true,
            job_id: "prover-job-1",
            status: "queued",
            status_url: "/api/jobs/prover-job-1",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch;
      try {
        const result = await submitToProver(makeEnv(), tapeBytes, {
          seedId: 123,
          claimantAddress: TEST_CLAIMANT,
        });
        expect(result.type).toBe("success");
        if (result.type === "success") {
          expect(result.jobId).toBe("prover-job-1");
          expect(result.statusUrl).toBe("/api/jobs/prover-job-1");
        }
        expect(callCount).toBeGreaterThan(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("returns retry for 429 response", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (url: RequestInfo | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/health")) {
          return new Response(JSON.stringify(validHealthPayload()), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ success: false, error: "rate limited" }), {
          status: 429,
        });
      }) as typeof fetch;
      try {
        const result = await submitToProver(makeEnv(), tapeBytes, {
          seedId: 123,
          claimantAddress: TEST_CLAIMANT,
        });
        expect(result.type).toBe("retry");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("returns fatal for client error", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (url: RequestInfo | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/health")) {
          return new Response(JSON.stringify(validHealthPayload()), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("bad request", { status: 400 });
      }) as typeof fetch;
      try {
        const result = await submitToProver(makeEnv(), tapeBytes, {
          seedId: 123,
          claimantAddress: TEST_CLAIMANT,
        });
        expect(result.type).toBe("fatal");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("pollProverOnce", () => {
    it("returns success for succeeded status", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(JSON.stringify(validProverGetJobResponse()), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch;
      try {
        const result = await pollProverOnce(makeEnv(), "job-1");
        expect(result.type).toBe("success");
        if (result.type === "success") {
          expect(result.summary.journal.final_score).toBe(1337);
          expect(result.artifact.version).toBe("v4");
          expect(result.artifact.backend).toBe("vast");
          expect(result.artifact.produced_receipt_kind).toBe("groth16");
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("returns retry for failed with retryable error code", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify(
            validProverGetJobResponse({
              status: "failed",
              error: "internal failure",
              error_code: "server_restarted",
            }),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch;
      try {
        const result = await pollProverOnce(makeEnv(), "job-1");
        expect(result.type).toBe("retry");
        if (result.type === "retry") {
          expect(result.clearProverJob).toBe(true);
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("returns fatal for failed with non-retryable error", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify(
            validProverGetJobResponse({
              status: "failed",
              error: "invalid tape",
              error_code: "invalid_input",
            }),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch;
      try {
        const result = await pollProverOnce(makeEnv(), "job-1");
        expect(result.type).toBe("fatal");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("returns retry with clearProverJob for 404", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;
      try {
        const result = await pollProverOnce(makeEnv(), "job-1");
        expect(result.type).toBe("retry");
        if (result.type === "retry") {
          expect(result.clearProverJob).toBe(true);
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("returns running for queued/running status", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify(validProverGetJobResponse({ status: "running", result: undefined })),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch;
      try {
        const result = await pollProverOnce(makeEnv(), "job-1");
        expect(result.type).toBe("running");
        if (result.type === "running") {
          expect(result.status).toBe("running");
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("returns retry for 500 response", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ success: false, error: "internal" }), {
          status: 500,
        })) as typeof fetch;
      try {
        const result = await pollProverOnce(makeEnv(), "job-1");
        expect(result.type).toBe("retry");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
