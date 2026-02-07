import express, { type Request, type Response } from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import type { Config } from "./config.js";
import type { Store } from "./store.js";

// Known CCTP v2 source domains (excludes 0 = Ethereum, our destination)
const VALID_SOURCE_DOMAINS = new Set([
  1, 2, 3, 6, 7, 10, 11, 12, 13, 14, 15, 16, 18, 19, 21, 22,
]);

const TX_HASH_REGEX = /^0x[a-fA-F0-9]{64}$/;

export function createApiServer(config: Config, store: Store): express.Express {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.use(
    rateLimit({
      windowMs: 1000,
      limit: 10,
      standardHeaders: "draft-7",
      legacyHeaders: false,
    }),
  );

  app.post("/relay", (req: Request, res: Response) => {
    try {
      const { sourceDomain, txHash } = req.body;

      if (
        typeof sourceDomain !== "number" ||
        !VALID_SOURCE_DOMAINS.has(sourceDomain)
      ) {
        res.status(400).json({ error: "Invalid sourceDomain" });
        return;
      }

      if (typeof txHash !== "string" || !TX_HASH_REGEX.test(txHash)) {
        res.status(400).json({ error: "Invalid txHash format" });
        return;
      }

      const normalizedTxHash = txHash.toLowerCase();

      // Idempotent: return existing job if present
      const existing = store.getJob(normalizedTxHash);
      if (existing) {
        res.status(200).json({
          txHash: existing.txHash,
          status: existing.status,
          message: "Relay job already exists.",
        });
        return;
      }

      const now = new Date().toISOString();
      store.createJob({
        txHash: normalizedTxHash,
        sourceDomain,
        attestedMessage: null,
        attestation: null,
        irisNonce: null,
        mintRecipient: null,
        destinationDomain: null,
        amount: null,
        ethTxHash: null,
        ethBlockNumber: null,
        status: "pending",
        outcome: null,
        error: null,
        pollAttempts: 0,
        retryCount: 0,
        createdAt: now,
        attestedAt: null,
        submittedAt: null,
        confirmedAt: null,
        updatedAt: now,
      });

      res.status(201).json({
        txHash: normalizedTxHash,
        status: "pending",
        message: "Relay job created. Poll GET /relay/:txHash for status.",
      });
    } catch (err) {
      console.error("POST /relay error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/relay/:txHash", (req: Request, res: Response) => {
    const rawParam = req.params.txHash;
    const txHash = (Array.isArray(rawParam) ? rawParam[0] : rawParam).toLowerCase();
    const job = store.getJob(txHash);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    res.status(200).json({
      txHash: job.txHash,
      sourceDomain: job.sourceDomain,
      status: job.status,
      outcome: job.outcome,
      error: job.error,
      ethTxHash: job.ethTxHash,
      createdAt: job.createdAt,
      attestedAt: job.attestedAt,
      submittedAt: job.submittedAt,
      confirmedAt: job.confirmedAt,
    });
  });

  app.get("/health", (_req: Request, res: Response) => {
    try {
      const counts = store.countByStatus();
      res.status(200).json({
        status: "healthy",
        jobs: counts,
      });
    } catch (err) {
      console.error("GET /health error:", err);
      res.status(500).json({ status: "unhealthy" });
    }
  });

  return app;
}
