# XReserveRouter Specification

## 1. Scope

This document is the normative specification for `contracts/XReserveRouter.sol`.

The contract provides a permissionless relay entrypoint that:

1. Receives an attested CCTP v2 message on Ethereum.
2. Mints USDC to the router via `MessageTransmitterV2.receiveMessage`.
3. Routes minted USDC to one of:
   - `xReserve.depositToRemote` (normal path),
   - `fallbackRecipient` (xReserve failure path),
   - `operatorWallet` (policy path for empty or malformed BurnMessage hook data).

This spec is intentionally tied to the current Solidity implementation (`pragma solidity 0.7.6`).

## 2. External Dependencies

The contract depends on:

1. `IMessageTransmitterV2`
   - `receiveMessage(bytes message, bytes attestation) returns (bool)`
   - `usedNonces(bytes32 nonce) returns (uint256)`
2. `IXReserve`
   - `depositToRemote(uint256 value, uint32 remoteDomain, bytes32 remoteRecipient, address localToken, uint256 maxFee, bytes hookData)`
3. `IERC20` (USDC) with OpenZeppelin `SafeERC20`.

Trust assumptions:

1. `transmitter` correctly verifies attestation validity and marks nonce usage.
2. `xReserve` performs downstream domain/token/policy checks.
3. `usdc` behaves as expected under `balanceOf`, `safeApprove`, and `safeTransfer`.

## 3. Data Types

### 3.1 ForwardParams

`ForwardParams` is ABI-encoded in BurnMessageV2 `hookData`.

```solidity
struct ForwardParams {
    address fallbackRecipient;
    uint32  remoteDomain;
    bytes32 remoteRecipient;
    uint256 maxFee;
    bytes   hookData;
}
```

Semantics:

1. `fallbackRecipient` receives USDC if `xReserve.depositToRemote` reverts.
2. `remoteDomain`, `remoteRecipient`, `maxFee`, and `hookData` are passed to xReserve unchanged.

### 3.2 Canonical Transfer Identity

`transferId` is defined as:

`keccak256(abi.encodePacked(sourceDomain, nonce))`

where:

1. `sourceDomain` is parsed from the outer CCTP message at byte offset `[4..8)`.
2. `nonce` is parsed from outer CCTP message at byte offset `[12..44)`.

`transferId` is the replay-protection key.

### 3.3 Why Not Nonce-Only

Settlement identity MUST NOT be keyed by `nonce` alone.

Reason:

1. This router accepts relays from multiple CCTP source domains into Ethereum (`destinationDomain == 0`).
2. `nonce` is not treated here as a globally unique key across all source domains.
3. Two different legitimate transfers can share the same numeric nonce value if they originate from different source domains.

If nonce-only were used:

1. Transfer A: `(sourceDomain = 3, nonce = 42)` settles first.
2. Transfer B: `(sourceDomain = 6, nonce = 42)` would be incorrectly blocked as already settled.
3. Result: false replay detection and denial-of-service for valid transfers.

Therefore, replay protection is keyed by `(sourceDomain, nonce)`.

### 3.4 Why Not MessageHash

Settlement identity MUST NOT be keyed by `keccak256(message)` alone.

Reason:

1. A canonical CCTP transfer may appear in different valid message-byte variants over its attestation/finality lifecycle.
2. `messageHash`-only replay protection can treat those variants as distinct and allow duplicate settlement for the same canonical transfer.

Therefore, canonical transfer identity is `(sourceDomain, nonce)`, not `messageHash`.

## 4. Constants and Message Parsing

### 4.1 Outer MessageV2 Offsets

1. `SOURCE_DOMAIN_OFFSET = 4`
2. `DESTINATION_DOMAIN_OFFSET = 8`
3. `NONCE_OFFSET = 12`
4. `DESTINATION_CALLER_OFFSET = 108`
5. `MSG_BODY_OFFSET = 148`

### 4.2 BurnMessageV2 Absolute Offsets

Absolute offsets are relative to the full message:

1. `MINT_RECIPIENT_OFFSET = 184` (`148 + 36`)
2. `AMOUNT_OFFSET = 216` (`148 + 68`)
3. `FEE_EXECUTED_OFFSET = 312` (`148 + 164`)
4. `HOOK_DATA_OFFSET = 376` (`148 + 228`)

Other constants:

1. `MIN_MESSAGE_LENGTH = 376`
2. `ETHEREUM_CCTP_DOMAIN = 0`
3. `NONCE_USED = 1`
4. `OPERATOR_ROUTE_EMPTY_HOOK_DATA = 1`
5. `OPERATOR_ROUTE_MALFORMED_HOOK_DATA = 2`

## 5. State Variables

### 5.1 Immutables

1. `transmitter: IMessageTransmitterV2`
2. `xReserve: IXReserve`
3. `usdc: IERC20`
4. `operatorWallet: address`

### 5.2 Mappings

1. `settledTransfers: mapping(bytes32 => bool)`
   - true means canonical transfer (`sourceDomain + nonce`) has already been settled exactly once.

## 6. Constructor Specification

Signature:

`constructor(address _transmitter, address _xReserve, address _usdc, address _operatorWallet)`

### 6.1 Preconditions

Must revert if any is zero:

1. `_transmitter` -> `"zero transmitter"`
2. `_xReserve` -> `"zero xReserve"`
3. `_usdc` -> `"zero usdc"`
4. `_operatorWallet` -> `"zero operator"`

### 6.2 Postconditions

1. Immutables are set to input addresses.
2. Router grants infinite USDC approval to `xReserve`:
   - `usdc.safeApprove(_xReserve, type(uint256).max)`

## 7. Public API

### 7.1 `receiveAndForward(bytes message, bytes attestation)`

Permissionless. Anyone may call.

#### 7.1.1 Validation Phase

The function MUST enforce:

1. `message.length >= 376`, else `"message too short"`.
2. `destinationDomain == 0`, else `"invalid destinationDomain"`.
3. `destinationCaller == 0 || destinationCaller == bytes32(routerAddress)`, else `"invalid destinationCaller"`.
4. `settledTransfers[transferId] == false`, else `"transfer settled"`.
5. `mintRecipient == bytes32(routerAddress)`, else `"invalid mintRecipient"`.
6. `amount > feeExecuted`, else `"invalid fee"`.

`expectedMintedAmount = amount - feeExecuted`.

#### 7.1.2 Mint/Recovery Phase

The function attempts:

`transmitter.receiveMessage(message, attestation)`

Normal path:

1. Return value MUST be `true`, else `"receive failed"`.
2. `mintedAmount = usdc.balanceOf(this)_after - usdc.balanceOf(this)_before`.
3. `mintedAmount` MUST equal `expectedMintedAmount`, else `"mint mismatch"`.

Consumed-nonce recovery path:

1. Catch `Error(string reason)`.
2. `reason` MUST equal `"Nonce already used"`, else `"receive reverted"`.
3. `transmitter.usedNonces(nonce) == 1`, else `"nonce not used"`.
4. `usdc.balanceOf(this) >= expectedMintedAmount`, else `"insufficient recovered"`.
5. `mintedAmount = expectedMintedAmount`.
6. Emit `RecoveredFromConsumedNonce(nonce, mintedAmount)`.

Other errors:

1. Any non-`Error(string)` catch reverts `"receive reverted"`.

After either mint/recovery path:

1. `mintedAmount > 0`, else `"zero minted amount"`.
2. Dispatch to `_settleAndRoute(transferId, nonce, mintedAmount, message[HOOK_DATA_OFFSET:])`.

### 7.2 `decodeForwardParams(bytes rawHookData) external pure`

Pure decode helper:

`abi.decode(rawHookData, (ForwardParams))`

Used through `try this.decodeForwardParams(...)` so malformed hook data can be caught and operator-routed.

## 8. Routing Policy and Settlement

### 8.1 `_settleAndRoute`

Order of operations:

1. Marks `settledTransfers[transferId] = true` before outbound transfer/calls.
2. Applies policy:
   - If `rawHookData.length == 0`:
     - `usdc.safeTransfer(operatorWallet, mintedAmount)`
     - emit `OperatorRouted(transferId, nonce, mintedAmount, 1)`
     - return.
   - Else try decode `ForwardParams`:
     - Decode success:
       - Require `params.fallbackRecipient != address(0)`, else `"zero fallback"`.
       - Try `xReserve.depositToRemote(...)`.
       - If success: emit `Forwarded(params.remoteDomain, params.remoteRecipient, mintedAmount)`.
       - If revert: `usdc.safeTransfer(params.fallbackRecipient, mintedAmount)` and emit `FallbackTriggered(params.fallbackRecipient, mintedAmount)`.
     - Decode failure:
       - `usdc.safeTransfer(operatorWallet, mintedAmount)`
       - emit `OperatorRouted(transferId, nonce, mintedAmount, 2)`.

### 8.2 Policy Semantics

`OperatorRouted.reason`:

1. `1`: Empty BurnMessage hook data (`0x`)
2. `2`: Malformed/non-decodable BurnMessage hook data

This behavior is intentional custody policy, not a decode error revert.

## 9. Events

### 9.1 `Forwarded`

Emitted when xReserve call succeeds.

Fields:

1. `remoteDomain`
2. `remoteRecipient`
3. `amount`

### 9.2 `FallbackTriggered`

Emitted when xReserve call reverts and fallback transfer succeeds.

Fields:

1. `fallbackRecipient`
2. `amount`

### 9.3 `RecoveredFromConsumedNonce`

Emitted when transmitter path indicates nonce was already consumed and router settles from existing balance.

Fields:

1. `nonce`
2. `amount`

### 9.4 `OperatorRouted`

Emitted when policy routes to operator wallet.

Fields:

1. `transferId`
2. `nonce`
3. `amount`
4. `reason` (`1` or `2`)

## 10. Revert/Error Matrix

`receiveAndForward` can revert with:

1. `"message too short"`
2. `"invalid destinationDomain"`
3. `"invalid destinationCaller"`
4. `"transfer settled"`
5. `"invalid mintRecipient"`
6. `"invalid fee"`
7. `"receive failed"`
8. `"balance mismatch"`
9. `"mint mismatch"`
10. `"receive reverted"`
11. `"nonce not used"`
12. `"insufficient recovered"`
13. `"zero minted amount"`
14. `"zero fallback"`

Constructor can revert with:

1. `"zero transmitter"`
2. `"zero xReserve"`
3. `"zero usdc"`
4. `"zero operator"`

## 11. Security Invariants

The implementation enforces these invariants:

1. A transfer identity `(sourceDomain, nonce)` is settled at most once.
2. Relay can only process messages targeting Ethereum domain (`destinationDomain == 0`).
3. Relay only accepts `destinationCaller` open (`0`) or self-bound to router address.
4. Relay only accepts burn messages whose `mintRecipient` is router.
5. Normal mint path forwards only observed minted delta and must match attested amount minus fee.
6. Consumed-nonce recovery requires both specific nonce-used revert reason and `usedNonces(nonce) == 1`.
7. Settlement amount is always capped at attested `amount - feeExecuted`.
8. Empty/malformed routing payloads are deterministically routed to `operatorWallet`.

## 12. Operational Requirements

Integration SHOULD enforce:

1. Source burns set `mintRecipient = bytes32(routerAddress)`.
2. Source burns set `destinationCaller = bytes32(routerAddress)` for strictness (although router allows zero for compatibility).
3. `operatorWallet` is a controlled operational wallet (prefer multisig).
4. Monitoring consumes all four router outcomes:
   - `Forwarded`
   - `FallbackTriggered`
   - `RecoveredFromConsumedNonce`
   - `OperatorRouted`

## 13. Non-Goals

This contract does not:

1. Validate xReserve `remoteDomain`/`remoteRecipient` policy beyond forwarding parameters.
2. Recover arbitrary ERC20/native balances by admin sweep.
3. Expose pausing, owner controls, or role-based access control.
4. Support non-USDC local tokens.

## 14. Compatibility Notes

1. Solidity version is pinned to `0.7.6`.
2. Arithmetic safety for `amount - feeExecuted` is explicit (`amount > feeExecuted`).
3. Decoding malformed hook data is intentionally catchable through external self-call (`this.decodeForwardParams`) rather than direct inline decode.
