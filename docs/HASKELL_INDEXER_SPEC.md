# XReserve Relay Indexer — Haskell Implementation Guide

This document specifies every requirement for a Haskell rewrite of the XReserve relay indexer. The implementor should not need to reference any TypeScript source.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Project Setup](#2-project-setup)
3. [Module Structure](#3-module-structure)
4. [Types (Types.hs)](#4-types)
5. [Configuration (Config.hs)](#5-configuration)
6. [SQLite Store (Store.hs)](#6-sqlite-store)
7. [Rate Limiter (RateLimit.hs)](#7-rate-limiter)
8. [Contract Bindings (Contract.hs)](#8-contract-bindings)
9. [Attestation Poller (Poller.hs)](#9-attestation-poller)
10. [Transaction Submitter (Submitter.hs)](#10-transaction-submitter)
11. [HTTP API (Api.hs)](#11-http-api)
12. [Entrypoint (Main.hs)](#12-entrypoint)
13. [CCTP MessageV2 Binary Layout Reference](#13-cctp-messagev2-binary-layout-reference)
14. [Circle Iris API Reference](#14-circle-iris-api-reference)
15. [XReserveRouter Contract Reference](#15-xreserverouter-contract-reference)
16. [Error Catalog](#16-error-catalog)
17. [Operational Notes](#17-operational-notes)

---

## 1. System Overview

The indexer is a single-process service with three concurrent components:

```
                    ┌──────────────────────────┐
 POST /relay ──────►│       HTTP API           │
 GET  /relay/:tx    │  (Servant / Scotty)      │
 GET  /health       └────────┬─────────────────┘
                             │ createJob / getJob
                             ▼
                    ┌──────────────────────────┐
                    │     SQLite Store          │
                    │  (sqlite-simple, WAL)     │
                    └────┬───────────────┬─────┘
                         │               │
              getJobsByStatus      getOldestByStatus
              ["pending","polling"]    "attested"
                         │               │
                         ▼               ▼
                  ┌─────────────┐  ┌─────────────────┐
                  │  Poller     │  │  Submitter       │
                  │             │  │                  │
                  │ Circle Iris │  │ Ethereum JSON-RPC│
                  │ REST API    │  │ (hs-web3)        │
                  └─────────────┘  └─────────────────┘
```

### Data flow

1. A client POSTs `{ sourceDomain, txHash }` to `POST /relay`. The API validates the request and creates a job in SQLite with status `pending`.
2. The **Poller** thread picks up `pending` and `polling` jobs, queries Circle's Iris API for attestations, validates the CCTP message binary, and advances jobs to `attested`.
3. The **Submitter** thread picks up `attested` jobs, calls `receiveAndForward(message, attestation)` on the XReserveRouter contract via Ethereum JSON-RPC, waits for confirmation, classifies the outcome from transaction logs, and advances jobs to `confirmed` or `failed`.

### Job status state machine

```
pending ──► polling ──► attested ──► submitted ──► confirmed
   │            │           │             │
   └──► failed  └──► failed └──► failed   └──► failed
```

Transitions:
- `pending → polling`: Poller picks up job for the first time
- `polling → attested`: Iris API returns a complete attestation that passes validation
- `polling → failed`: Attestation timeout (30 min default) or message validation failure
- `attested → submitted`: Ethereum transaction broadcast successfully
- `submitted → confirmed`: Transaction receipt received with status=1
- `attested → failed`: Terminal revert (nonce used, transfer settled, etc.) or max retries exceeded
- `submitted → failed`: Transaction reverted on-chain

---

## 2. Project Setup

### Build system

Use **Stack** with **hpack** (`package.yaml` → `.cabal`).

```yaml
# stack.yaml
resolver: lts-22.27
packages:
  - .
extra-deps:
  - web3-1.0.1.0
  - web3-ethereum-1.0.1.0
  - web3-solidity-1.0.1.0
  - web3-provider-1.0.1.0
  - web3-crypto-1.0.1.0
  - web3-bignum-1.0.1.0
  - jsonrpc-tinyclient-1.0.1.0
  - memory-hexstring-1.0.1.0
  # Pin any other deps not in the LTS snapshot as needed
```

### Dependencies (`package.yaml`)

```yaml
name: xreserve-relay-indexer
version: 0.1.0.0
license: MIT

dependencies:
  - base >= 4.14 && < 5

  # ── hs-web3 ──
  - web3                    # Top-level: Network.Web3, re-exports ethereum
  - web3-ethereum           # Contract TH, Account, Eth API, Events
  - web3-solidity           # ABI codec, Solidity primitives
  - web3-provider           # Web3 monad, HTTP/WS provider
  - web3-crypto             # PrivateKey, signing
  - memory-hexstring        # HexString type

  # ── HTTP server ──
  - servant-server          # Typed REST API
  - warp                    # HTTP server backend for Servant

  # ── SQLite ──
  - sqlite-simple           # Direct SQL, prepared statements

  # ── HTTP client (for Circle Iris API) ──
  - http-client             # Already a transitive dep of hs-web3
  - http-client-tls
  - http-types              # Status codes

  # ── JSON ──
  - aeson                   # JSON encode/decode

  # ── Concurrency ──
  - async                   # withAsync, concurrently
  - stm                     # TVar, STM for rate limiter and shutdown signal

  # ── Time ──
  - time                    # UTCTime, ISO 8601 formatting

  # ── Byte manipulation ──
  - bytestring
  - binary                  # Data.Binary.Get for big-endian reads
  - memory                  # ByteArray abstraction (from cryptonite ecosystem)

  # ── Text ──
  - text

  # ── Misc ──
  - unix                    # POSIX signal handlers
  - directory               # createDirectoryIfMissing

ghc-options:
  - -Wall
  - -Wno-orphans
  - -O2
  - -threaded
  - -rtsopts
  - -with-rtsopts=-N

default-extensions:
  - OverloadedStrings
  - DeriveGeneric
  - DeriveAnyClass
  - RecordWildCards
  - ScopedTypeVariables
  - TemplateHaskell
  - QuasiQuotes
  - DataKinds
  - TypeOperators
  - TypeApplications
```

### Project layout

```
xreserve-relay-indexer/
├── package.yaml
├── stack.yaml
├── abi/
│   └── XReserveRouter.json    # ABI JSON array for TH quasiquoter (see §8)
├── src/
│   ├── Main.hs
│   ├── Config.hs
│   ├── Types.hs
│   ├── Contract.hs
│   ├── Store.hs
│   ├── RateLimit.hs
│   ├── Poller.hs
│   ├── Submitter.hs
│   └── Api.hs
└── data/                      # Created at runtime for SQLite DB
```

---

## 3. Module Structure

| Module | Responsibility | Key imports |
|--------|---------------|-------------|
| `Types` | Domain types: `RelayStatus`, `Outcome`, `RelayJob` | `aeson`, `sqlite-simple` |
| `Config` | Load and validate environment variables | `System.Environment` |
| `Store` | SQLite CRUD operations | `Database.SQLite.Simple` |
| `RateLimit` | Token-bucket rate limiter for Iris API | `Control.Concurrent.STM` |
| `Contract` | hs-web3 TH-generated contract bindings | `Network.Ethereum.Contract.TH` |
| `Poller` | Circle Iris API polling + CCTP message validation | `Network.HTTP.Client`, `Data.Binary.Get` |
| `Submitter` | Ethereum transaction submission + event classification | `Network.Ethereum.Account`, `Network.Ethereum.Api.Eth` |
| `Api` | HTTP API server | `Servant` |
| `Main` | Entrypoint: wiring, startup, graceful shutdown | `Control.Concurrent.Async`, `System.Posix.Signals` |

### Dependency graph (module imports)

```
Main ─────► Config
      ├───► Store ──────► Types
      ├───► Api ────────► Types, Store, Config
      ├───► Poller ─────► Types, Store, Config, RateLimit
      └───► Submitter ──► Types, Store, Config, Contract
```

---

## 4. Types

### `Types.hs`

```haskell
module Types where
```

#### RelayStatus

```haskell
data RelayStatus
  = Pending
  | Polling
  | Attested
  | Submitted
  | Confirmed
  | Failed
  deriving (Eq, Show, Read, Bounded, Enum, Generic)
```

Provide `ToJSON`/`FromJSON` instances that serialize to lowercase strings: `"pending"`, `"polling"`, `"attested"`, `"submitted"`, `"confirmed"`, `"failed"`.

Provide `ToField`/`FromField` instances for `sqlite-simple` that store as lowercase `TEXT`.

#### Outcome

```haskell
data Outcome
  = Forwarded
  | Fallback
  | OperatorRouted
  deriving (Eq, Show, Read, Generic)
```

Serialize to/from JSON as `"forwarded"`, `"fallback"`, `"operator_routed"`.

Serialize to/from SQLite as `TEXT` with the same strings.

#### RelayJob

```haskell
data RelayJob = RelayJob
  { jobTxHash            :: !Text        -- PRIMARY KEY, 0x-prefixed lowercase hex, 66 chars
  , jobSourceDomain      :: !Int         -- CCTP source domain ID

  -- Populated when attested
  , jobAttestedMessage   :: !(Maybe Text)  -- 0x-prefixed hex of full CCTP message
  , jobAttestation       :: !(Maybe Text)  -- 0x-prefixed hex of Circle attestation signature
  , jobIrisNonce         :: !(Maybe Text)  -- eventNonce string from Iris API

  -- Decoded from attested message
  , jobMintRecipient     :: !(Maybe Text)  -- checksummed Ethereum address
  , jobDestinationDomain :: !(Maybe Int)
  , jobAmount            :: !(Maybe Text)  -- decimal string of uint256

  -- Ethereum submission
  , jobEthTxHash         :: !(Maybe Text)  -- 0x-prefixed Ethereum tx hash
  , jobEthBlockNumber    :: !(Maybe Int)

  -- State
  , jobStatus            :: !RelayStatus
  , jobOutcome           :: !(Maybe Outcome)
  , jobError             :: !(Maybe Text)

  -- Operational counters
  , jobPollAttempts      :: !Int
  , jobRetryCount        :: !Int

  -- Timestamps (ISO 8601 UTC strings, e.g. "2025-01-15T10:30:00.000Z")
  , jobCreatedAt         :: !Text
  , jobAttestedAt        :: !(Maybe Text)
  , jobSubmittedAt       :: !(Maybe Text)
  , jobConfirmedAt       :: !(Maybe Text)
  , jobUpdatedAt         :: !Text
  } deriving (Eq, Show, Generic)
```

Provide `FromRow` instance for `sqlite-simple` that maps from the snake_case SQL columns (see §6) to the record fields.

Provide `ToJSON` instance for API responses (only selected fields are exposed — see §11).

---

## 5. Configuration

### `Config.hs`

```haskell
module Config (Config(..), loadConfig) where
```

#### Config record

```haskell
data Config = Config
  { cfgIsTestnet             :: !Bool
  , cfgIrisApiBaseUrl        :: !Text
  , cfgRouterAddress         :: !Text       -- checksummed or lowercase, as provided
  , cfgRouterBytes32         :: !ByteString  -- 32 bytes: 12 zero bytes ++ 20-byte address
  , cfgEthereumRpcUrl        :: !String
  , cfgRelayerPrivateKey     :: !PrivateKey  -- hs-web3 Crypto.Ethereum.PrivateKey
  , cfgTransmitterAddress    :: !Text
  , cfgApiPort               :: !Int
  , cfgPollCycleIntervalMs   :: !Int
  , cfgAttestationTimeoutMs  :: !Int
  , cfgMaxRetries            :: !Int
  , cfgSubmitterPollIntervalMs :: !Int
  , cfgDbPath                :: !FilePath
  } deriving (Show)
```

#### Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `IS_TESTNET` | no | `"false"` | `"true"` for testnet, anything else for mainnet |
| `ROUTER_ADDRESS` | **yes** | — | Deployed XReserveRouter contract address (0x-prefixed) |
| `ETHEREUM_RPC_URL` | **yes** | — | Ethereum JSON-RPC endpoint URL |
| `RELAYER_PRIVATE_KEY` | **yes** | — | Private key for the relayer wallet (0x-prefixed hex) |
| `TRANSMITTER_ADDRESS` | **yes** | — | Circle MessageTransmitterV2 address |
| `API_PORT` | no | `3000` | HTTP API listen port |
| `POLL_CYCLE_INTERVAL_MS` | no | `2000` | Milliseconds between poller cycles |
| `ATTESTATION_TIMEOUT_MS` | no | `1800000` | Milliseconds (30 min) before a job is timed out |
| `MAX_RETRIES` | no | `3` | Max Ethereum submission attempts before failing |
| `SUBMITTER_POLL_INTERVAL_MS` | no | `2000` | Milliseconds between submitter polls for attested jobs |
| `DB_PATH` | no | `"./data/relay.db"` | Path to the SQLite database file |

#### `loadConfig` logic

1. Read each required env var; call `error` (or throw) with message `"Missing required env var: <NAME>"` if absent.
2. Parse `IS_TESTNET`: set `cfgIsTestnet = True` when value is exactly `"true"`.
3. Compute `cfgIrisApiBaseUrl`:
   - Testnet: `"https://iris-api-sandbox.circle.com"`
   - Mainnet: `"https://iris-api.circle.com"`
4. Compute `cfgRouterBytes32`: left-pad the 20-byte address to 32 bytes with zeros. This is the CCTP `bytes32` representation of an Ethereum address. In Haskell, strip the `0x` prefix, decode hex to a 20-byte `ByteString`, then prepend 12 zero bytes.
5. Parse `RELAYER_PRIVATE_KEY` into an hs-web3 `PrivateKey` using `Crypto.Ethereum.importKey` (or equivalent). The key is a 32-byte hex string (with or without `0x` prefix).
6. Parse integer env vars with `read` / `readMaybe`, falling back to defaults.

---

## 6. SQLite Store

### `Store.hs`

```haskell
module Store (Store(..), initStore) where
```

#### Schema

Create on startup (idempotent):

```sql
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
```

Enable WAL mode on connection open: `PRAGMA journal_mode = WAL;`

#### Store interface

Use a record-of-functions pattern (or a typeclass — implementor's choice):

```haskell
data Store = Store
  { createJob        :: RelayJob -> IO ()
  , getJob           :: Text -> IO (Maybe RelayJob)
  , updateJob        :: Text -> [(Text, SQLData)] -> IO ()
  , getJobsByStatus  :: [RelayStatus] -> Int -> IO [RelayJob]
  , getOldestByStatus :: RelayStatus -> IO (Maybe RelayJob)
  , countByStatus    :: IO (Map Text Int)
  }
```

#### `initStore`

```haskell
initStore :: FilePath -> IO Store
```

1. Open database connection via `Database.SQLite.Simple.open`.
2. Execute `PRAGMA journal_mode = WAL`.
3. Execute the `CREATE TABLE` and `CREATE INDEX` statements.
4. Return a `Store` value with the operations below.

#### Operations

**`createJob :: RelayJob -> IO ()`**

Insert all 20 fields. Use a parameterized query:

```sql
INSERT INTO relay_jobs (
  tx_hash, source_domain,
  attested_message, attestation, iris_nonce,
  mint_recipient, destination_domain, amount,
  eth_tx_hash, eth_block_number,
  status, outcome, error, poll_attempts, retry_count,
  created_at, attested_at, submitted_at, confirmed_at, updated_at
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
```

**`getJob :: Text -> IO (Maybe RelayJob)`**

```sql
SELECT * FROM relay_jobs WHERE tx_hash = ?
```

**`updateJob :: Text -> [(Text, SQLData)] -> IO ()`**

Takes a `txHash` and a list of `(column_name, value)` pairs. Always adds `updated_at = <current ISO time>` to the SET clause. Builds:

```sql
UPDATE relay_jobs SET col1 = ?, col2 = ?, ..., updated_at = ? WHERE tx_hash = ?
```

The caller provides column names using the SQL column names (snake_case), not Haskell field names. This keeps the store generic.

Alternatively, provide specific update functions if the implementor prefers type safety over generality. The key requirement is that `updated_at` is always set on every update.

**`getJobsByStatus :: [RelayStatus] -> Int -> IO [RelayJob]`**

```sql
SELECT * FROM relay_jobs
WHERE status IN (?, ?, ...)
ORDER BY created_at ASC
LIMIT ?
```

Returns the oldest jobs first.

**`getOldestByStatus :: RelayStatus -> IO (Maybe RelayJob)`**

```sql
SELECT * FROM relay_jobs
WHERE status = ?
ORDER BY created_at ASC
LIMIT 1
```

**`countByStatus :: IO (Map Text Int)`**

```sql
SELECT status, COUNT(*) as cnt FROM relay_jobs GROUP BY status
```

Returns a map like `{"pending": 2, "confirmed": 15}`.

---

## 7. Rate Limiter

### `RateLimit.hs`

```haskell
module RateLimit (TokenBucket, newTokenBucket, acquire) where
```

Implements a token-bucket rate limiter to stay under Circle's Iris API rate limit.

#### Parameters

- **Max tokens (burst):** 30
- **Refill rate:** 30 tokens/second

This keeps the service under ~35 req/s with safety margin.

#### Interface

```haskell
data TokenBucket  -- opaque

newTokenBucket :: Int -> Double -> IO TokenBucket
-- newTokenBucket maxTokens refillRatePerSecond

acquire :: TokenBucket -> IO ()
-- Blocks until a token is available, then consumes one token.
```

#### Implementation

Use `TVar` (STM) to hold `(currentTokens :: Double, lastRefillTime :: UTCTime)`.

`acquire` logic:
1. Atomically read and refill: `newTokens = min(maxTokens, currentTokens + elapsed * refillRate)`.
2. If `newTokens >= 1`: deduct 1, update `lastRefillTime`, return.
3. If `newTokens < 1`: compute `waitMs = (1 - newTokens) / refillRate * 1000`, release the STM lock, `threadDelay waitMs`, then retry.

Create one global `TokenBucket` for all Iris API calls.

---

## 8. Contract Bindings

### `Contract.hs`

```haskell
{-# LANGUAGE QuasiQuotes #-}
module Contract where

import Network.Ethereum.Contract.TH

[abiFrom|abi/XReserveRouter.json|]
```

#### ABI file (`abi/XReserveRouter.json`)

Place the following ABI JSON array (NOT the full Truffle artifact — just the `"abi"` array) at `abi/XReserveRouter.json`:

```json
[
  {
    "type": "function",
    "name": "receiveAndForward",
    "inputs": [
      { "name": "message", "type": "bytes" },
      { "name": "attestation", "type": "bytes" }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "Relayed",
    "inputs": [
      { "name": "sourceDomain", "type": "uint32", "indexed": true },
      { "name": "sourceSender", "type": "bytes32", "indexed": true },
      { "name": "nonce", "type": "bytes32", "indexed": true },
      { "name": "amount", "type": "uint256", "indexed": false }
    ]
  },
  {
    "type": "event",
    "name": "FallbackTriggered",
    "inputs": [
      { "name": "fallbackRecipient", "type": "address", "indexed": true },
      { "name": "amount", "type": "uint256", "indexed": false }
    ]
  },
  {
    "type": "event",
    "name": "RecoveredFromConsumedNonce",
    "inputs": [
      { "name": "nonce", "type": "bytes32", "indexed": true },
      { "name": "amount", "type": "uint256", "indexed": false }
    ]
  },
  {
    "type": "event",
    "name": "OperatorRouted",
    "inputs": [
      { "name": "transferId", "type": "bytes32", "indexed": true },
      { "name": "nonce", "type": "bytes32", "indexed": true },
      { "name": "amount", "type": "uint256", "indexed": false },
      { "name": "reason", "type": "uint8", "indexed": false }
    ]
  }
]
```

#### What TH generates

The `[abiFrom|...|]` splice will generate:

- **`ReceiveAndForwardData`** — A data type holding `(Bytes, Bytes)` with a `Method` instance whose `selector` is `keccak256("receiveAndForward(bytes,bytes)")` truncated to 4 bytes.
- **`Relayed`** — Event data type with `DecodeEvent` instance. Topic0 = `keccak256("Relayed(uint32,bytes32,bytes32,uint256)")`.
- **`FallbackTriggered`** — Event data type. Topic0 = `keccak256("FallbackTriggered(address,uint256)")`.
- **`RecoveredFromConsumedNonce`** — Event data type. Topic0 = `keccak256("RecoveredFromConsumedNonce(bytes32,uint256)")`.
- **`OperatorRouted`** — Event data type. Topic0 = `keccak256("OperatorRouted(bytes32,bytes32,uint256,uint8)")`.

These are used in the Submitter to classify transaction outcomes.

#### Fallback: manual topic hashes

If the TH quasiquoter causes issues (version mismatch, build failure), you can compute topic0 hashes manually. The keccak256 values are:

| Event | Signature | topic0 |
|-------|-----------|--------|
| Relayed | `Relayed(uint32,bytes32,bytes32,uint256)` | Compute with `Crypto.Ethereum.keccak256` |
| FallbackTriggered | `FallbackTriggered(address,uint256)` | Compute at compile-time or startup |
| RecoveredFromConsumedNonce | `RecoveredFromConsumedNonce(bytes32,uint256)` | — |
| OperatorRouted | `OperatorRouted(bytes32,bytes32,uint256,uint8)` | — |

In that case, classify logs by matching `logTopics !! 0` against these hashes, and skip the TH-generated event types.

---

## 9. Attestation Poller

### `Poller.hs`

```haskell
module Poller (startPoller) where

startPoller :: Config -> Store -> TVar Bool -> IO ()
-- The TVar Bool is the shutdown signal. When True, exit the loop.
```

#### Main loop

```
forever:
  1. Check shutdown signal. If set, return.
  2. Fetch up to 20 jobs with status IN ("pending", "polling"), oldest first.
  3. For each job:
     a. Check timeout: if (now - jobCreatedAt) > cfgAttestationTimeoutMs:
        - updateJob: status = "failed", error = "attestation_timeout"
        - continue to next job
     b. If job status is "pending":
        - updateJob: status = "polling"
     c. Call pollForAttestation (see below)
     d. If attestation received:
        - Validate the attested message (see §9.2)
        - If invalid: updateJob: status = "failed", error = <reason>
        - If valid: updateJob:
            status          = "attested"
            attestedMessage = <0x-hex of message>
            attestation     = <0x-hex of attestation>
            irisNonce       = <eventNonce string>
            mintRecipient   = <checksummed address>
            destinationDomain = <parsed int>
            amount          = <decimal string>
            attestedAt      = <ISO 8601 now>
            pollAttempts    = jobPollAttempts + 1
        - Log: "Attestation received for <txHash> (domain <sourceDomain>)"
     e. If no attestation yet:
        - updateJob: pollAttempts = jobPollAttempts + 1
     f. On RATE_LIMITED error:
        - Log warning: "Rate limited by Circle API, backing off 60s"
        - threadDelay 60 seconds
        - Break out of the inner job loop (skip remaining jobs this cycle)
     g. On other errors: log and continue to next job
  4. threadDelay cfgPollCycleIntervalMs
```

### 9.1. `pollForAttestation`

```haskell
pollForAttestation :: Config -> TokenBucket -> Int -> Text -> IO (Maybe AttestationResult)
-- Arguments: config, rateLimiter, sourceDomain, txHash
```

Where:

```haskell
data AttestationResult = AttestationResult
  { arMessage     :: !Text   -- 0x-prefixed hex
  , arAttestation :: !Text   -- 0x-prefixed hex
  , arNonce       :: !Text   -- eventNonce string
  }
```

Logic:

1. Call `acquire` on the token bucket (blocks until rate limit allows).
2. HTTP GET to: `<irisApiBaseUrl>/v2/messages/<sourceDomain>?transactionHash=<txHash>`
3. Handle response:
   - **404**: Return `Nothing` (not yet indexed by Circle).
   - **429**: Throw a distinguishable `RateLimited` exception.
   - **Other non-2xx**: Log `"Iris API error: <statusCode>"`, return `Nothing`.
   - **200**: Parse JSON body (see §14 for schema).
     - If `messages` array is empty or absent: return `Nothing`.
     - Take `messages[0]`. If `status == "complete"` AND `attestation != "PENDING"`:
       return `Just AttestationResult { message, attestation, nonce = eventNonce }`.
     - Otherwise: return `Nothing` (still pending).

### 9.2. `validateAttestedMessage`

```haskell
validateAttestedMessage :: ByteString -> Text -> ByteString -> Validation
-- Arguments: messageBytes, routerAddress, routerBytes32
```

Where:

```haskell
data Validation
  = Valid
    { vMintRecipient     :: !Text   -- checksummed Ethereum address
    , vDestinationDomain :: !Int
    , vAmount            :: !Text   -- decimal string of uint256
    }
  | Invalid !Text  -- reason string
```

The input `messageBytes` is the raw bytes of the full CCTP MessageV2 (decoded from the hex string returned by Iris). See §13 for the complete binary layout.

Validation steps:

1. **Length check**: `messageBytes` must be at least 248 bytes (148 header + 100 body bytes to include the amount field). If shorter: `Invalid "message too short"`.

2. **Destination domain** (header offset 8, 4 bytes, big-endian uint32): Must be `0` (Ethereum). If not: `Invalid "destination domain <n> != 0 (Ethereum)"`.

3. **destinationCaller** (header offset 108, 32 bytes): Read as a 32-byte value.
   - If all zeros (bytes32(0)): **Accept but log a warning** — `"destinationCaller is zero (open) — nonce front-run risk"`.
   - If equal to `routerBytes32` (case-insensitive hex comparison): accept.
   - Otherwise: `Invalid "destinationCaller <hex> != router or zero"`.

4. **mintRecipient** (absolute offset 184, 32 bytes): This is a bytes32-encoded Ethereum address (left-padded with 12 zero bytes). Extract the last 20 bytes as an address. Must match `routerAddress` (case-insensitive). If not: `Invalid "mintRecipient <addr> != router <routerAddress>"`.

5. **amount** (absolute offset 216, 32 bytes): Read as big-endian uint256. Convert to decimal string. This is the gross burn amount (before CCTP fee deduction). Return it in the `Valid` result.

#### Binary reading helpers

Use `Data.Binary.Get` or direct `ByteString` slicing:

- **Read uint32 at offset `n`**: Take bytes `[n..n+4)`, interpret as big-endian 32-bit unsigned integer.
- **Read bytes32 at offset `n`**: Take bytes `[n..n+32)`.
- **Read uint256 at offset `n`**: Take bytes `[n..n+32)`, interpret as big-endian 256-bit unsigned integer. Use the `Integer` type.
- **bytes32 to address**: Take the last 20 bytes of the 32-byte value. Format as `0x`-prefixed hex.

---

## 10. Transaction Submitter

### `Submitter.hs`

```haskell
module Submitter (startSubmitter) where

startSubmitter :: Config -> Store -> TVar Bool -> IO ()
```

#### Setup

On startup, create:
- An hs-web3 `Provider` connected to `cfgEthereumRpcUrl`.
- A `LocalKey` account from `cfgRelayerPrivateKey` with the appropriate chain ID.
  - Chain ID 1 for mainnet, 11155111 for Sepolia (derive from `cfgIsTestnet`).
- A contract handle at `cfgRouterAddress`.

#### Main loop

```
forever:
  1. Check shutdown signal. If set, return.
  2. Fetch the oldest job with status "attested":
     job = getOldestByStatus("attested")
  3. If no job: threadDelay cfgSubmitterPollIntervalMs, continue.
  4. Try to submit:
     a. ESTIMATE GAS:
        - Call eth_estimateGas for receiveAndForward(job.attestedMessage, job.attestation)
          targeting cfgRouterAddress from the relayer address.
        - If estimation fails (revert): capture the error message and go to step 4f.
     b. SUBMIT TRANSACTION:
        - Call receiveAndForward with gasLimit = estimatedGas * 120 / 100 (20% buffer).
        - Using LocalKeyAccount: this signs locally and calls eth_sendRawTransaction.
        - Capture the returned tx hash.
     c. UPDATE STATUS TO SUBMITTED:
        - updateJob: ethTxHash = txHash, status = "submitted", submittedAt = <ISO 8601 now>
        - Log: "Submitted tx <ethTxHash> for <jobTxHash>"
     d. WAIT FOR CONFIRMATION:
        - Poll eth_getTransactionReceipt until non-null (1-second intervals).
        - hs-web3 does not have a built-in tx.wait(). Implement a simple retry loop:
          loop { receipt <- getTransactionReceipt txHash; case receipt of Just r -> return r; Nothing -> threadDelay 1000000 >> loop }
     e. CLASSIFY OUTCOME:
        - If receipt.status == 0 (reverted): throw error "Tx reverted: <txHash>"
        - Scan receipt.logs for known events by matching topic0:
          - If any log has topic0 == Relayed.topic0: outcome = Forwarded
          - Else if topic0 == FallbackTriggered.topic0: outcome = Fallback
          - Else if topic0 == OperatorRouted.topic0: outcome = OperatorRouted
            - Log warning: "Operator-routed for <jobTxHash> (empty or malformed hookData)"
          - If topic0 == RecoveredFromConsumedNonce.topic0 is found (in addition to any above):
            - Log warning: "Nonce-consumed recovery used for <jobTxHash>"
        - updateJob:
            ethBlockNumber = receipt.blockNumber
            confirmedAt    = <ISO 8601 now>
            outcome        = <determined outcome>
            status         = "confirmed"
        - Log: "Relay confirmed: <jobTxHash> → <outcome>"
     f. ON ERROR:
        - Capture error message as text.
        - Check if the error is TERMINAL (not worth retrying):
          The error message contains ANY of these substrings:
            - "transfer settled"
            - "Nonce already used"
            - "invalid destinationDomain"
            - "invalid destinationCaller"
            - "invalid mintRecipient"
        - If terminal:
            updateJob: status = "failed", error = <message>, retryCount = jobRetryCount + 1
        - If non-terminal:
            newRetryCount = jobRetryCount + 1
            If newRetryCount >= cfgMaxRetries:
              updateJob: status = "failed", error = <message>, retryCount = newRetryCount
            Else:
              updateJob: error = <message>, retryCount = newRetryCount
              (Keep status as "attested" so it will be retried next cycle)
        - Log: "Submission failed for <jobTxHash>: <message>"
  5. threadDelay 1_000_000 (1 second between submission attempts)
```

#### Gas estimation details

Use hs-web3's `Network.Ethereum.Api.Eth.estimateGas` or `eth_estimateGas` via `remote`. Build a `Call` value:

```haskell
Call
  { callFrom  = Just relayerAddress
  , callTo    = Just routerAddress
  , callData  = Just $ selector @ReceiveAndForwardData <> encode (attestedMessage, attestation)
  , callValue = Nothing
  , callGas   = Nothing
  , callGasPrice = Nothing
  }
```

The 20% buffer (`* 120 / 100`) prevents marginal out-of-gas failures when the actual execution uses slightly more gas than the estimate.

#### EIP-1559 caveat

hs-web3's `encodeTransaction` implements EIP-155 (legacy transactions) only. If the target chain requires EIP-1559 (type 2) transactions, you have two options:

1. **Use `eth_sendTransaction` via a node that supports it** (e.g., use `DefaultAccount` if the node manages the key — not recommended for production).
2. **Implement EIP-1559 transaction encoding** on top of hs-web3. This requires: (a) querying `eth_maxPriorityFeePerGas` and `eth_feeHistory`, (b) RLP-encoding a type-2 transaction envelope, (c) signing with the local key. This is a non-trivial extension.
3. **Use legacy transactions** — Ethereum still accepts legacy (type 0) transactions. They work fine; you just pay `gasPrice` instead of `maxFeePerGas + maxPriorityFeePerGas`. Query `eth_gasPrice` for a reasonable value.

Recommendation: start with legacy transactions (option 3). Upgrade to EIP-1559 later if gas efficiency matters.

---

## 11. HTTP API

### `Api.hs`

```haskell
module Api (startApi) where

startApi :: Config -> Store -> IO ()
-- Runs Warp on cfgApiPort. Blocks.
```

Use **Servant** to define a typed API. Alternatively, **Scotty** is simpler if the implementor prefers. The spec below defines routes, validation, and response shapes.

#### Global middleware

- **CORS**: Allow all origins (for frontend/dapp integration).
- **Rate limiting**: 10 requests/second per IP. Use `wai-extra` or a custom WAI middleware.
- **JSON body parsing**: Automatic with Servant's `ReqBody '[JSON]`.

### 11.1. `POST /relay`

**Request body** (JSON):

```json
{
  "sourceDomain": 3,
  "txHash": "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
}
```

**Validation**:

1. `sourceDomain` must be an integer in the set: `{1, 2, 3, 6, 7, 10, 11, 12, 13, 14, 15, 16, 18, 19, 21, 22}`. These are CCTP v2 source domain IDs (excludes 0 = Ethereum, which is the destination).
   - On failure: `400 {"error": "Invalid sourceDomain"}`

2. `txHash` must be a string matching the regex `^0x[a-fA-F0-9]{64}$`.
   - On failure: `400 {"error": "Invalid txHash format"}`

**Logic**:

1. Normalize `txHash` to lowercase.
2. Check if a job already exists with this txHash (`getJob`).
   - If exists: return `200`:
     ```json
     { "txHash": "<existing.txHash>", "status": "<existing.status>", "message": "Relay job already exists." }
     ```
3. Create a new job:
   ```
   RelayJob
     { jobTxHash = normalizedTxHash
     , jobSourceDomain = sourceDomain
     , jobStatus = Pending
     , jobPollAttempts = 0
     , jobRetryCount = 0
     , jobCreatedAt = <ISO 8601 now>
     , jobUpdatedAt = <ISO 8601 now>
     -- all Maybe fields = Nothing
     }
   ```
4. Return `201`:
   ```json
   { "txHash": "<normalizedTxHash>", "status": "pending", "message": "Relay job created. Poll GET /relay/:txHash for status." }
   ```

**Error**: `500 {"error": "Internal server error"}` for unexpected exceptions.

### 11.2. `GET /relay/:txHash`

**Path parameter**: `txHash` — a transaction hash (any casing).

**Logic**:

1. Normalize `txHash` to lowercase.
2. Look up the job (`getJob`).
   - If not found: `404 {"error": "Job not found"}`
3. Return `200` with selected fields only:

```json
{
  "txHash": "0x...",
  "sourceDomain": 3,
  "status": "confirmed",
  "outcome": "forwarded",
  "error": null,
  "ethTxHash": "0x...",
  "createdAt": "2025-01-15T10:30:00.000Z",
  "attestedAt": "2025-01-15T10:30:12.000Z",
  "submittedAt": "2025-01-15T10:30:14.000Z",
  "confirmedAt": "2025-01-15T10:30:26.000Z"
}
```

Do NOT expose: `attestedMessage`, `attestation`, `irisNonce`, `mintRecipient`, `destinationDomain`, `amount`, `ethBlockNumber`, `pollAttempts`, `retryCount`, `updatedAt`.

### 11.3. `GET /health`

No parameters.

**Response** (`200`):

```json
{
  "status": "healthy",
  "jobs": {
    "pending": 0,
    "polling": 2,
    "attested": 0,
    "confirmed": 15
  }
}
```

The `jobs` object contains counts per status from `countByStatus`. Statuses with zero jobs may be omitted or included with value 0.

On SQLite error: `500 {"status": "unhealthy"}`.

---

## 12. Entrypoint

### `Main.hs`

```haskell
module Main where
```

#### Startup sequence

1. `cfg <- loadConfig`
2. Ensure the parent directory of `cfgDbPath` exists (`createDirectoryIfMissing True`).
3. `store <- initStore (cfgDbPath cfg)`
4. Create a `TVar Bool` as the shutdown signal, initialized to `False`.
5. Launch three concurrent threads:
   - `pollerThread  <- async (startPoller cfg store shutdownVar)`
   - `submitterThread <- async (startSubmitter cfg store shutdownVar)`
   - `apiThread <- async (startApi cfg store)`
6. Log: `"HTTP API listening on port <cfgApiPort>"` and `"XReserve Relay Indexer started"`.
7. Install signal handlers for SIGINT and SIGTERM:
   - On signal: set `shutdownVar` to `True`, then cancel the API thread (which will close the Warp server).
8. Wait for any thread to finish (`waitAny [pollerThread, submitterThread, apiThread]`).
9. On exit, log `"Shutting down..."`.

#### Structured concurrency

Use `withAsync` from the `async` library to ensure that if any thread throws an unhandled exception, the others are cancelled:

```haskell
withAsync (startPoller cfg store shutdown) $ \_ ->
  withAsync (startSubmitter cfg store shutdown) $ \_ ->
    startApi cfg store  -- blocks on Warp
```

This means:
- If the poller crashes, the submitter and API are cancelled.
- If the API is interrupted (signal), the poller and submitter are cancelled.

#### Graceful shutdown

When a signal is received:
1. Set the `TVar Bool` to `True`. Both the poller and submitter check this at the top of each loop iteration and exit cleanly.
2. The Warp server is shut down (cancel the async or use Warp's `setGracefulShutdownTimeout`).
3. SQLite connections are closed (GC / explicit close).
4. Process exits with code 0 on clean shutdown, code 1 on unhandled exception.

---

## 13. CCTP MessageV2 Binary Layout Reference

The full CCTP message is `abi.encodePacked` (not standard ABI encoding — no length prefixes on fixed-size fields). All multi-byte integers are **big-endian**.

### Outer MessageV2 Header (148 bytes)

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 4 | uint32 | version |
| 4 | 4 | uint32 | sourceDomain |
| 8 | 4 | uint32 | destinationDomain |
| 12 | 32 | bytes32 | nonce |
| 44 | 32 | bytes32 | sender |
| 76 | 32 | bytes32 | recipient |
| 108 | 32 | bytes32 | destinationCaller |
| 140 | 4 | uint32 | minFinalityThreshold |
| 144 | 4 | uint32 | finalityExecuted |
| **148** | — | bytes | **messageBody** (BurnMessageV2) |

### BurnMessageV2 Body (offsets relative to byte 148)

| Rel. Offset | Abs. Offset | Size | Type | Field |
|-------------|-------------|------|------|-------|
| 0 | 148 | 4 | uint32 | version |
| 4 | 152 | 32 | bytes32 | burnToken |
| 36 | 184 | 32 | bytes32 | **mintRecipient** |
| 68 | 216 | 32 | uint256 | **amount** |
| 100 | 248 | 32 | bytes32 | messageSender |
| 132 | 280 | 32 | uint256 | maxFee (CCTP) |
| 164 | 312 | 32 | uint256 | **feeExecuted** |
| 196 | 344 | 32 | uint256 | expirationBlock |
| 228 | 376 | variable | bytes | **hookData** → ForwardParams |

The **minted amount** (what actually gets minted to the recipient) is `amount - feeExecuted`. The `feeExecuted` value is set by the Circle attestation service and represents the CCTP relayer fee.

### Fields used by the indexer

The poller's `validateAttestedMessage` reads:
- **destinationDomain** (abs 8–12): must be 0
- **destinationCaller** (abs 108–140): must be bytes32(0) or routerBytes32
- **mintRecipient** (abs 184–216): last 20 bytes must equal router address
- **amount** (abs 216–248): stored as `amount` in the job

The submitter does NOT parse the message — it passes the raw bytes to the contract.

---

## 14. Circle Iris API Reference

### Endpoint

```
GET <baseUrl>/v2/messages/<sourceDomain>?transactionHash=<txHash>
```

Where:
- `baseUrl`:
  - Testnet: `https://iris-api-sandbox.circle.com`
  - Mainnet: `https://iris-api.circle.com`
- `sourceDomain`: integer CCTP domain ID (e.g. `3` for Arbitrum)
- `txHash`: 0x-prefixed hex transaction hash from the source chain

No authentication required.

### Response format (200 OK)

```json
{
  "messages": [
    {
      "message": "0x00000000...",
      "attestation": "0xabc123...",
      "eventNonce": "12345",
      "status": "complete"
    }
  ]
}
```

- `message`: The full CCTP MessageV2 as 0x-prefixed hex.
- `attestation`: Circle's signature over the message. When pending, this is the literal string `"PENDING"`.
- `eventNonce`: String representation of the nonce (used for record-keeping only, not for on-chain calls).
- `status`: `"complete"` when attestation is ready.

An attestation is ready when `status == "complete"` AND `attestation != "PENDING"`.

### Response codes

| Code | Meaning | Action |
|------|---------|--------|
| 200 | Messages found | Parse body |
| 404 | Transaction not yet indexed | Return Nothing, retry later |
| 429 | Rate limited | Back off 60 seconds |
| Other | API error | Log warning, return Nothing |

### Rate limit

Circle's Iris API allows approximately 35 requests/second. The rate limiter (§7) is configured for 30 req/s burst with 30/s refill to stay safely below this threshold.

---

## 15. XReserveRouter Contract Reference

### Address

Set via `ROUTER_ADDRESS` env var. This is the deployed XReserveRouter contract on Ethereum (mainnet or Sepolia).

### Function: `receiveAndForward`

```solidity
function receiveAndForward(
    bytes calldata message,
    bytes calldata attestation
) external
```

This is the only function the indexer calls. It:
1. Validates the CCTP message (length, destinationDomain, destinationCaller, mintRecipient).
2. Calls `MessageTransmitterV2.receiveMessage(message, attestation)` to mint USDC.
3. Decodes `ForwardParams` from the BurnMessageV2 hookData.
4. Calls `xReserve.depositToRemote(...)` to forward USDC.
5. On xReserve failure: sends USDC to `fallbackRecipient`.
6. On empty/malformed hookData: sends USDC to `operatorWallet`.

### Events

| Event | Meaning | Outcome value |
|-------|---------|---------------|
| `Relayed(uint32 indexed sourceDomain, bytes32 indexed sourceSender, bytes32 indexed nonce, uint256 amount)` | USDC forwarded to xReserve successfully | `"forwarded"` |
| `FallbackTriggered(address indexed fallbackRecipient, uint256 amount)` | xReserve deposit failed; USDC sent to fallback address | `"fallback"` |
| `OperatorRouted(bytes32 indexed transferId, bytes32 indexed nonce, uint256 amount, uint8 reason)` | hookData empty or malformed; USDC sent to operator | `"operator_routed"` |
| `RecoveredFromConsumedNonce(bytes32 indexed nonce, uint256 amount)` | CCTP nonce was already used; router recovered from its own balance | *(informational, appears alongside one of the above)* |

### Revert reasons (terminal errors)

These revert strings indicate the transaction can never succeed and should not be retried:

| Revert string | Meaning |
|---------------|---------|
| `"transfer settled"` | Router's replay guard: this (sourceDomain, nonce) pair was already processed |
| `"Nonce already used"` | CCTP's nonce was consumed AND the router doesn't hold enough balance to recover |
| `"invalid destinationDomain"` | Message is not destined for Ethereum (domain 0) |
| `"invalid destinationCaller"` | Message specifies a different destinationCaller |
| `"invalid mintRecipient"` | Message specifies a different mintRecipient |

---

## 16. Error Catalog

Errors stored in `RelayJob.error`:

| Error | Source | Terminal? | Description |
|-------|--------|-----------|-------------|
| `"attestation_timeout"` | Poller | Yes | No attestation received within `ATTESTATION_TIMEOUT_MS` |
| `"message too short"` | Poller validation | Yes | CCTP message is less than 248 bytes |
| `"destination domain <n> != 0 (Ethereum)"` | Poller validation | Yes | Message targets a different chain |
| `"destinationCaller <hex> != router or zero"` | Poller validation | Yes | Message locked to a different caller |
| `"mintRecipient <addr> != router <routerAddr>"` | Poller validation | Yes | USDC would mint to a different address |
| `"Gas estimation failed: <reason>"` | Submitter | Maybe | Contract would revert — check inner reason |
| `"Tx reverted: <txHash>"` | Submitter | Yes | On-chain transaction reverted (status=0) |
| `"transfer settled"` | Submitter (revert) | Yes | Already processed by the router |
| `"Nonce already used"` | Submitter (revert) | Yes | CCTP nonce consumed, insufficient router balance |
| Other submission errors | Submitter | No (retry) | Network errors, gas price issues, etc. |

---

## 17. Operational Notes

### CCTP Source Domain IDs

These are the valid source domains the API accepts (all CCTP v2 chains except Ethereum which is domain 0, the destination):

| Chain | Domain ID |
|-------|-----------|
| Avalanche | 1 |
| OP Mainnet | 2 |
| Arbitrum | 3 |
| Base | 6 |
| Polygon PoS | 7 |
| Unichain | 10 |
| Linea | 11 |
| Sonic | 13 |
| Soneium | 12 |
| Noble | 14 |
| ZKsync | 15 |
| Ink | 16 |
| Hyperliquid EVM | 18 |
| Monad (testnet) | 19 |
| Abstract | 21 |
| Ronin | 22 |

### MessageTransmitterV2 addresses

| Network | Address |
|---------|---------|
| All mainnets | `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` |
| All testnets | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` |

The `TRANSMITTER_ADDRESS` env var is not used directly by the indexer for on-chain calls (the router contract has the transmitter baked in as an immutable). It's stored in config for operational reference and potential future use (e.g., direct `usedNonces` queries).

### Gas costs

Each `receiveAndForward` call costs approximately 200k–300k gas. At 30 gwei and 300k gas, each relay costs ~0.009 ETH. Monitor the relayer wallet balance and alert when it drops below 0.1 ETH.

### Restart resilience

All state is in SQLite. On restart:
- `pending`/`polling` jobs resume attestation polling.
- `attested` jobs resume Ethereum submission.
- `submitted` jobs will be retried — gas estimation catches already-consumed nonces, and the router's `transfer settled` replay guard prevents double-processing.
- `confirmed`/`failed` are terminal states — no further action.

### Logging

Use structured logging (or at minimum, timestamped text to stderr). Key log lines:

| Level | Message | When |
|-------|---------|------|
| INFO | `"HTTP API listening on port <port>"` | Startup |
| INFO | `"XReserve Relay Indexer started"` | Startup |
| INFO | `"Attestation received for <txHash> (domain <sourceDomain>)"` | Poller: attestation validated |
| INFO | `"Submitted tx <ethTxHash> for <txHash>"` | Submitter: tx broadcast |
| INFO | `"Relay confirmed: <txHash> → <outcome>"` | Submitter: tx confirmed |
| WARN | `"destinationCaller is zero (open) — nonce front-run risk"` | Poller: open caller detected |
| WARN | `"Rate limited by Circle API, backing off 60s"` | Poller: 429 from Iris |
| WARN | `"Operator-routed for <txHash> (empty or malformed hookData)"` | Submitter: OperatorRouted event |
| WARN | `"Nonce-consumed recovery used for <txHash>"` | Submitter: RecoveredFromConsumedNonce event |
| ERROR | `"Submission failed for <txHash>: <message>"` | Submitter: any error |
| ERROR | `"Poller error for <txHash>: <error>"` | Poller: unexpected error |
| ERROR | `"Iris API error: <statusCode>"` | Poller: non-2xx from Circle |
| FATAL | `"Poller fatal error: <error>"` | Poller thread crashed |
| FATAL | `"Submitter fatal error: <error>"` | Submitter thread crashed |

### Thread model

```
Main thread ──┬── Poller thread   (infinite loop, sleeps cfgPollCycleIntervalMs between cycles)
              ├── Submitter thread (infinite loop, sleeps 1s between submissions)
              └── Warp/API thread  (blocks on HTTP accept loop)
```

All three threads share the `Store` (SQLite with WAL mode supports concurrent readers + single writer). The poller and submitter operate on disjoint job statuses, so they do not contend on the same rows.

The shutdown `TVar Bool` is checked at the top of each poller/submitter loop iteration. Setting it to `True` causes both loops to exit on their next iteration (within 1–2 seconds). The API thread is cancelled via `cancel` from the `async` library.
