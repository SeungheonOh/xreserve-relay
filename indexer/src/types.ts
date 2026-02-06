export type RelayStatus =
  | "pending"
  | "polling"
  | "attested"
  | "submitted"
  | "confirmed"
  | "failed";

export interface RelayJob {
  txHash: string; // 0x-prefixed lowercase, PRIMARY KEY
  sourceDomain: number;

  // From Circle API (populated when attested)
  attestedMessage: string | null;
  attestation: string | null;
  irisNonce: string | null;

  // Decoded from attested message
  mintRecipient: string | null;
  destinationDomain: number | null;
  amount: string | null;

  // Ethereum submission
  ethTxHash: string | null;
  ethBlockNumber: number | null;

  // State
  status: RelayStatus;
  outcome: "forwarded" | "fallback" | "operator_routed" | null;
  error: string | null;

  // Operational
  pollAttempts: number;
  retryCount: number;

  // Timestamps (ISO strings)
  createdAt: string;
  attestedAt: string | null;
  submittedAt: string | null;
  confirmedAt: string | null;
  updatedAt: string;
}
