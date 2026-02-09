# Security Audit Findings

Date: 2026-02-07  
Audited commit: `61a6180aed32673f6c858eb38280a9844891976b`

## Scope

- Smart contract: `contracts/XReserveRouter.sol`
- Indexer: `indexer/src/*.ts`
- Operational docs in `docs/`

Methodology included manual review guided by Trail of Bits skills:

- `audit-context-building`
- `insecure-defaults`
- `sharp-edges`
- `variant-analysis`

## Findings

### 1. High — Pre-claim DoS via txHash-only idempotency key

The indexer uses only `tx_hash` as the primary key and idempotency key. An attacker can submit a victim `txHash` with the wrong `sourceDomain` first. The legitimate request is then blocked by the existing row and cannot be recreated once failed.

Evidence:

- `indexer/src/store.ts` (`tx_hash TEXT PRIMARY KEY`)
- `indexer/src/api.ts` (existing job check by `txHash` only)
- `indexer/src/poller.ts` (failed jobs become terminal)

Impact:

- Legitimate relays can be permanently blocked for a transaction hash.

---

### 2. High — Queue starvation DoS on public relay endpoint

`POST /relay` is unauthenticated and only rate-limited per source IP. Polling processes a bounded batch each cycle (`limit = 20`) and timeout is based on wall-clock job age. Attackers can flood jobs so valid jobs are delayed into timeout.

Evidence:

- `indexer/src/api.ts` (public endpoint + `express-rate-limit`)
- `indexer/src/poller.ts` (`getJobsByStatus(["pending","polling"], 20)`)
- `indexer/src/poller.ts` (`attestationTimeoutMs` age check)

Impact:

- Availability degradation and relay failures (`attestation_timeout`) for legitimate users.

---

### 3. High — `submitted` jobs can strand after restart/crash

Submitter dequeues only `attested` jobs. If the process exits after moving a job to `submitted` but before confirmation handling, that job is not re-picked by normal flow.

Evidence:

- `indexer/src/submitter.ts` (`getOldestByStatus("attested")`)
- `indexer/src/submitter.ts` (state transition to `submitted`)
- `indexer/src/submitter.ts` (confirmation awaited after transition)

Operational mismatch:

- `indexer/RUNNING.md` states `submitted` jobs will be retried after restart; current code path does not enforce that.

Impact:

- Jobs may remain indefinitely stuck without manual intervention.

---

### 4. Medium — Multi-message transactions are partially handled

Iris responses may include multiple messages for one transaction hash. Current code consumes only `messages[0]`, and storage schema allows one job per `tx_hash`, which can leave additional attestations unprocessed.

Evidence:

- `indexer/src/poller.ts` (reads only first message)
- `indexer/src/store.ts` (single row keyed by `tx_hash`)

Impact:

- Partial relay coverage for multi-burn transactions.

---

### 5. Medium — Consumed-nonce recovery relies on exact revert string

Router recovery path requires the revert reason to be exactly `"Nonce already used"`. If transmitter implementation changes revert format (e.g., custom errors), recovery logic breaks even when nonce is actually consumed.

Evidence:

- `contracts/XReserveRouter.sol` (`catch Error(string memory reason)` + string equality check)

Impact:

- Reduced resilience and potential false-negative recovery failures.

---

### 6. Low — Root dependency vulnerability debt

Root dependency audit reports vulnerabilities (including one high-severity advisory path via `@openzeppelin/contracts` version range in use). These are mostly tooling/dev dependency chains but should be tracked and triaged.

Evidence:

- Root `npm audit --json` output
- `package.json` (`@openzeppelin/contracts: ^3.4.2`)

Impact:

- Increased supply-chain risk and maintenance burden.

## Validation Notes

- `npm test` passed (`19 passing`).
- `npm run compile` passed.
- `cd indexer && npm run typecheck` passed.
- `cd indexer && npm audit --json` reported zero vulnerabilities.
- `semgrep` and `codeql` CLIs are not installed in this environment, so those scans were not executed.
