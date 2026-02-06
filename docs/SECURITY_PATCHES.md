# XReserveRouter Security Patches

## Scope

This document records the security patches applied to the relay system during the security review and remediation cycle.

Patched components:

- `contracts/XReserveRouter.sol`
- `contracts/mocks/MockMessageTransmitter.sol`
- `test/XReserveRouter.ts`
- `docs/IMPLEMENTATION_PLAN.md`
- `docs/INDEXER_IMPLEMENTATION_PLAN.md`

## Threat Model Snapshot

The router is permissionless and processes externally supplied CCTP-attested messages. Main risk classes:

- Message-field misuse (forwarding based on wrong / unbound fields)
- Nonce-consumption race conditions (someone else calling `receiveMessage` first)
- Replay-style draining from shared router balances
- Silent ERC20 failures
- Constructor misconfiguration

## Patch Log

## Patch 1: Bind Attested `mintRecipient` To Router (Critical)

Problem:

- The router previously did not enforce that the attested burn message minted to this router.
- A valid message for another recipient could still drive forwarding logic if router held balance.

Fix:

- Parse `mintRecipient` from burn body and require it equals `bytes32(address(this))`.

Code:

- `contracts/XReserveRouter.sol:86`
- `contracts/XReserveRouter.sol:166`
- `contracts/XReserveRouter.sol:168`

Test coverage:

- `test/XReserveRouter.ts:324` (`invalid mintRecipient`)

## Patch 2: Nonce-Consumed Recovery Path (High)

Problem:

- If a third party or forwarding service consumed nonce first via `MessageTransmitterV2.receiveMessage`, funds could be minted to router but normal flow would fail.

Fix:

- Added recovery branch in `receiveAndForward`:
  - try `receiveMessage(message, attestation)`
  - if reverted with `"Nonce already used"`:
    - verify `transmitter.usedNonces(nonce) == 1`
    - settle from router balance using attested `amount - feeExecuted`
  - emit explicit recovery event

Code:

- `contracts/XReserveRouter.sol:18` (`usedNonces` interface)
- `contracts/XReserveRouter.sol:82` (`NONCE_OFFSET`)
- `contracts/XReserveRouter.sol:116` (`RecoveredFromConsumedNonce`)
- `contracts/XReserveRouter.sol:155` (nonce parsing)
- `contracts/XReserveRouter.sol:195`
- `contracts/XReserveRouter.sol:197`
- `contracts/XReserveRouter.sol:205`

Test coverage:

- `test/XReserveRouter.ts:410` (external nonce consumption then recovery forward)

Notes:

- Recovery is intentionally strict: only the consumed-nonce error path is recoverable.
- Other transmitter failures still revert (`receive reverted`).

## Patch 3: One-Time Settlement Replay Guard (High)

Problem:

- Recovery based on router-held balances requires strict replay protection; otherwise repeated calls could drain shared balances.

Fix:

- Added canonical transfer guard `settledTransfers[keccak256(sourceDomain, nonce)]`.
- Transfer is marked settled exactly once before any payout branch execution.

Code:

- `contracts/XReserveRouter.sol:110`
- `contracts/XReserveRouter.sol:178`
- `contracts/XReserveRouter.sol:179`
- `contracts/XReserveRouter.sol:239`

Test coverage:

- `test/XReserveRouter.ts:452` (second call on same transfer reverts `transfer settled`)

## Patch 9: Operator Routing For Empty / Malformed Hook Data (Policy Hardening)

Problem:

- A subset of messages can arrive without decodable `ForwardParams` in BurnMessage hook data.
- Routing behavior needed to be explicit and deterministic for these cases.

Fix:

- Added immutable `operatorWallet`.
- Added explicit operator-routing branches:
  - Empty BurnMessage hook data (`0x`) routes to operator.
  - Malformed/non-decodable BurnMessage hook data routes to operator.
- Added `OperatorRouted` event with transfer identity, nonce, amount, and reason code.

Code:

- `contracts/XReserveRouter.sol:103`
- `contracts/XReserveRouter.sol:131`
- `contracts/XReserveRouter.sol:245`
- `contracts/XReserveRouter.sol:264`

Test coverage:

- `test/XReserveRouter.ts:458`
- `test/XReserveRouter.ts:492`
- `test/XReserveRouter.ts:531`

## Patch 4: Enforce `receiveMessage` Success + Balance-Delta Accounting (Medium)

Problem:

- Relying only on pre-parsed amount is brittle if transmitter behavior deviates.
- Previous code path did not require a true success signal in all cases.

Fix:

- Require normal `receiveMessage` path to return `true`.
- Compute minted value by `balanceAfter - balanceBefore`.
- Enforce equality with attested expected amount.

Code:

- `contracts/XReserveRouter.sol:184`
- `contracts/XReserveRouter.sol:187`
- `contracts/XReserveRouter.sol:188`
- `contracts/XReserveRouter.sol:193`
- `contracts/XReserveRouter.sol:194`

Test coverage:

- `test/XReserveRouter.ts:352` (transmitter returns false -> `receive failed`)

## Patch 5: Guard Solidity 0.7 Arithmetic Boundary (Medium)

Problem:

- Solidity `0.7.6` does not auto-revert on arithmetic overflow/underflow.
- `amount - feeExecuted` must be explicitly bounded.

Fix:

- Require `amount > feeExecuted` before subtraction.

Code:

- `contracts/XReserveRouter.sol:177`

Test coverage:

- `test/XReserveRouter.ts:382` (`invalid fee`)

## Patch 6: Safe ERC20 Operations (Medium/Low)

Problem:

- Raw `approve` / `transfer` can silently fail on non-standard tokens.

Fix:

- Replaced raw token operations with OpenZeppelin `SafeERC20`:
  - `safeApprove` in constructor
  - `safeTransfer` in fallback branch

Code:

- `contracts/XReserveRouter.sol:6`
- `contracts/XReserveRouter.sol:76`
- `contracts/XReserveRouter.sol:138`
- `contracts/XReserveRouter.sol:236`

## Patch 7: Constructor Zero-Address Validation (Low)

Problem:

- Deployment with zero dependency addresses could permanently brick the contract.

Fix:

- Added explicit zero-address checks for transmitter/xReserve/usdc.

Code:

- `contracts/XReserveRouter.sol:128`
- `contracts/XReserveRouter.sol:129`
- `contracts/XReserveRouter.sol:130`

Test coverage:

- `test/XReserveRouter.ts:630`

## Patch 8: Destination Caller Policy + Operational Hardening (High Mitigation)

Problem:

- Open `destinationCaller` burns permit third parties to consume nonce first.

Fix:

- Updated integration/design docs to require production burns set:
  - `destinationCaller = bytes32(uint256(uint160(routerAddress)))`
- Retained consumed-nonce recovery for legacy/open-caller messages.

Docs:

- `docs/IMPLEMENTATION_PLAN.md:38`
- `docs/IMPLEMENTATION_PLAN.md:235`
- `docs/IMPLEMENTATION_PLAN.md:697`
- `docs/INDEXER_IMPLEMENTATION_PLAN.md:40`
- `docs/INDEXER_IMPLEMENTATION_PLAN.md:526`

## Test Summary

Security-relevant tests currently include:

- Invalid fallback recipient
- Invalid mint recipient
- Transmitter returns false
- Invalid fee boundary
- Nonce-consumed recovery path
- Replay block via `transfer settled`
- Constructor zero-address checks

File:

- `test/XReserveRouter.ts`

## Residual Risks / Assumptions

1. Recovery branch currently keys off revert reason `"Nonce already used"`.
2. `xReserve` remains a trust dependency (especially if proxy/upgradable).
3. Recommended operational policy is still required: source burns should set `destinationCaller = router`.
