import Database from "better-sqlite3";
import type { RelayJob, RelayStatus } from "./types.js";

export interface Store {
  createJob(job: RelayJob): void;
  getJob(txHash: string): RelayJob | undefined;
  updateJob(txHash: string, updates: Partial<RelayJob>): void;
  getJobsByStatus(statuses: RelayStatus[], limit: number): RelayJob[];
  getOldestByStatus(status: RelayStatus): RelayJob | undefined;
  countByStatus(): Record<string, number>;
}

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS relay_jobs (
  tx_hash             TEXT PRIMARY KEY,
  source_domain       INTEGER NOT NULL,

  attested_message    TEXT,
  attestation         TEXT,
  iris_nonce          TEXT,

  mint_recipient      TEXT,
  destination_domain  INTEGER,
  amount              TEXT,

  eth_tx_hash         TEXT,
  eth_block_number    INTEGER,

  status              TEXT NOT NULL DEFAULT 'pending',
  outcome             TEXT,
  error               TEXT,
  poll_attempts       INTEGER NOT NULL DEFAULT 0,
  retry_count         INTEGER NOT NULL DEFAULT 0,

  created_at          TEXT NOT NULL,
  attested_at         TEXT,
  submitted_at        TEXT,
  confirmed_at        TEXT,
  updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_status ON relay_jobs(status);
CREATE INDEX IF NOT EXISTS idx_created_at ON relay_jobs(created_at);
`;

function rowToJob(row: Record<string, unknown>): RelayJob {
  return {
    txHash: row.tx_hash as string,
    sourceDomain: row.source_domain as number,
    attestedMessage: row.attested_message as string | null,
    attestation: row.attestation as string | null,
    irisNonce: row.iris_nonce as string | null,
    mintRecipient: row.mint_recipient as string | null,
    destinationDomain: row.destination_domain as number | null,
    amount: row.amount as string | null,
    ethTxHash: row.eth_tx_hash as string | null,
    ethBlockNumber: row.eth_block_number as number | null,
    status: row.status as RelayStatus,
    outcome: row.outcome as "forwarded" | "fallback" | "operator_routed" | null,
    error: row.error as string | null,
    pollAttempts: row.poll_attempts as number,
    retryCount: row.retry_count as number,
    createdAt: row.created_at as string,
    attestedAt: row.attested_at as string | null,
    submittedAt: row.submitted_at as string | null,
    confirmedAt: row.confirmed_at as string | null,
    updatedAt: row.updated_at as string,
  };
}

export function createStore(dbPath: string): Store {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(CREATE_TABLE);

  const insertStmt = db.prepare(`
    INSERT INTO relay_jobs (
      tx_hash, source_domain,
      attested_message, attestation, iris_nonce,
      mint_recipient, destination_domain, amount,
      eth_tx_hash, eth_block_number,
      status, outcome, error, poll_attempts, retry_count,
      created_at, attested_at, submitted_at, confirmed_at, updated_at
    ) VALUES (
      @txHash, @sourceDomain,
      @attestedMessage, @attestation, @irisNonce,
      @mintRecipient, @destinationDomain, @amount,
      @ethTxHash, @ethBlockNumber,
      @status, @outcome, @error, @pollAttempts, @retryCount,
      @createdAt, @attestedAt, @submittedAt, @confirmedAt, @updatedAt
    )
  `);

  const getStmt = db.prepare("SELECT * FROM relay_jobs WHERE tx_hash = ?");

  const countStmt = db.prepare(
    "SELECT status, COUNT(*) as cnt FROM relay_jobs GROUP BY status",
  );

  return {
    createJob(job: RelayJob): void {
      insertStmt.run({
        txHash: job.txHash,
        sourceDomain: job.sourceDomain,
        attestedMessage: job.attestedMessage,
        attestation: job.attestation,
        irisNonce: job.irisNonce,
        mintRecipient: job.mintRecipient,
        destinationDomain: job.destinationDomain,
        amount: job.amount,
        ethTxHash: job.ethTxHash,
        ethBlockNumber: job.ethBlockNumber,
        status: job.status,
        outcome: job.outcome,
        error: job.error,
        pollAttempts: job.pollAttempts,
        retryCount: job.retryCount,
        createdAt: job.createdAt,
        attestedAt: job.attestedAt,
        submittedAt: job.submittedAt,
        confirmedAt: job.confirmedAt,
        updatedAt: job.updatedAt,
      });
    },

    getJob(txHash: string): RelayJob | undefined {
      const row = getStmt.get(txHash) as Record<string, unknown> | undefined;
      return row ? rowToJob(row) : undefined;
    },

    updateJob(txHash: string, updates: Partial<RelayJob>): void {
      // Build SET clause dynamically from provided fields
      const columnMap: Record<string, string> = {
        sourceDomain: "source_domain",
        attestedMessage: "attested_message",
        attestation: "attestation",
        irisNonce: "iris_nonce",
        mintRecipient: "mint_recipient",
        destinationDomain: "destination_domain",
        amount: "amount",
        ethTxHash: "eth_tx_hash",
        ethBlockNumber: "eth_block_number",
        status: "status",
        outcome: "outcome",
        error: "error",
        pollAttempts: "poll_attempts",
        retryCount: "retry_count",
        attestedAt: "attested_at",
        submittedAt: "submitted_at",
        confirmedAt: "confirmed_at",
      };

      const sets: string[] = ["updated_at = @updated_at"];
      const params: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
        tx_hash: txHash,
      };

      for (const [key, col] of Object.entries(columnMap)) {
        if (key in updates) {
          sets.push(`${col} = @${key}`);
          params[key] = (updates as Record<string, unknown>)[key];
        }
      }

      const sql = `UPDATE relay_jobs SET ${sets.join(", ")} WHERE tx_hash = @tx_hash`;
      db.prepare(sql).run(params);
    },

    getJobsByStatus(statuses: RelayStatus[], limit: number): RelayJob[] {
      const placeholders = statuses.map(() => "?").join(", ");
      const sql = `SELECT * FROM relay_jobs WHERE status IN (${placeholders}) ORDER BY created_at ASC LIMIT ?`;
      const rows = db.prepare(sql).all(...statuses, limit) as Record<
        string,
        unknown
      >[];
      return rows.map(rowToJob);
    },

    getOldestByStatus(status: RelayStatus): RelayJob | undefined {
      const row = db
        .prepare(
          "SELECT * FROM relay_jobs WHERE status = ? ORDER BY created_at ASC LIMIT 1",
        )
        .get(status) as Record<string, unknown> | undefined;
      return row ? rowToJob(row) : undefined;
    },

    countByStatus(): Record<string, number> {
      const rows = countStmt.all() as { status: string; cnt: number }[];
      const result: Record<string, number> = {};
      for (const row of rows) {
        result[row.status] = row.cnt;
      }
      return result;
    },
  };
}
