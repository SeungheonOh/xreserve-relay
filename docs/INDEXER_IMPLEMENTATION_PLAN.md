# XReserve Relay Indexer — Implementation Plan

## Table of Contents

1. [Overview](#1-overview)
2. [System Architecture](#2-system-architecture)
3. [Architecture Decision Record](#3-architecture-decision-record)
4. [Circle CCTP v2 API Reference](#4-circle-cctp-v2-api-reference)
5. [HTTP API Specification](#5-http-api-specification)
6. [Event Formats](#6-event-formats)
7. [Indexer Design](#7-indexer-design)
8. [Component Specifications](#8-component-specifications)
9. [Data Model](#9-data-model)
10. [Error Handling and Edge Cases](#10-error-handling-and-edge-cases)
11. [Monitoring and Observability](#11-monitoring-and-observability)
12. [Implementation Steps](#12-implementation-steps)
13. [Deployment and Operations](#13-deployment-and-operations)

---

## 1. Overview

### Purpose

The XReserve Relay Indexer is an off-chain service that automates the relay of USDC transfers from any CCTP-supported chain through the `XReserveRouter` contract on Ethereum and onward to xReserve partner chains.

Without this indexer, a human would need to manually:
1. Obtain the attested CCTP message and attestation from Circle's Iris API
2. Submit the `receiveAndForward(message, attestation)` transaction on Ethereum

The indexer automates this by exposing an HTTP API where users or frontends submit the source chain burn transaction hash. The service then polls Circle's API for the attestation and submits the relay transaction on Ethereum.

### End-to-End Flow

```
Source Chain (Arbitrum, Base, etc.)
│
│  User calls CCTP depositForBurn() with:
│    mintRecipient = XReserveRouter address on Ethereum
│    destinationCaller = XReserveRouter address on Ethereum
│    hookData = ABI-encoded ForwardParams
│
│  → TokenMessengerV2 emits DepositForBurn event
│  → MessageTransmitterV2 emits MessageSent event
│
│  User/frontend obtains the source txHash.
│
▼
┌─────────────────────────────────────────────────────────────┐
│                    INDEXER SERVICE                           │
│                                                             │
│  1. HTTP API                                                │
│     Accepts relay requests from users/frontends:            │
│       POST /relay { sourceDomain, txHash }                  │
│     Validates the request, creates a relay job,             │
│     and returns a job ID for status tracking.               │
│                                                             │
│  2. ATTESTATION POLLER                                      │
│     Polls Circle's v2 API:                                  │
│       GET /v2/messages/{sourceDomain}?transactionHash={tx}  │
│     Waits for status = "complete" with a valid attestation. │
│     Retrieves the attested message bytes + attestation.     │
│                                                             │
│  3. ETHEREUM SUBMITTER                                      │
│     Calls XReserveRouter.receiveAndForward(message, att)    │
│     on Ethereum. Monitors for Forwarded,                    │
│     FallbackTriggered, or OperatorRouted events.            │
│                                                             │
│  4. STATE STORE                                             │
│     Persists relay state across restarts:                   │
│       pending → polling → attested → submitted → confirmed  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
│
▼
Ethereum
│
│  XReserveRouter.receiveAndForward(message, attestation)
│    → transmitter.receiveMessage() mints USDC to router
│    → try xReserve.depositToRemote() → emits Forwarded
│      catch → usdc.transfer(fallback)  → emits FallbackTriggered
│    → invalid/empty BurnMessage hookData → emits OperatorRouted
│
▼
xReserve Partner Chain
│
│  Circle's xReserve off-chain infra observes DepositedToRemote
│  → generates DepositAttestation
│  → USDCx minted to remoteRecipient
```

### Why This Architecture?

Instead of running indexers on every source chain (Arbitrum, Base, Optimism, Polygon, Avalanche, etc.), the service accepts relay requests via HTTP. This dramatically simplifies operations:

- **No source chain RPC connections** — eliminates the need for WebSocket subscriptions or polling on 10+ chains
- **No source chain synchronization state** — no block cursors, no reorg handling on source chains
- **Simpler deployment** — only needs an Ethereum RPC connection and access to Circle's API
- **Lower infrastructure cost** — no multi-chain RPC provider plans required
- **Scales naturally** — each relay request is independent; adding new source chains requires zero indexer changes

The tradeoff is that relaying is not fully automatic — a user or frontend must submit the txHash. In practice this is acceptable because:
1. The user/frontend already knows their txHash (they just submitted the burn transaction)
2. A frontend can submit to the relay API immediately after the burn tx confirms
3. The API can be called by anyone (permissionless), so third-party integrators can build their own submission flows

---

## 2. System Architecture

### 2.1 Component Diagram

```
┌──────────────────────────────────────────────────────────┐
│                     Indexer Service                       │
│                                                          │
│  ┌─────────────┐    ┌───────────────┐    ┌────────────┐ │
│  │  HTTP API   │───▶│  Attestation  │───▶│  Ethereum  │ │
│  │  Server     │    │  Poller       │    │  Submitter │ │
│  │  (Express/  │    │               │    │            │ │
│  │   Hono)     │    └───────────────┘    └────────────┘ │
│  └─────────────┘           │                    │        │
│        │                   ▼                    ▼        │
│  ┌──────────────────────────────────────────────────────┐│
│  │                   State Store                        ││
│  │  (SQLite / PostgreSQL)                               ││
│  └──────────────────────────────────────────────────────┘│
│                          │                               │
│                          ▼                               │
│                ┌──────────────────┐                      │
│                │  Health / Metrics│                      │
│                │  Endpoint        │                      │
│                └──────────────────┘                      │
└──────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
   User / Frontend       Circle Iris          Ethereum
   (submits txHash)      API                  RPC Node
```

### 2.2 Technology Choices

| Component | Recommendation | Rationale |
|-----------|---------------|-----------|
| Language | TypeScript (Node.js) | Same ecosystem as the Hardhat project. ethers.js v6 for chain interaction. |
| HTTP Framework | Express or Hono | Lightweight HTTP server for the relay API and health endpoints. |
| State Store | SQLite (single instance) or PostgreSQL (production) | Track relay state across restarts. SQLite for simplicity; Postgres for multi-instance. |
| Circle API Client | Native `fetch` | No SDK needed — simple REST polling. |
| Ethereum Signer | ethers.js `Wallet` with a private key from env/secrets manager | Submits relay transactions. Needs ETH for gas. |

### 2.3 Supported Source Chains

The HTTP API accepts requests from **any** CCTP v2 source domain. The indexer does not need per-chain configuration because it does not connect to source chains. It only needs:
1. The `sourceDomain` ID (provided by the caller)
2. The `txHash` on the source chain (provided by the caller)

Circle's Iris API handles the rest — it indexes all CCTP-supported chains and returns the attested message for any valid burn transaction.

Supported CCTP v2 source domains (for reference):

| Chain | CCTP Domain ID |
|-------|---------------|
| Ethereum | 0 |
| Avalanche | 1 |
| OP Mainnet | 2 |
| Arbitrum | 3 |
| Base | 6 |
| Polygon PoS | 7 |
| Unichain | 10 |
| Linea | 11 |
| Sonic | 13 |
| ... | ... |

No RPC connections are needed for any of these chains. When Circle adds new CCTP v2 chains, they are automatically supported — no indexer changes required.

---

## 3. Architecture Decision Record

### 3.1 Why Not Source Chain Watchers?

The original design considered running event watchers on every supported source chain (Arbitrum, Base, Optimism, Polygon, Avalanche, Unichain, Linea, Sonic, etc.) to automatically detect `DepositForBurn` events. This was rejected because:

1. **Operational complexity**: Running and maintaining WebSocket subscriptions or polling loops on 10+ chains requires per-chain RPC URLs, reconnection logic, reorg handling, and block cursor management.

2. **Cost**: Multi-chain RPC provider plans are expensive. Each source chain needs a reliable RPC endpoint.

3. **Scalability**: Every new CCTP chain would require adding configuration, RPC URLs, and potentially adjusting poll intervals.

4. **Fragility**: Any source chain RPC outage causes missed events. Recovery requires backfilling from the missed range.

The HTTP API approach eliminates all of these concerns by shifting the detection responsibility to the user/frontend, which already has the txHash immediately after submitting the burn transaction.

### 3.2 Why Not Circle's Forwarding Service?

Circle offers a [Forwarding Service](https://developers.circle.com/cctp/cctp-forwarding-service) that automatically relays CCTP messages to destination chains. However, **it does not work for our use case** because:

1. The Forwarding Service only calls `MessageTransmitterV2.receiveMessage()` on the destination chain. This mints USDC to the `mintRecipient` (our `XReserveRouter`).

2. Our router needs `receiveAndForward(message, attestation)` to be called, which:
   - Calls `receiveMessage()` internally (minting USDC to the router)
   - Then calls `xReserve.depositToRemote()` to forward the USDC onward

3. If the Forwarding Service calls `receiveMessage()` directly, the USDC would be minted to the router address but `depositToRemote()` would never be called. The USDC would be stuck in the router.

4. With the router's consumed-nonce recovery path, a subsequent call to `receiveAndForward()` can still settle that message once, as long as the message attests `mintRecipient = router` and the nonce is confirmed consumed.

**Conclusion:** The Forwarding Service is designed for simple A→B CCTP transfers, not for contracts that need deterministic post-mint logic. Our relay pattern still requires a custom submitter to drive `depositToRemote()`.

### 3.3 Rate Limit Analysis

Circle's Iris API has a rate limit of **35 requests per second** with a **5-minute lockout** on exceeding. Key findings:

- **No batch endpoint exists.** There is no way to query multiple attestations in a single request or list all pending attestations for a given `mintRecipient`. Each attestation must be polled individually by `sourceDomain` + `txHash`.

- **No webhook/push mechanism exists.** Circle does not offer webhook notifications when an attestation becomes available. Polling is the only option.

- **No listing endpoint exists.** There is no way to query "all attestations for mintRecipient X" or "all unprocessed messages destined for domain 0". Each query requires knowing the specific `sourceDomain` and `txHash`.

**Why 35 req/s is manageable for our architecture:**

At a 5-second polling interval per job, each active job consumes 0.2 req/s. The theoretical maximum concurrent polling jobs before hitting the rate limit:

```
35 req/s ÷ 0.2 req/s/job = 175 concurrent jobs
```

In practice, with a safety margin of 30 req/s:

```
30 req/s ÷ 0.2 req/s/job = 150 concurrent jobs
```

Most fast-finality messages (from L2s like Arbitrum, Base) only need 2–4 poll cycles (8–20 seconds) before the attestation is ready. So the effective throughput is much higher than 150 sustained jobs.

For our expected volume, this is more than sufficient. If volume grows significantly, the polling interval can be dynamically adjusted based on queue depth.

---

## 4. Circle CCTP v2 API Reference

### 4.1 API Hosts

| Environment | Base URL |
|-------------|----------|
| Mainnet | `https://iris-api.circle.com` |
| Testnet (Sepolia, etc.) | `https://iris-api-sandbox.circle.com` |

### 4.2 Authentication

**None required.** The CCTP Iris API is public and unauthenticated.

### 4.3 Rate Limits

- **35 requests per second** maximum
- Exceeding this triggers a **5-minute lockout** (HTTP 429)
- **Recommended polling interval: 5 seconds minimum** between requests for the same message
- Implement exponential backoff on 429 responses
- Use a global rate limiter across all polling jobs to stay under the limit

### 4.4 Primary Endpoint: Get Message + Attestation

```
GET /v2/messages/{sourceDomainId}?transactionHash={txHash}
```

**Path parameter:**
- `sourceDomainId` (integer): CCTP domain ID of the source chain (e.g., 3 for Arbitrum)

**Query parameter (at least one required):**
- `transactionHash` (string): The burn transaction hash on the source chain

**Response (200 OK):**

```json
{
  "messages": [
    {
      "message": "0x...",
      "eventNonce": "1234",
      "attestation": "0x...",
      "cctpVersion": 2,
      "status": "complete",
      "decodedMessage": {
        "sourceDomain": 3,
        "destinationDomain": 0,
        "nonce": "1234",
        "sender": "0x000...abc",
        "recipient": "0x000...def",
        "destinationCaller": "0x000...<router-bytes32>",
        "minFinalityThreshold": 1000,
        "finalityThresholdExecuted": 1000
      },
      "decodedMessageBody": {
        "burnToken": "0x...",
        "mintRecipient": "0x...",
        "amount": "1000000",
        "messageSender": "0x..."
      }
    }
  ]
}
```

**Possible states:**

| HTTP Status | `messages` | `status` | `attestation` | Meaning |
|-------------|-----------|----------|---------------|---------|
| 404 | — | — | — | Transaction not yet indexed by Iris. Keep polling. |
| 200 | `[]` | — | — | Transaction found but no CCTP messages detected. May still be processing. |
| 200 | `[...]` | `"pending_confirmations"` | `"PENDING"` | Message found, waiting for block confirmations. |
| 200 | `[...]` | `"complete"` | `"0x..."` | Attestation ready. Proceed to submit. |

**Key detail for v2:** The `message` field in the response contains the **attested message bytes** — with the `nonce`, `finalityThresholdExecuted`, `feeExecuted`, and `expirationBlock` fields filled in by Circle's attestation service. These bytes differ from the on-chain `MessageSent` event bytes (where those fields are zeroed). The attested message bytes are what must be passed to `receiveMessage()` on the destination chain.

### 4.5 Other Useful Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v2/messages/{srcDomain}?nonce={nonce}` | GET | Look up by nonce instead of txHash |
| `/v2/burn/USDC/fees/{srcDomain}/{dstDomain}` | GET | Query transfer fees between domains |
| `/v2/fastBurn/USDC/allowance` | GET | Check remaining fast transfer allowance |
| `/v2/publicKeys` | GET | Get Circle's attester public keys for verification |
| `/v2/reattest/{nonce}` | POST | Request re-attestation at higher finality |

### 4.6 Attestation Timing

Time from burn event to attestation availability:

**Fast Transfer (minFinalityThreshold = 1000):**

| Source Chain | Approx. Time |
|-------------|--------------|
| Ethereum | ~20 seconds |
| Arbitrum, Base, OP, etc. | ~8 seconds |
| Solana | ~8 seconds |

**Standard Transfer (minFinalityThreshold = 2000):**

| Source Chain | Approx. Time |
|-------------|--------------|
| Avalanche, Polygon PoS, Sonic | ~2–10 seconds |
| Arbitrum, Base, OP, etc. | ~15–19 minutes |
| Ethereum | ~15–19 minutes |
| Linea | ~6–32 hours |

### 4.7 Batch / Listing Limitations

Circle's Iris API **does not provide** any of the following:

- **Batch attestation queries** — you cannot submit multiple txHashes in a single request
- **Listing endpoints** — you cannot query "all messages for mintRecipient X" or "all pending messages destined for domain 0"
- **Webhook notifications** — there is no push mechanism to notify when an attestation becomes available
- **Subscription/streaming** — no WebSocket or SSE feed for new attestations

This means the indexer must know the specific `sourceDomain` + `txHash` for each burn it wants to relay. The HTTP API design (where users submit txHashes) is a direct consequence of this limitation.

---

## 5. HTTP API Specification

### 5.1 Submit Relay Request

```
POST /relay
Content-Type: application/json

{
  "sourceDomain": 3,
  "txHash": "0xabc123..."
}
```

**Request fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sourceDomain` | integer | Yes | CCTP domain ID of the source chain (e.g., 3 for Arbitrum, 6 for Base) |
| `txHash` | string | Yes | The burn transaction hash on the source chain (0x-prefixed, 66 chars) |

**Validation rules:**

1. `sourceDomain` must be a known CCTP v2 domain ID (see Appendix A)
2. `sourceDomain` must NOT be 0 (Ethereum is the destination, not a source)
3. `txHash` must be a valid 0x-prefixed 32-byte hex string (66 characters)
4. Duplicate check: if a job already exists for this `(sourceDomain, txHash)`, return the existing job

**Success response (201 Created):**

```json
{
  "jobId": "3-0xabc123...",
  "status": "pending",
  "message": "Relay job created. Poll GET /relay/{jobId} for status."
}
```

**Duplicate response (200 OK):**

```json
{
  "jobId": "3-0xabc123...",
  "status": "polling",
  "message": "Relay job already exists."
}
```

**Error responses:**

| HTTP Status | Body | Cause |
|-------------|------|-------|
| 400 | `{ "error": "Invalid sourceDomain" }` | Unknown domain ID or domain is 0 |
| 400 | `{ "error": "Invalid txHash format" }` | Not a valid 0x hex string |
| 500 | `{ "error": "Internal server error" }` | Database or internal failure |

### 5.2 Get Relay Job Status

```
GET /relay/{jobId}
```

**Success response (200 OK):**

```json
{
  "jobId": "3-0xabc123...",
  "sourceDomain": 3,
  "sourceTxHash": "0xabc123...",
  "status": "confirmed",
  "outcome": "forwarded",
  "ethTxHash": "0xdef456...",
  "createdAt": "2025-01-15T10:30:00Z",
  "confirmedAt": "2025-01-15T10:31:15Z"
}
```

**Status values:**

| Status | Description |
|--------|-------------|
| `pending` | Job created, not yet polled |
| `polling` | Polling Circle API for attestation |
| `attested` | Attestation received, queued for submission |
| `submitted` | Ethereum tx sent, awaiting confirmation |
| `confirmed` | Ethereum tx confirmed. Check `outcome` field. |
| `failed` | Permanently failed (timeout, max retries, etc.). Check `error` field. |

**Outcome values (only set when `status` = `confirmed`):**

| Outcome | Description |
|---------|-------------|
| `forwarded` | USDC successfully forwarded to xReserve (`Forwarded` event emitted) |
| `fallback` | xReserve deposit failed; USDC sent to fallback address (`FallbackTriggered` event emitted) |
| `operator_routed` | BurnMessage hookData empty/malformed; USDC sent to operator wallet (`OperatorRouted` event emitted) |

**Error response:**

| HTTP Status | Body | Cause |
|-------------|------|-------|
| 404 | `{ "error": "Job not found" }` | No job with that ID |

### 5.3 List Relay Jobs (Optional)

```
GET /relay?status={status}&limit={limit}&offset={offset}
```

Returns a paginated list of relay jobs, optionally filtered by status. Useful for dashboards and debugging.

**Query parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `status` | string | (all) | Filter by status |
| `limit` | integer | 50 | Max results (1–100) |
| `offset` | integer | 0 | Pagination offset |

**Response (200 OK):**

```json
{
  "jobs": [
    {
      "jobId": "3-0xabc123...",
      "sourceDomain": 3,
      "status": "confirmed",
      "outcome": "forwarded",
      "createdAt": "2025-01-15T10:30:00Z"
    }
  ],
  "total": 1234,
  "limit": 50,
  "offset": 0
}
```

---

## 6. Event Formats

### 6.1 Source Chain: `DepositForBurn` (TokenMessengerV2)

This event is emitted on the source chain when a user burns USDC for cross-chain transfer. The indexer does **not** watch for this event (the user/frontend provides the txHash instead), but its format is documented here for reference and for validation purposes.

```solidity
event DepositForBurn(
    address indexed burnToken,                  // topic1
    uint256 amount,                             // data
    address indexed depositor,                  // topic2
    bytes32 mintRecipient,                      // data
    uint32  destinationDomain,                  // data
    bytes32 destinationTokenMessenger,          // data
    bytes32 destinationCaller,                  // data
    uint256 maxFee,                             // data
    uint32  indexed minFinalityThreshold,       // topic3
    bytes   hookData                            // data
);
```

**Topic0:**
```
keccak256("DepositForBurn(address,uint256,address,bytes32,uint32,bytes32,bytes32,uint256,uint32,bytes)")
```

**Key fields for our use case:**
- `mintRecipient` — should be `bytes32(uint256(uint160(routerAddress)))` (our XReserveRouter on Ethereum)
- `destinationDomain` — should be `0` (Ethereum)
- `destinationCaller` — should be `bytes32(uint256(uint160(routerAddress)))` for production burns
- `hookData` — should contain ABI-encoded `ForwardParams` struct

### 6.2 Source Chain: `MessageSent` (MessageTransmitterV2)

```solidity
event MessageSent(bytes message);
```

**Topic0:** `0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036`

This event contains the raw message bytes. The indexer does NOT need this event — Circle's v2 API returns the attested message bytes directly.

**Important v2 detail:** The `nonce` and `finalityThresholdExecuted` in the on-chain `MessageSent` bytes are **zeroed**. Circle's attestation service fills them off-chain. The `message` returned by the v2 API is the **attested** version with these fields populated — this is what you pass to `receiveMessage()`.

### 6.3 Ethereum (Destination): Router Events

These events are emitted by the `XReserveRouter` contract on Ethereum after `receiveAndForward` executes:

```solidity
// Success: USDC forwarded to xReserve
event Forwarded(
    uint32  indexed remoteDomain,       // topic1
    bytes32 indexed remoteRecipient,    // topic2
    uint256 amount                      // data
);

// Failure: USDC sent to fallback address
event FallbackTriggered(
    address indexed fallbackRecipient,  // topic1
    uint256 amount                      // data
);

// Recovery: nonce already consumed externally, message settled from router balance
event RecoveredFromConsumedNonce(
    bytes32 indexed nonce,              // topic1
    uint256 amount                      // data
);

// Policy route: BurnMessage hookData empty/malformed, send USDC to operator wallet
event OperatorRouted(
    bytes32 indexed transferId,         // topic1
    bytes32 indexed nonce,              // topic2
    uint256 amount,                     // data
    uint8 reason                        // data (1=empty hookData, 2=malformed hookData)
);
```

The Ethereum Submitter watches for these events in the transaction receipt to determine the relay outcome.

### 6.4 Ethereum: `MessageReceived` (MessageTransmitterV2)

Emitted on Ethereum when `receiveMessage` succeeds:

```solidity
event MessageReceived(
    address indexed caller,                      // topic1: the address that called receiveMessage
    uint32  sourceDomain,                        // data
    bytes32 indexed nonce,                       // topic2
    bytes32 sender,                              // data
    uint32  indexed finalityThresholdExecuted,   // topic3
    bytes   messageBody                          // data
);
```

This confirms the CCTP message was consumed. The indexer can optionally watch this for additional confirmation.

---

## 7. Indexer Design

### 7.1 State Machine

Each relay job transitions through these states:

```
         HTTP POST /relay
               │
               ▼
┌──────────────┐    ┌───────────┐    ┌──────────┐    ┌────────────┐
│   PENDING    │───▶│  POLLING  │───▶│ ATTESTED │───▶│ SUBMITTED  │
│              │    │           │    │          │    │            │
│ Job created  │    │ Waiting   │    │ Got msg  │    │ Tx sent to │
│ via API      │    │ for Iris  │    │ + sig    │    │ Ethereum   │
│              │    │ API       │    │ from API │    │            │
└──────────────┘    └───────────┘    └──────────┘    └────────────┘
                         │                                  │
                         │ (timeout/error)                  │
                         ▼                                  ▼
                    ┌──────────┐                     ┌────────────┐
                    │  FAILED  │                     │ CONFIRMED  │
                    │          │                     │            │
                    │ Max      │                     │ Forwarded  │
                    │ retries  │                     │ or Fallback│
                    │ exceeded │                     │ event seen │
                    └──────────┘                     └────────────┘
```

**Entry point:** An HTTP `POST /relay` request creates a job in the `PENDING` state. The attestation poller picks it up immediately.

### 7.2 Relay Job Data

For each relay request, the indexer tracks:

```typescript
interface RelayJob {
  // Identity
  id: string;                        // Unique ID: "{sourceDomain}-{txHash}"
  sourceDomain: number;              // CCTP domain ID of source chain
  sourceTxHash: string;              // Burn transaction hash on source chain

  // From Circle API (populated when attested)
  attestedMessage: string | null;    // Attested message bytes from v2 API
  attestation: string | null;        // Attestation signatures from v2 API
  irisNonce: string | null;          // Nonce assigned by Iris

  // Decoded from attested message (populated when attested)
  mintRecipient: string | null;      // XReserveRouter address (should match our router)
  destinationDomain: number | null;  // Should be 0 (Ethereum)
  amount: string | null;             // Amount burned (uint256 as string)

  // Ethereum submission
  ethTxHash: string | null;          // Transaction hash of receiveAndForward call
  ethBlockNumber: number | null;     // Block number of the Ethereum tx

  // Outcome
  status: RelayStatus;
  outcome: "forwarded" | "fallback" | null;
  error: string | null;

  // Operational
  pollAttempts: number;              // Number of times we polled Iris
  retryCount: number;                // Number of Ethereum submission retries

  // Timestamps
  createdAt: Date;
  attestedAt: Date | null;
  submittedAt: Date | null;
  confirmedAt: Date | null;
  updatedAt: Date;
}

type RelayStatus =
  | "pending"
  | "polling"
  | "attested"
  | "submitted"
  | "confirmed"
  | "failed";
```

### 7.3 Concurrency Model

```
Main Process
├── HTTP API Server (Express/Hono)
│   └── POST /relay   → Creates PENDING jobs in state store
│       GET /relay/:id → Reads job status from state store
│       GET /health    → Returns service health
│
├── Attestation Poller (single loop)
│   └── Picks up PENDING/POLLING jobs
│       Polls Circle API for each (respects rate limit)
│       Updates to ATTESTED when ready
│
└── Ethereum Submitter (single loop, sequential)
    └── Picks up ATTESTED jobs
        Submits receiveAndForward tx
        Waits for confirmation
        Updates to SUBMITTED → CONFIRMED
```

All three components run concurrently in the same Node.js process:
- The HTTP server handles incoming requests asynchronously
- The attestation poller runs on a timer (e.g., every 2 seconds), processing the next batch of pending jobs
- The Ethereum submitter runs sequentially (one tx at a time) to avoid nonce management complexity

---

## 8. Component Specifications

### 8.1 HTTP API Server

**Responsibility:** Accept relay requests from users/frontends, create relay jobs, and serve job status.

```typescript
import express from "express";

const app = express();
app.use(express.json());

// Known CCTP v2 source domains (excludes 0 = Ethereum, our destination)
const VALID_SOURCE_DOMAINS = new Set([1, 2, 3, 6, 7, 10, 11, 12, 13, 14, 15, 16, 18, 19, 21, 22]);

const TX_HASH_REGEX = /^0x[a-fA-F0-9]{64}$/;

app.post("/relay", async (req, res) => {
  const { sourceDomain, txHash } = req.body;

  // Validate sourceDomain
  if (typeof sourceDomain !== "number" || !VALID_SOURCE_DOMAINS.has(sourceDomain)) {
    return res.status(400).json({ error: "Invalid sourceDomain" });
  }

  // Validate txHash
  if (typeof txHash !== "string" || !TX_HASH_REGEX.test(txHash)) {
    return res.status(400).json({ error: "Invalid txHash format" });
  }

  const normalizedTxHash = txHash.toLowerCase();
  const jobId = `${sourceDomain}-${normalizedTxHash}`;

  // Check for existing job (idempotent)
  const existing = await store.getJob(jobId);
  if (existing) {
    return res.status(200).json({
      jobId: existing.id,
      status: existing.status,
      message: "Relay job already exists.",
    });
  }

  // Create new job
  const job: RelayJob = {
    id: jobId,
    sourceDomain,
    sourceTxHash: normalizedTxHash,
    status: "pending",
    pollAttempts: 0,
    retryCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    // ... null for all optional fields
  };

  await store.createJob(job);

  return res.status(201).json({
    jobId: job.id,
    status: job.status,
    message: "Relay job created. Poll GET /relay/{jobId} for status.",
  });
});

app.get("/relay/:jobId", async (req, res) => {
  const job = await store.getJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }

  return res.status(200).json({
    jobId: job.id,
    sourceDomain: job.sourceDomain,
    sourceTxHash: job.sourceTxHash,
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
```

**Rate limiting the API itself:**

To prevent abuse, apply basic rate limiting on the HTTP API:
- 10 requests per second per IP
- 100 requests per minute per IP
- Use `express-rate-limit` or equivalent

### 8.2 Attestation Poller

**Responsibility:** Poll Circle's v2 API until the attestation is ready for each pending relay job.

```typescript
async function pollForAttestation(job: RelayJob): Promise<{
  message: string;
  attestation: string;
  nonce: string;
}> {
  const baseUrl = IS_TESTNET
    ? "https://iris-api-sandbox.circle.com"
    : "https://iris-api.circle.com";

  const url = `${baseUrl}/v2/messages/${job.sourceDomain}?transactionHash=${job.sourceTxHash}`;

  const response = await rateLimitedFetch(url);

  // 404 = not yet indexed
  if (response.status === 404) {
    return null; // Will retry on next poll cycle
  }

  // 429 = rate limited
  if (response.status === 429) {
    console.warn("Rate limited by Circle API, backing off");
    throw new RateLimitError();
  }

  if (!response.ok) {
    console.error(`Iris API error: ${response.status}`);
    return null; // Will retry on next poll cycle
  }

  const data = await response.json();

  if (!data.messages || data.messages.length === 0) {
    return null; // No messages yet
  }

  const msg = data.messages[0];

  if (msg.status === "complete" && msg.attestation !== "PENDING") {
    return {
      message: msg.message,
      attestation: msg.attestation,
      nonce: msg.eventNonce,
    };
  }

  // Still pending
  return null;
}
```

**Main poller loop:**

```typescript
async function runPollerLoop() {
  while (true) {
    // Get all pending/polling jobs, oldest first
    const jobs = await store.getJobsByStatus(["pending", "polling"], 20);

    for (const job of jobs) {
      // Check timeout
      const elapsed = Date.now() - job.createdAt.getTime();
      if (elapsed > ATTESTATION_TIMEOUT_MS) {
        await store.updateJob(job.id, {
          status: "failed",
          error: "attestation_timeout",
        });
        continue;
      }

      // Update to polling if still pending
      if (job.status === "pending") {
        await store.updateJob(job.id, { status: "polling" });
      }

      try {
        const result = await pollForAttestation(job);

        if (result) {
          // Validate that the attested message is destined for our router
          const validation = validateAttestedMessage(result.message);

          if (!validation.valid) {
            await store.updateJob(job.id, {
              status: "failed",
              error: validation.reason,
            });
            continue;
          }

          await store.updateJob(job.id, {
            status: "attested",
            attestedMessage: result.message,
            attestation: result.attestation,
            irisNonce: result.nonce,
            mintRecipient: validation.mintRecipient,
            destinationDomain: validation.destinationDomain,
            amount: validation.amount,
            attestedAt: new Date(),
            pollAttempts: job.pollAttempts + 1,
          });
        } else {
          await store.updateJob(job.id, {
            pollAttempts: job.pollAttempts + 1,
          });
        }
      } catch (err) {
        if (err instanceof RateLimitError) {
          // Back off globally
          await sleep(60_000);
          break; // Exit inner loop to let the outer loop handle timing
        }
        console.error(`Poller error for job ${job.id}:`, err);
      }
    }

    await sleep(POLL_CYCLE_INTERVAL_MS); // e.g., 2000ms
  }
}
```

**Attested message validation:**

When the attestation comes back, decode the message to verify it's destined for our router:

```typescript
function validateAttestedMessage(messageHex: string): {
  valid: boolean;
  reason?: string;
  mintRecipient?: string;
  destinationDomain?: number;
  amount?: string;
} {
  const message = ethers.getBytes(messageHex);

  // MessageV2 header: 148 bytes minimum
  if (message.length < 376) {
    return { valid: false, reason: "message too short" };
  }

  // Destination domain at offset 8 (uint32)
  const destinationDomain = new DataView(message.buffer, message.byteOffset + 8, 4).getUint32(0);
  if (destinationDomain !== 0) {
    return { valid: false, reason: `destination domain ${destinationDomain} != 0 (Ethereum)` };
  }

  // mintRecipient in BurnMessageV2 body at absolute offset 184 (bytes32)
  const mintRecipientBytes32 = ethers.hexlify(message.slice(184, 216));
  const mintRecipient = ethers.getAddress("0x" + mintRecipientBytes32.slice(-40));

  if (mintRecipient.toLowerCase() !== ROUTER_ADDRESS.toLowerCase()) {
    return { valid: false, reason: `mintRecipient ${mintRecipient} != router ${ROUTER_ADDRESS}` };
  }

  // Amount at absolute offset 216 (uint256)
  const amount = ethers.toBigInt(message.slice(216, 248)).toString();

  return {
    valid: true,
    mintRecipient,
    destinationDomain,
    amount,
  };
}
```

**Important details:**

1. The `message` returned by the v2 API is the **attested version** with `nonce`, `finalityThresholdExecuted`, `feeExecuted`, and `expirationBlock` filled in. This is different from the on-chain `MessageSent` bytes (where those fields are zero).

2. The indexer does NOT need to read events from the source chain. The API returns the complete attested message bytes ready to submit.

3. If a single source tx contains multiple CCTP messages, the API returns them as an array. For simplicity, we process the first message. If batch relay support is needed, create one job per message.

**Rate limit management:**

```typescript
// Global rate limiter for Iris API
class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per second

  constructor(maxTokens: number, refillRate: number) {
    this.tokens = maxTokens;
    this.maxTokens = maxTokens;
    this.refillRate = refillRate;
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens < 1) {
      const waitMs = (1 / this.refillRate) * 1000;
      await sleep(waitMs);
      this.refill();
    }
    this.tokens -= 1;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

// Stay under 35 req/s with safety margin
const irisRateLimiter = new TokenBucket(30, 30);

async function rateLimitedFetch(url: string): Promise<Response> {
  await irisRateLimiter.acquire();
  return fetch(url);
}
```

### 8.3 Ethereum Submitter

**Responsibility:** Submit `receiveAndForward(message, attestation)` on Ethereum and confirm the outcome.

```typescript
async function submitRelay(job: RelayJob): Promise<void> {
  const router = new ethers.Contract(
    ROUTER_ADDRESS,
    ROUTER_ABI,
    ethereumWallet
  );

  // Estimate gas first to catch reverts early
  let gasEstimate: bigint;
  try {
    gasEstimate = await router.receiveAndForward.estimateGas(
      job.attestedMessage,
      job.attestation
    );
  } catch (err) {
    // If estimateGas reverts, the tx will definitely fail.
    // Likely reasons: nonce already used, message expired.
    throw new Error(`Gas estimation failed: ${err.message}`);
  }

  // Submit with a gas buffer
  const tx = await router.receiveAndForward(
    job.attestedMessage,
    job.attestation,
    {
      gasLimit: (gasEstimate * 120n) / 100n, // 20% buffer
    }
  );

  await store.updateJob(job.id, {
    ethTxHash: tx.hash,
    status: "submitted",
    submittedAt: new Date(),
  });

  // Wait for confirmation
  const receipt = await tx.wait(1); // 1 confirmation

  if (receipt.status === 0) {
    throw new Error(`Tx reverted: ${tx.hash}`);
  }

  // Parse events from receipt
  const forwardedLog = receipt.logs.find(
    (log) => log.topics[0] === FORWARDED_TOPIC0
  );
  const fallbackLog = receipt.logs.find(
    (log) => log.topics[0] === FALLBACK_TRIGGERED_TOPIC0
  );

  let outcome: "forwarded" | "fallback" | null = null;
  if (forwardedLog) {
    outcome = "forwarded";
  } else if (fallbackLog) {
    outcome = "fallback";
  }

  await store.updateJob(job.id, {
    ethBlockNumber: receipt.blockNumber,
    confirmedAt: new Date(),
    outcome,
    status: "confirmed",
  });
}
```

**Main submitter loop:**

```typescript
async function runSubmitterLoop() {
  while (true) {
    const job = await store.getOldestJobByStatus("attested");

    if (!job) {
      await sleep(SUBMITTER_POLL_INTERVAL_MS); // e.g., 2000ms
      continue;
    }

    try {
      await submitRelay(job);
      console.log(`Relay confirmed: ${job.id} → ${job.outcome}`);
    } catch (err) {
      console.error(`Submission failed for ${job.id}:`, err);

      job.retryCount += 1;
      if (job.retryCount >= MAX_RETRIES) {
        await store.updateJob(job.id, {
          status: "failed",
          error: err.message,
          retryCount: job.retryCount,
        });
      } else {
        // Reset to attested for retry
        await store.updateJob(job.id, {
          status: "attested",
          error: err.message,
          retryCount: job.retryCount,
        });
      }
    }

    // Small delay between submissions
    await sleep(1000);
  }
}
```

**Gas price strategy:**

For timely relay, use EIP-1559 with a reasonable priority fee:

```typescript
const feeData = await provider.getFeeData();
const txOverrides = {
  maxFeePerGas: feeData.maxFeePerGas * 2n, // willing to pay up to 2x current
  maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
  gasLimit,
};
```

**Nonce management:**

With sequential submission (one tx at a time), ethers.js handles nonces automatically. If throughput demands it, a nonce manager can be added later:

```typescript
import { NonceManager } from "ethers";
const managedWallet = new NonceManager(wallet);
```

### 8.4 Duplicate Detection

Before creating a relay job, the HTTP API checks for an existing job with the same `(sourceDomain, txHash)` composite key. If found, it returns the existing job (idempotent).

Before submitting to Ethereum, the submitter can optionally check if the CCTP nonce has already been used:

```typescript
// Optional: check if nonce is already consumed on Ethereum
// MessageTransmitterV2 has usedNonces(bytes32) → uint256 (0 unused, 1 used)
const transmitter = new ethers.Contract(
  TRANSMITTER_ADDRESS,
  ["function usedNonces(bytes32) view returns (uint256)"],
  provider
);
```

In practice, gas estimation (`estimateGas`) catches nonce reuse reverts cheaply before submitting a transaction. If nonce is already used, the router's recovery path can still settle exactly once.

---

## 9. Data Model

### 9.1 SQLite Schema

```sql
CREATE TABLE relay_jobs (
  id              TEXT PRIMARY KEY,       -- "{sourceDomain}-{txHash}"
  source_domain   INTEGER NOT NULL,
  source_tx_hash  TEXT NOT NULL,

  -- From Circle API
  attested_message TEXT,
  attestation      TEXT,
  iris_nonce       TEXT,

  -- Decoded from attested message
  mint_recipient  TEXT,
  destination_domain INTEGER,
  amount          TEXT,                   -- stored as string (uint256)

  -- Ethereum submission
  eth_tx_hash     TEXT,
  eth_block       INTEGER,

  -- State
  status          TEXT NOT NULL DEFAULT 'pending',
  outcome         TEXT,                   -- 'forwarded' | 'fallback' | null
  error           TEXT,
  poll_attempts   INTEGER NOT NULL DEFAULT 0,
  retry_count     INTEGER NOT NULL DEFAULT 0,

  -- Timestamps
  created_at      TEXT NOT NULL,
  attested_at     TEXT,
  submitted_at    TEXT,
  confirmed_at    TEXT,
  updated_at      TEXT NOT NULL,

  UNIQUE(source_domain, source_tx_hash)
);

CREATE INDEX idx_status ON relay_jobs(status);
CREATE INDEX idx_created_at ON relay_jobs(created_at);
```

Note: There is no `chain_cursors` table because the indexer does not track source chain block positions. Job creation is driven by the HTTP API, not by chain scanning.

### 9.2 Queries Used by Each Component

```sql
-- HTTP API: check for existing job
SELECT * FROM relay_jobs WHERE id = ?;

-- HTTP API: create new job
INSERT INTO relay_jobs (id, source_domain, source_tx_hash, status, created_at, updated_at)
VALUES (?, ?, ?, 'pending', ?, ?);

-- HTTP API: list jobs with optional status filter
SELECT * FROM relay_jobs
WHERE (? IS NULL OR status = ?)
ORDER BY created_at DESC
LIMIT ? OFFSET ?;

-- Attestation Poller: get jobs needing attestation
SELECT * FROM relay_jobs
WHERE status IN ('pending', 'polling')
ORDER BY created_at ASC
LIMIT 20;

-- Ethereum Submitter: get oldest job ready to submit
SELECT * FROM relay_jobs
WHERE status = 'attested'
ORDER BY created_at ASC
LIMIT 1;

-- Monitoring: count by status
SELECT status, COUNT(*) FROM relay_jobs GROUP BY status;
```

---

## 10. Error Handling and Edge Cases

### 10.1 Attestation Never Arrives

**Cause:** Iris may be delayed, the source chain may be experiencing issues, or the burn transaction may have been reorged out.

**Handling:**
- After 30 minutes of polling (configurable via `ATTESTATION_TIMEOUT_MS`), mark the job as `failed` with reason `"attestation_timeout"`.
- The user can re-submit the same `(sourceDomain, txHash)` after the failed job is cleaned up, or check the source chain to confirm the burn transaction still exists.
- Alert the operator if many jobs are timing out (indicates systemic issue).

### 10.2 Invalid Relay Request

**Cause:** User submits a txHash that doesn't correspond to a CCTP burn destined for our router.

**Handling:**
- The attestation poller will eventually get a response from Circle's API.
- If the API returns a message where `mintRecipient` != our router or `destinationDomain` != 0, mark as `failed` with reason explaining the mismatch.
- If the API returns an empty response or 404 indefinitely, the timeout mechanism (10.1) handles it.

### 10.3 Ethereum Transaction Reverts

**Possible causes:**
- CCTP nonce already used (someone else relayed the message)
- Message expired (`expirationBlock` passed)
- Gas estimation succeeded but tx reverted due to state change between estimate and submission

**Handling:**
- Check the revert reason. If nonce is used, mark as `confirmed` with a note (already relayed by someone else).
- If expired, mark as `failed` with reason `"message_expired"`.
- For unknown reverts, retry up to 3 times with increasing gas.

### 10.4 Duplicate Relay Attempts

**Cause:** Multiple users submit the same txHash, or a user re-submits after a timeout.

**Handling:**
- The HTTP API returns the existing job for duplicate `(sourceDomain, txHash)` requests (idempotent).
- The CCTP nonce mechanism prevents double-minting on Ethereum. `receiveMessage` reverts if the nonce is already used.
- Gas estimation catches this cheaply before submitting.

### 10.5 Circle API Returns Multiple Messages per Transaction

**Cause:** A single transaction can contain multiple CCTP burns (e.g., a batch contract).

**Handling:**
- The API returns messages ordered by ascending log index.
- For the initial implementation, process the first message only.
- If batch support is needed, the user should submit one relay request per CCTP message, potentially with a `logIndex` parameter added to the API.

### 10.6 Relayer Wallet Runs Out of ETH

**Handling:**
- Monitor the wallet's ETH balance.
- Alert when balance drops below a threshold (e.g., 0.1 ETH).
- Pause the Ethereum Submitter if balance is too low to cover gas.
- Auto-resume when balance is replenished.
- Jobs accumulate in `attested` state while paused — no data loss.

### 10.7 Router `FallbackTriggered` Outcome

**Cause:** `xReserve.depositToRemote()` reverted (e.g., xReserve domain paused, token not supported, recipient blocklisted).

**Handling:**
- This is NOT an error from the relayer's perspective — the relay succeeded, the USDC was delivered to the fallback address.
- Log the outcome as `"fallback"` and alert the operator.
- The user received their USDC at their specified fallback address on Ethereum.

### 10.8 Router `OperatorRouted` Outcome

**Cause:** BurnMessage hookData is empty (`0x`) or malformed (cannot decode `ForwardParams`).

**Handling:**
- Treat this as a successful terminal relay outcome.
- Log outcome as `"operator_routed"` and include reason code.
- Alert operators for manual review/reconciliation workflows.

### 10.9 Source Transaction Reorg

**Cause:** A block reorganization on the source chain removes the burn transaction.

**Handling:**
- Circle's Iris API handles this naturally — it won't attest until sufficient confirmations on the source chain.
- If the burn is reorged out, the Iris API will never return an attestation for it, and the job will timeout (10.1).
- The user's funds are safe on the source chain in this case (burn never happened).

---

## 11. Monitoring and Observability

### 11.1 Metrics to Track

| Metric | Type | Description |
|--------|------|-------------|
| `relay_jobs_total` | Counter | Total relay jobs created, by source_domain |
| `relay_jobs_by_status` | Gauge | Current count per status |
| `relay_latency_seconds` | Histogram | Time from creation to confirmation |
| `attestation_poll_seconds` | Histogram | Time spent waiting for attestation |
| `eth_submission_gas_used` | Histogram | Gas used per relay tx |
| `eth_submission_failures` | Counter | Failed Ethereum submissions |
| `fallback_triggered_total` | Counter | Relays that hit fallback path |
| `relayer_eth_balance` | Gauge | ETH balance of the relayer wallet |
| `iris_api_requests` | Counter | Circle API requests by status code |
| `iris_api_rate_limited` | Counter | Number of 429 responses from Circle API |
| `api_requests_total` | Counter | HTTP API requests by endpoint and status code |

### 11.2 Alerting Conditions

| Condition | Severity | Action |
|-----------|----------|--------|
| Job stuck in `polling` > 30 min | Warning | Check Circle API / source chain |
| Job stuck in `attested` > 5 min | Critical | Ethereum submitter may be down |
| Relayer ETH balance < 0.1 ETH | Critical | Replenish immediately |
| Fallback triggered | Warning | Investigate xReserve issue |
| Circle API returning 429 | Warning | Reduce polling frequency |
| Multiple jobs failing with same error | Critical | Systemic issue — investigate |

### 11.3 Health Check Endpoint

```
GET /health

{
  "status": "healthy",
  "components": {
    "httpApi": {
      "status": "ok"
    },
    "attestationPoller": {
      "status": "ok",
      "pendingJobs": 3,
      "pollingJobs": 5,
      "oldestPendingAge": "12s"
    },
    "ethereumSubmitter": {
      "status": "ok",
      "attestedJobs": 1,
      "walletBalance": "0.45 ETH",
      "lastSubmission": "2025-01-15T10:30:00Z"
    }
  },
  "stats": {
    "totalRelayed": 1234,
    "last24h": 45,
    "fallbackRate": "2.1%"
  }
}
```

---

## 12. Implementation Steps

### Step 1: Project Scaffold

Create the indexer as a separate package within the monorepo:

```
xreserve-relay/
├── contracts/        ← existing Solidity
├── test/             ← existing contract tests
├── indexer/          ← new off-chain indexer
│   ├── src/
│   │   ├── index.ts           ← entry point
│   │   ├── config.ts          ← configuration / env vars
│   │   ├── api.ts             ← HTTP API server (Express/Hono)
│   │   ├── poller.ts          ← Attestation poller
│   │   ├── submitter.ts       ← Ethereum submitter
│   │   ├── store.ts           ← State store (SQLite)
│   │   ├── types.ts           ← TypeScript types (RelayJob, etc.)
│   │   ├── abis.ts            ← Contract ABIs
│   │   └── ratelimit.ts       ← Token bucket rate limiter
│   ├── package.json
│   └── tsconfig.json
└── docs/
```

**Dependencies:**
- `ethers` (v6) — Ethereum interaction
- `better-sqlite3` — state store
- `express` or `hono` — HTTP API server
- `express-rate-limit` — API rate limiting (if using Express)

### Step 2: Configuration Module (`config.ts`)

Define all configuration from environment variables:

```typescript
interface Config {
  // Environment
  isTestnet: boolean;

  // Circle API
  irisApiBaseUrl: string;        // https://iris-api.circle.com or sandbox

  // Router contract
  routerAddress: string;         // XReserveRouter on Ethereum
  routerBytes32: string;         // bytes32(uint256(uint160(routerAddress)))

  // Ethereum (destination)
  ethereumRpcUrl: string;
  relayerPrivateKey: string;     // wallet that submits txs + pays gas
  transmitterAddress: string;    // MessageTransmitterV2 on Ethereum

  // HTTP API
  apiPort: number;               // 3000
  apiRateLimitPerSecond: number; // 10

  // Attestation poller
  pollCycleIntervalMs: number;   // 2000
  attestationTimeoutMs: number;  // 1800000 (30 min)
  irisMaxRequestsPerSecond: number; // 30

  // Ethereum submitter
  maxRetries: number;            // 3
  submitterPollIntervalMs: number; // 2000

  // State store
  dbPath: string;                // ./data/relay.db
}
```

Note the absence of any source chain RPC URLs. The only chain connection needed is Ethereum (the destination).

### Step 3: State Store (`store.ts`)

Implement the SQLite-based state store with the schema from Section 9.

Key operations:
- `createJob(job)` — insert new relay job
- `getJob(id)` — fetch by ID
- `updateJob(id, updates)` — partial update
- `getJobsByStatus(statuses, limit)` — for poller and submitter
- `getOldestJobByStatus(status)` — for submitter (single oldest job)
- `countByStatus()` — for monitoring

### Step 4: HTTP API Server (`api.ts`)

Implement the API endpoints from Section 5:
1. `POST /relay` — create relay job
2. `GET /relay/:jobId` — get job status
3. `GET /relay` — list jobs (optional)
4. `GET /health` — health check

Apply input validation, duplicate detection, and rate limiting.

### Step 5: Attestation Poller (`poller.ts`)

Implement the polling loop from Section 8.2.

Main loop:
1. Query all jobs with status `pending` or `polling`
2. For each, call Circle's v2 API (respecting rate limits)
3. Validate the attested message (mintRecipient, destinationDomain)
4. If attestation is ready and valid, update job to `attested`
5. If timeout exceeded, mark as `failed`

### Step 6: Ethereum Submitter (`submitter.ts`)

Implement the submission logic from Section 8.3.

Main loop:
1. Pick the oldest `attested` job
2. Estimate gas (catches reverts early)
3. Submit `receiveAndForward(message, attestation)`
4. Wait for 1 confirmation
5. Parse events from receipt to determine outcome
6. Update job to `confirmed`

### Step 7: Entry Point (`index.ts`)

Wire everything together:

```typescript
import { loadConfig } from "./config.js";
import { createStore } from "./store.js";
import { createApiServer } from "./api.js";
import { startPoller } from "./poller.js";
import { startSubmitter } from "./submitter.js";

const config = loadConfig();
const store = createStore(config.dbPath);

// Start HTTP API server
const app = createApiServer(config, store);
app.listen(config.apiPort, () => {
  console.log(`HTTP API listening on port ${config.apiPort}`);
});

// Start background loops
startPoller(config, store);
startSubmitter(config, store);

console.log("XReserve Relay Indexer started");
```

### Step 8: Testing

**Unit tests:**
- State store CRUD operations
- HTTP API input validation (valid/invalid sourceDomain, txHash formats)
- Duplicate detection (idempotent POST)
- Circle API response handling (mock fetch for 200, 404, 429, various statuses)
- Attested message validation logic
- Rate limiter behavior

**Integration tests:**
- End-to-end with mock Circle API server returning staged responses
- Verify relay job state transitions: pending → polling → attested → submitted → confirmed
- Test timeout behavior (attestation never arrives)
- Test retry behavior (Ethereum submission fails, then succeeds)
- Ethereum submitter with Hardhat fork mode (real router contract)

**Manual testing on testnet:**
1. Deploy router on Sepolia
2. Burn USDC on a testnet source chain (e.g., Arbitrum Sepolia) with mintRecipient = router
3. Note the source txHash
4. Start the indexer service pointed at sandbox Iris API
5. Submit `POST /relay { sourceDomain: 3, txHash: "0x..." }` to the indexer
6. Poll `GET /relay/{jobId}` until confirmed
7. Verify the relay completed on Sepolia (Forwarded or FallbackTriggered event)

### Step 9: Deployment Configuration

```
Environment variables:
  IS_TESTNET=false
  IRIS_API_BASE_URL=https://iris-api.circle.com
  ROUTER_ADDRESS=0x...
  ETHEREUM_RPC_URL=https://eth-mainnet.alchemyapi.io/v2/...
  RELAYER_PRIVATE_KEY=0x...
  TRANSMITTER_ADDRESS=0x81D40F21F12A8F0E3252Bccb954D722d4c464B64

  # HTTP API
  API_PORT=3000
  API_RATE_LIMIT_PER_SECOND=10

  # Poller
  POLL_CYCLE_INTERVAL_MS=2000
  ATTESTATION_TIMEOUT_MS=1800000
  IRIS_MAX_REQUESTS_PER_SECOND=30

  # Submitter
  MAX_RETRIES=3
  SUBMITTER_POLL_INTERVAL_MS=2000

  # State store
  DB_PATH=./data/relay.db
```

Note: No source chain RPC URLs are needed.

---

## 13. Deployment and Operations

### 13.1 Infrastructure

| Option | Description | Best For |
|--------|-------------|----------|
| Single VPS (e.g., Hetzner, DigitalOcean) | Run as a systemd service or Docker container | Initial deployment, low volume |
| Kubernetes | Deployment with health checks, auto-restart | Production, high availability |
| Serverless (not recommended) | Lambda/Cloud Functions | Not suitable — long-running polling loops |

**Minimum requirements:**
- 1 vCPU, 1 GB RAM
- Persistent storage for SQLite DB (~100 MB)
- Outbound internet for Ethereum RPC and Circle API
- Inbound HTTP access on the API port (for users/frontends to submit relay requests)

### 13.2 Startup and Recovery

On startup:
1. Open the SQLite database (create tables if not exist)
2. Resume any `pending` or `polling` jobs by re-entering the attestation poller
3. Resume any `attested` jobs by re-entering the submitter
4. Resume any `submitted` jobs by checking the Ethereum tx status
5. Start the HTTP API server

No chain cursor recovery is needed (unlike the source chain watcher approach) because job state is fully contained in the state store.

### 13.3 Operational Playbook

**Relayer wallet balance low:**
1. Check `relayer_eth_balance` metric
2. Transfer ETH to the relayer address
3. Submitter auto-resumes

**Jobs stuck in polling:**
1. Check Circle API status / CCTP status page
2. If Iris is down, jobs will resume when it comes back
3. Check if the source txHash is valid (user may have submitted an incorrect hash)

**Fallback triggered frequently:**
1. Check xReserve contract state (paused? domain paused?)
2. Check if the remote domain is still registered
3. Contact Circle support if xReserve infrastructure is down

**Indexer crashes / restarts:**
1. Automatic recovery via job state in SQLite
2. No data loss — all state is persisted
3. Duplicates prevented by nonce checks on-chain and unique constraint in DB

**Spam / abuse of HTTP API:**
1. Rate limiting on the API prevents excessive submissions
2. Invalid txHashes will timeout after 30 minutes (low cost — just a few API calls)
3. Monitor `relay_jobs_total` for unusual spikes
4. Consider adding authentication if abuse becomes a problem

### 13.4 Cost Estimates

| Cost | Estimate |
|------|----------|
| Ethereum gas per relay | ~200k–300k gas (~$5–$15 at current gas prices) |
| RPC provider (Ethereum only) | Alchemy Free/Growth plan ~$0–$49/month |
| VPS | ~$10–$20/month |
| Circle API | Free (no authentication, no charges) |

**Key cost difference from the source chain watcher approach:** No multi-chain RPC provider plans needed. Only a single Ethereum RPC connection is required, significantly reducing infrastructure costs.

The relayer's ETH gas cost is the primary expense. This should be recouped from the user (e.g., embedded in the CCTP `maxFee` or the xReserve `maxFee`), or subsidized by the protocol operator.

---

## Appendix A: CCTP Domain ID Reference

| Chain | Domain ID |
|-------|-----------|
| Ethereum | 0 |
| Avalanche | 1 |
| OP Mainnet | 2 |
| Arbitrum | 3 |
| Base | 6 |
| Polygon PoS | 7 |
| Unichain | 10 |
| Linea | 11 |
| Codex | 12 |
| Sonic | 13 |
| World Chain | 14 |
| Monad | 15 |
| Sei | 16 |
| XDC | 18 |
| HyperEVM | 19 |
| Ink | 21 |
| Plume | 22 |

## Appendix B: Contract Address Reference

| Contract | Address (All Mainnet Chains) |
|----------|-----------------------------|
| MessageTransmitterV2 | `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` |
| MessageTransmitterV2 (testnet) | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` |
| TokenMessengerV2 | Varies per chain — consult Circle docs |
| XReserveRouter | To be deployed |

## Appendix C: Event Topic0 Quick Reference

| Event | Topic0 |
|-------|--------|
| `MessageSent(bytes)` | `0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036` |
| `DepositForBurn(address,uint256,address,bytes32,uint32,bytes32,bytes32,uint256,uint32,bytes)` | Compute at build time via `ethers.id(...)` |
| `Forwarded(uint32,bytes32,uint256)` | Compute at build time |
| `FallbackTriggered(address,uint256)` | Compute at build time |
| `OperatorRouted(bytes32,bytes32,uint256,uint8)` | Compute at build time |
| `MessageReceived(address,uint32,bytes32,bytes32,uint32,bytes)` | `0xff48c13eda96b1cceacc6b9edeedc9e9db9d6226afbc30146b720c19d3addb1c` |
