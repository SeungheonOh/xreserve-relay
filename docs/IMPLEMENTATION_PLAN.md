# XReserveRouter Implementation Plan

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Protocol Background](#2-protocol-background)
3. [Architecture](#3-architecture)
4. [Message Format Reference](#4-message-format-reference)
5. [Contract Design](#5-contract-design)
6. [Implementation Steps](#6-implementation-steps)
7. [Testing Strategy](#7-testing-strategy)
8. [Deployment](#8-deployment)

---

## 1. Project Overview

### Purpose

XReserveRouter is a permissionless relay contract deployed on Ethereum that enables atomic bridging of USDC from any CCTP-supported chain to xReserve partner chains in a single transaction.

It sits between two Circle protocols:

- **CCTP v2** (Cross-Chain Transfer Protocol): Burns USDC on a source chain and mints it on Ethereum.
- **xReserve**: Locks USDC in reserve on Ethereum and triggers minting of a USDC-backed token (e.g., USDCx) on a partner chain where native USDC does not exist.

The router receives USDC minted by CCTP, then atomically forwards it into xReserve to continue the journey to the final destination chain.

### End-to-End User Flow

```
Chain A (Arbitrum, Base, etc.)        Ethereum                          Chain C (xReserve partner)
──────────────────────────────        ────────                          ──────────────────────────
1. User encodes ForwardParams
   as CCTP BurnMessageV2 hookData

2. User calls CCTP depositForBurn()
   (with destinationCaller = router)
   → USDC burned on Chain A
   → CCTP attestation generated
   by Circle's off-chain infra
                                      3. Relayer calls
                                         router.receiveAndForward(
                                           message, attestation)

                                      4. Router calls
                                         transmitter.receiveMessage()
                                         → USDC minted to router

                                      5. Router parses BurnMessageV2
                                         from the CCTP message:
                                         - amount, feeExecuted
                                         - hookData → ForwardParams

                                      6a. try: xReserve.depositToRemote()
                                          → USDC locked in reserve
                                          → DepositedToRemote event     →  7. xReserve off-chain infra
                                                                              generates DepositAttestation
                                                                           8. USDCx minted to
                                                                              remoteRecipient

                                      6b. catch: USDC transferred
                                          to fallbackRecipient

                                      6c. if nonce already consumed:
                                          router verifies nonce is used
                                          and settles from stranded router balance
```

---

## 2. Protocol Background

### 2.1 CCTP v2 (Cross-Chain Transfer Protocol)

CCTP is Circle's native burn-and-mint protocol for transferring USDC across chains where USDC is natively deployed.

**Key contracts on each chain:**

| Contract | Role |
|----------|------|
| `TokenMessengerV2` | Entry point for burning (source) and minting (destination). The `sender` and `recipient` fields in the message envelope refer to TokenMessengerV2 addresses. |
| `MessageTransmitterV2` | Handles message validation, attestation signature verification, nonce tracking, and routing to the recipient contract. |
| `TokenMinterV2` | Performs the actual ERC-20 `mint()` calls. Maps remote burn tokens to local mint tokens. |

**Burn flow (source chain):**

1. User calls `TokenMessengerV2.depositForBurnWithHook()` with amount, destination domain, mint recipient, destination caller, max fee, and hook data.
2. TokenMessengerV2 burns the user's USDC.
3. MessageTransmitterV2 emits a `MessageSent` event containing the full serialized message.
4. Circle's off-chain attestation service observes the event, fills in `feeExecuted` and `expirationBlock`, and produces a signed attestation.

**Mint flow (destination chain):**

1. A relayer calls `MessageTransmitterV2.receiveMessage(message, attestation)`.
2. MessageTransmitterV2 verifies attestation signatures, checks the nonce is unused, marks it used.
3. Routes to `TokenMessengerV2.handleReceiveFinalizedMessage()` (or unfinalized variant).
4. TokenMessengerV2 parses the BurnMessageV2 body, validates fee constraints.
5. TokenMinterV2 mints:
   - `amount - feeExecuted` tokens to the `mintRecipient`
   - `feeExecuted` tokens to the protocol's `feeRecipient` (a Circle-controlled address, NOT the relayer)

**Fee mechanics:**

| Field | Set by | Description |
|-------|--------|-------------|
| `maxFee` | User at burn time | Upper bound on the fee the user agrees to pay |
| `feeExecuted` | Circle's attestation service (off-chain) | Actual fee charged, between 0 and maxFee |

On-chain enforcement: `feeExecuted == 0 || feeExecuted < amount` and `feeExecuted <= maxFee`.

The relayer who calls `receiveMessage()` receives no on-chain fee from CCTP. Their incentive is external.

### 2.2 xReserve Protocol

xReserve is Circle's infrastructure for deploying USDC-backed tokens on partner chains where native USDC is not available.

**Source:** `https://github.com/circlefin/evm-xreserve-contracts` (commit `a571cbe`)

**Key concepts:**

- USDC is held in reserve on source chains (e.g., Ethereum) inside a `GatewayWallet`.
- Partner chains deploy their own USDC-backed tokens.
- Cross-chain transfers are authorized through cryptographic attestations generated by Circle's off-chain systems.
- `remoteDomain` is Circle's operator-issued domain identifier. It is NOT a chain ID.

**`depositToRemote` function:**

```solidity
function depositToRemote(
    uint256 value,
    uint32 remoteDomain,
    bytes32 remoteRecipient,
    address localToken,
    uint256 maxFee,
    bytes calldata hookData
) external nonReentrant
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `value` | `uint256` | Amount of tokens to deposit. Must be > 0. |
| `remoteDomain` | `uint32` | xReserve domain ID for the partner chain (not a chain ID). |
| `remoteRecipient` | `bytes32` | Recipient address on the partner chain, left-padded bytes32. For EVM: `bytes32(uint256(uint160(addr)))`. Checked against a blocklist. |
| `localToken` | `address` | ERC-20 token to deposit (e.g., USDC on Ethereum). Must be a supported token registered in xReserve. |
| `maxFee` | `uint256` | Max fee budget for the xReserve relayer on the partner chain. The USDCx contract on the partner chain requires `amount >= maxFee`. |
| `hookData` | `bytes` | Optional arbitrary data. If a `remoteDomainHookExecutor` is configured, it is called with the full deposit params. Also included in the attestation for use by the partner chain. |

**Internal flow of `depositToRemote`:**

1. **Validation**: value > 0, localToken != address(0), contract not paused, domain not paused, domain registered, token supported, recipient not blocklisted, remote token mapping exists.
2. **Token pull**: `IERC20(localToken).safeTransferFrom(msg.sender, address(this), value)`. The caller (our router) must hold the tokens and have approved xReserve.
3. **Event**: Emits `DepositedToRemote` with all deposit details.
4. **Reserve**: Transfers tokens to `GatewayWallet` via a per-domain `remoteDomainDepositor` contract.
5. **Hook**: If configured, calls `IRemoteDomainHookExecutor.executeHook(depositParams)`. Reverts the entire tx if hook reverts.

**Key detail**: `msg.sender` becomes the `localDepositor`. When our router calls `depositToRemote`, the router's address is the depositor — not the original user.

---

## 3. Architecture

### 3.1 Contract Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                       XReserveRouter                            │
│                                                                 │
│  Immutables:                                                    │
│    transmitter : IMessageTransmitterV2                          │
│    xReserve    : IXReserve                                      │
│    usdc        : IERC20                                         │
│                                                                 │
│  Constructor:                                                   │
│    Sets immutables                                              │
│    Approves USDC to xReserve (type(uint256).max)                │
│                                                                 │
│  receiveAndForward(message, attestation):                       │
│    1. Parse BurnMessageV2 from message (byte 148 onward)        │
│    2. Compute mintedAmount = amount - feeExecuted               │
│    3. ABI-decode hookData as ForwardParams                      │
│    4. Call transmitter.receiveMessage(message, attestation)      │
│    5. try xReserve.depositToRemote(...)                         │
│       catch → usdc.transfer(fallbackRecipient, mintedAmount)    │
│    6. Emit Forwarded or FallbackTriggered event                 │
│                                                                 │
│  Events:                                                        │
│    Forwarded(remoteDomain, remoteRecipient, amount)             │
│    FallbackTriggered(fallbackRecipient, amount)                 │
└─────────────────────────────────────────────────────────────────┘
         │                              │
         │ receiveMessage()             │ depositToRemote()
         ▼                              ▼
┌─────────────────────┐     ┌──────────────────────┐
│ MessageTransmitterV2│     │       xReserve        │
│                     │     │                       │
│ Verifies attestation│     │ Pulls USDC from router│
│ Marks nonce used    │     │ Locks in GatewayWallet│
│ Routes to           │     │ Emits DepositedToRemote│
│ TokenMessengerV2    │     └──────────────────────┘
│ → Mints USDC to     │
│   mintRecipient     │
│   (the router)      │
└─────────────────────┘
```

### 3.2 ForwardParams Struct

The user on the source chain ABI-encodes this struct as the CCTP `hookData` when calling `depositForBurn`:

```solidity
struct ForwardParams {
    address fallbackRecipient;   // Where USDC goes if depositToRemote fails
    uint32  remoteDomain;        // xReserve domain ID for the partner chain
    bytes32 remoteRecipient;     // Who receives USDCx on the partner chain
    uint256 maxFee;              // Fee budget for xReserve relayer on partner chain
    bytes   hookData;            // Optional data for xReserve remote domain hook executor
}
```

Encoding on the source chain (off-chain or from a helper contract):

```solidity
bytes memory forwardParams = abi.encode(
    ForwardParams({
        fallbackRecipient: 0x...,
        remoteDomain: 7,          // example xReserve domain ID
        remoteRecipient: bytes32(uint256(uint160(recipientAddr))),
        maxFee: 1e6,              // 1 USDC
        hookData: ""
    })
);

// Pass forwardParams as the hookData to CCTP's depositForBurn.
// IMPORTANT: set destinationCaller = bytes32(uint256(uint160(routerAddress)))
// in the burn call to prevent third-party nonce consumption.
tokenMessengerV2.depositForBurnWithHook(
    amount,
    ETHEREUM_DOMAIN,             // CCTP destination domain (Ethereum)
    bytes32(uint256(uint160(routerAddress))),  // mintRecipient = our router
    address(usdc),
    maxCctpFee,
    forwardParams                // encoded ForwardParams as CCTP hookData
);
```

---

## 4. Message Format Reference

### 4.1 Outer CCTP MessageV2 Envelope

The `message` bytes passed to `receiveMessage()` are `abi.encodePacked` — tightly packed, no ABI padding, no length prefixes between fixed fields.

```
Byte Offset   Size    Type       Field
──────────────────────────────────────────────────────
0             4       uint32     version (outer message version)
4             4       uint32     sourceDomain
8             4       uint32     destinationDomain
12            32      bytes32    nonce
44            32      bytes32    sender (TokenMessengerV2 on source chain)
76            32      bytes32    recipient (TokenMessengerV2 on Ethereum)
108           32      bytes32    destinationCaller (set to router for production)
140           4       uint32     minFinalityThreshold
144           4       uint32     finalityThresholdExecuted
──────────────────────────────────────────────────────
148                              ← messageBody (BurnMessageV2) starts here
```

**Header size: 148 bytes (fixed).**

Source: `circlefin/evm-cctp-contracts/src/messages/v2/MessageV2.sol`

### 4.2 Inner BurnMessageV2 (the messageBody)

Starting at byte 148 of the full message:

```
Offset within    Absolute     Size    Type       Field
body             offset
──────────────────────────────────────────────────────────────
0                148          4       uint32     version (burn message version)
4                152          32      bytes32    burnToken (source chain token addr)
36               184          32      bytes32    mintRecipient (our router address)
68               216          32      uint256    amount (total burned)
100              248          32      bytes32    messageSender
132              280          32      uint256    maxFee (CCTP relay fee budget)
164              312          32      uint256    feeExecuted (actual CCTP fee, set by attester)
196              344          32      uint256    expirationBlock (set by attester)
228              376          var     bytes      hookData (our ForwardParams)
──────────────────────────────────────────────────────────────
```

**Minimum body size: 228 bytes (with empty hookData).**
**Minimum total message size: 148 + 228 = 376 bytes.**

Source: `circlefin/evm-cctp-contracts/src/messages/v2/BurnMessageV2.sol`

### 4.3 Parsing in Solidity

The existing codebase uses `TypedMemView` (a zero-copy memory view library from summa-tx) which operates on `bytes29` typed views. The BurnMessageV2 library's getter functions (e.g., `_getAmount`, `_getFeeExecuted`, `_getHookData`) expect a view over just the **burn message body**, not the full outer message.

To extract the body from the full message:

```solidity
using TypedMemView for bytes;
using TypedMemView for bytes29;

uint256 constant MESSAGE_BODY_INDEX = 148;

bytes memory m = message;                       // calldata → memory
bytes29 fullView = m.ref(0);                    // view over full message

// Slice to get only the burn message body (byte 148 onward)
bytes29 burnBody = fullView.slice(
    MESSAGE_BODY_INDEX,
    fullView.len() - MESSAGE_BODY_INDEX,
    0
);

uint256 amount       = BurnMessageV2._getAmount(burnBody);        // offset 68 within body
uint256 feeExecuted  = BurnMessageV2._getFeeExecuted(burnBody);   // offset 164 within body
bytes29 hookDataView = BurnMessageV2._getHookData(burnBody);      // offset 228+ within body
```

**Alternative: direct calldata slicing (cheaper, no TypedMemView):**

```solidity
// Extract burn body as calldata slice
bytes calldata burnBody = message[148:];

// Read fixed fields with abi.decode or manual offset reads
uint256 amount      = uint256(bytes32(burnBody[68:100]));
uint256 feeExecuted = uint256(bytes32(burnBody[164:196]));
bytes calldata hookData = burnBody[228:];

// ABI-decode hookData into ForwardParams
ForwardParams memory params = abi.decode(hookData, (ForwardParams));
```

The calldata slicing approach avoids copying to memory and is more gas-efficient. However, it requires Solidity >=0.6.0 calldata slicing support. Since the project uses Solidity 0.7.6, both approaches work.

### 4.4 Key Parsing Detail: Why the Current Code is Wrong

The current code at `contracts/xReserveRelay.sol:59-62`:

```solidity
bytes memory m = message;
bytes29 view_ = m.ref(0);
uint256 burnAmount = BurnMessageV2._getAmount(view_);
```

This creates a view over the **entire** CCTP message and calls `_getAmount()` which reads at offset 68. But offset 68 in the full message falls inside the outer header's `sender` field (bytes 44-76). The actual `amount` is at absolute offset 216 (= 148 + 68).

The fix is to slice at byte 148 first, then call `_getAmount` on the resulting body view.

---

## 5. Contract Design

### 5.1 Complete Interface

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.7.6;
pragma abicoder v2;

interface IMessageTransmitterV2 {
    function receiveMessage(
        bytes calldata message,
        bytes calldata attestation
    ) external returns (bool);

    function usedNonces(bytes32 nonce) external view returns (uint256);
}

interface IXReserve {
    function depositToRemote(
        uint256 value,
        uint32 remoteDomain,
        bytes32 remoteRecipient,
        address localToken,
        uint256 maxFee,
        bytes calldata hookData
    ) external;
}

struct ForwardParams {
    address fallbackRecipient;
    uint32  remoteDomain;
    bytes32 remoteRecipient;
    uint256 maxFee;
    bytes   hookData;
}

contract XReserveRouter {
    // --- Immutables ---
    IMessageTransmitterV2 public immutable transmitter;
    IXReserve             public immutable xReserve;
    IERC20                public immutable usdc;
    address               public immutable operatorWallet;
    mapping(bytes32 => bool) public settledTransfers;

    // --- Events ---
    event Forwarded(
        uint32  indexed remoteDomain,
        bytes32 indexed remoteRecipient,
        uint256 amount
    );

    event FallbackTriggered(
        address indexed fallbackRecipient,
        uint256 amount
    );

    event RecoveredFromConsumedNonce(
        bytes32 indexed nonce,
        uint256 amount
    );

    event OperatorRouted(
        bytes32 indexed transferId,
        bytes32 indexed nonce,
        uint256 amount,
        uint8 reason
    );

    // --- Constructor ---
    // Accepts transmitter, xReserve, USDC, and operatorWallet addresses.
    // Auto-approves USDC to xReserve (type(uint256).max).

    // --- Core Function ---
    function receiveAndForward(
        bytes calldata message,
        bytes calldata attestation
    ) external;
}
```

### 5.2 `receiveAndForward` Logic (Pseudocode)

```
function receiveAndForward(message, attestation):
    require(message.length >= 376, "message too short")
    sourceDomain = uint32(message[4:8])
    destinationDomain = uint32(message[8:12])
    require(destinationDomain == 0, "invalid destinationDomain")
    nonce = bytes32(message[12:44])
    destinationCaller = bytes32(message[108:140])
    require(destinationCaller == bytes32(0) || destinationCaller == bytes32(router), "invalid destinationCaller")

    transferId = keccak256(abi.encodePacked(sourceDomain, nonce))
    require(!settledTransfers[transferId], "transfer settled")

    // Read amount (offset 68 in body, 32 bytes)
    amount = uint256(bytes32(burnBody[68:100]))

    // Read feeExecuted (offset 164 in body, 32 bytes)
    feeExecuted = uint256(bytes32(burnBody[164:196]))
    // CCTP requires amount > feeExecuted
    require(amount > feeExecuted, "invalid fee")
    expectedMinted = amount - feeExecuted

    // ── Step 2: Mint USDC to this contract via CCTP ──
    // Normal path: receiveMessage succeeds and mints now.
    // Recovery path: nonce already used by an external caller,
    // but the attested message is still settled once via this router.
    balanceBefore = usdc.balanceOf(address(this))
    try transmitter.receiveMessage(message, attestation) returns (ok):
        require(ok, "receive failed")
        balanceAfter = usdc.balanceOf(address(this))
        mintedAmount = balanceAfter - balanceBefore
        require(mintedAmount == expectedMinted, "mint mismatch")
    catch Error(reason):
        require(reason == "Nonce already used", "receive reverted")
        require(transmitter.usedNonces(nonce) == 1, "nonce not used")
        require(usdc.balanceOf(address(this)) >= expectedMinted, "insufficient recovered")
        mintedAmount = expectedMinted
        emit RecoveredFromConsumedNonce(nonce, mintedAmount)
    catch:
        revert("receive reverted")

    require(mintedAmount > 0, "zero minted amount")
    settledTransfers[transferId] = true

    rawHookData = message[376:]
    if rawHookData.length == 0:
        usdc.safeTransfer(operatorWallet, mintedAmount)
        emit OperatorRouted(transferId, nonce, mintedAmount, 1) // empty hookData
        return

    try this.decodeForwardParams(rawHookData) returns (params):
        require(params.fallbackRecipient != address(0), "zero fallback")

        // ── Step 3: Forward to xReserve or fallback ──
        try xReserve.depositToRemote(...) {
            emit Forwarded(...)
        } catch {
            usdc.safeTransfer(params.fallbackRecipient, mintedAmount)
            emit FallbackTriggered(...)
        }
    catch:
        usdc.safeTransfer(operatorWallet, mintedAmount)
        emit OperatorRouted(transferId, nonce, mintedAmount, 2) // malformed hookData
```

### 5.3 Constructor Logic

```
constructor(_transmitter, _xReserve, _usdc, _operatorWallet):
    require(_transmitter != address(0), "zero transmitter")
    require(_xReserve != address(0), "zero xReserve")
    require(_usdc != address(0), "zero usdc")
    require(_operatorWallet != address(0), "zero operator")

    transmitter = IMessageTransmitterV2(_transmitter)
    xReserve    = IXReserve(_xReserve)
    usdc        = IERC20(_usdc)
    operatorWallet = _operatorWallet

    // Approve xReserve to pull USDC from this contract
    // xReserve calls safeTransferFrom(msg.sender, ...) internally
    IERC20(_usdc).safeApprove(address(_xReserve), type(uint256).max)
```

### 5.4 Design Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Amount source | Balance delta around `receiveMessage` + equality check against `amount - feeExecuted` | Prevents forwarding stale router balances while still binding to attested fields. |
| xReserve params source | ABI-decoded from BurnMessageV2 `hookData` as `ForwardParams` struct | User encodes intent at burn time. No off-chain relayer param injection needed. |
| Failure handling | try/catch with `safeTransfer` fallback + operator routing for empty/malformed hook payloads | Valid routing data goes to xReserve/fallback; invalid routing payloads are routed to operatorWallet. |
| Idempotency | `settledTransfers[keccak256(sourceDomain,nonce)]` | Prevents replay and re-attestation variants from settling more than once. |
| Consumed nonce recovery | Special branch for `"Nonce already used"` + `usedNonces(nonce) == 1` | Allows settlement when someone else consumed nonce first but funds were minted to router. |
| Function parameters | Only `(bytes message, bytes attestation)` | All routing info is embedded in the message. Permissionless relayers need no domain knowledge. |
| USDC address | Immutable in constructor | Gas-efficient. The local USDC address on Ethereum never changes regardless of source chain. |
| Operator route | Immutable `operatorWallet` | Empty/malformed BurnMessage hookData is treated as operator custody by policy. |
| Fee validation | Pass through to xReserve | xReserve's `depositToRemote` validates internally. Failure triggers the catch block and fallback. |
| Events | `Forwarded`, `FallbackTriggered`, `RecoveredFromConsumedNonce`, `OperatorRouted` | Enables off-chain monitoring and settlement classification. |
| Approval | Constructor auto-approve (max uint256) | One less operational step. Immutable xReserve address means the approval target never changes. |
| Access control | None (permissionless) | CCTP attestation is the authorization. Anyone can relay a signed message. |
| Token scope | USDC only | Constructor immutable. Partner scope is CCTP USDC → xReserve USDC. |
| Solidity version | 0.7.6 | Matches Circle's CCTP v2 and BurnMessageV2 library dependencies. |

---

## 6. Implementation Steps

### Step 1: Project Setup — Hardhat Configuration

Create `hardhat.config.js` (or `.ts`) with:

- Solidity 0.7.6 compiler
- Paths configured for the existing `contracts/` directory
- Dependency remappings for:
  - `@openzeppelin/contracts` → `node_modules/@openzeppelin/contracts` (need to install `@openzeppelin/contracts@3.x` for 0.7.6 compatibility)
  - `@memview-sol/` → the local `@memview-sol/` directory or `.deps/`
  - `github.com/circlefin/evm-cctp-contracts/` → `.deps/github/circlefin/evm-cctp-contracts/`
- Networks: `sepolia` and `mainnet` (with env-based RPC URLs and private keys)

**Dependencies to install:**

```
npm install --save-dev @nomiclabs/hardhat-ethers ethers @openzeppelin/contracts@3.4.2
```

Note: OpenZeppelin 3.x is required for Solidity 0.7.6 compatibility. OZ 4.x+ requires Solidity 0.8.x.

### Step 2: Rewrite the Contract

Replace `contracts/xReserveRelay.sol` with the new design:

1. **Remove** the old `receiveAndForward` with 8 parameters.
2. **Remove** the `approveToken()` function.
3. **Add** the `ForwardParams` struct.
4. **Add** the `usdc` immutable and constructor parameter.
5. **Add** USDC approval in constructor.
6. **Add** the new `receiveAndForward(bytes calldata message, bytes calldata attestation)`.
7. **Add** `Forwarded` and `FallbackTriggered` events.
8. **Implement** BurnMessageV2 body extraction (slice at byte 148).
9. **Implement** amount and feeExecuted parsing from the body.
10. **Implement** hookData extraction and ABI-decode into ForwardParams.
11. **Implement** try/catch with fallback transfer.

**Parsing approach decision — two options:**

**Option A: TypedMemView (current dependency)**

Uses the existing `BurnMessageV2` library with `TypedMemView`. Requires copying calldata to memory, then creating views.

```solidity
bytes memory m = message;
bytes29 fullView = m.ref(0);
bytes29 burnBody = fullView.slice(148, fullView.len() - 148, 0);

uint256 amount      = BurnMessageV2._getAmount(burnBody);
uint256 feeExecuted = BurnMessageV2._getFeeExecuted(burnBody);
bytes29 hookView    = BurnMessageV2._getHookData(burnBody);

// Convert hookData view to bytes memory for abi.decode
bytes memory hookBytes = hookView.clone();
ForwardParams memory params = abi.decode(hookBytes, (ForwardParams));
```

Pros: Reuses Circle's own parsing library, less room for offset errors.
Cons: Memory copies, slightly more gas, dependency on TypedMemView.

**Option B: Direct calldata slicing**

```solidity
uint256 amount      = uint256(bytes32(message[216:248]));   // 148 + 68
uint256 feeExecuted = uint256(bytes32(message[312:344]));   // 148 + 164
bytes calldata hookData = message[376:];                    // 148 + 228

ForwardParams memory params = abi.decode(hookData, (ForwardParams));
```

Pros: No memory copies, gas-efficient, no TypedMemView dependency.
Cons: Hardcoded offsets, must be carefully validated.

**Recommendation:** Option A for safety (uses Circle's battle-tested library), with inline comments documenting the absolute offsets for clarity.

### Step 3: Add Events

```solidity
event Forwarded(
    uint32  indexed remoteDomain,
    bytes32 indexed remoteRecipient,
    uint256 amount
);

event FallbackTriggered(
    address indexed fallbackRecipient,
    uint256 amount
);
```

### Step 4: Write Tests

See [Testing Strategy](#7-testing-strategy) below.

### Step 5: Write Deployment Script

See [Deployment](#8-deployment) below.

### Step 6: Clean Up Artifacts

The `artifacts/` directory currently contains Remix IDE compilation artifacts. Once Hardhat is configured, these will be regenerated by `npx hardhat compile`. The old Remix artifacts can be removed or moved to an archive directory.

---

## 7. Testing Strategy

### 7.1 Unit Tests

All tests should use Hardhat with mock contracts for `MessageTransmitterV2` and `xReserve`.

**Mock contracts needed:**

1. **MockMessageTransmitterV2**: Implements `receiveMessage()`. On call, mints mock USDC to the caller's specified `mintRecipient`. Simulates the CCTP mint.

2. **MockXReserve**: Implements `depositToRemote()`. Records call arguments for assertion. Can be configured to revert (to test fallback path).

3. **MockUSDC**: A standard ERC-20 with public `mint()` function for test setup. (Can use OpenZeppelin's ERC20 with a mint function.)

**Test cases:**

| # | Test | Description |
|---|------|-------------|
| 1 | Happy path | Construct a valid CCTP message with ForwardParams in hookData. Call `receiveAndForward`. Assert: MockXReserve received correct `depositToRemote` args, `Forwarded` event emitted with correct values. |
| 2 | Fee deduction | Set `feeExecuted = 100` in the message. Assert: `depositToRemote` is called with `amount - 100`. |
| 3 | Fallback on xReserve failure | Configure MockXReserve to revert. Assert: USDC transferred to `fallbackRecipient`, `FallbackTriggered` event emitted. |
| 4 | Zero fallback address | Encode `fallbackRecipient = address(0)` in ForwardParams. Assert: tx reverts with "zero fallback". |
| 5 | Empty inner hookData | ForwardParams with empty `hookData` bytes. Assert: `depositToRemote` called with empty hookData. |
| 6 | Non-empty inner hookData | ForwardParams with populated `hookData`. Assert: hookData passed through correctly. |
| 7 | Multiple sequential relays | Call `receiveAndForward` twice with different messages. Assert: each forwards the correct amount independently (no balance contamination). |
| 8 | Message too short | Pass a message shorter than 376 bytes. Assert: tx reverts (slice out of bounds). |
| 9 | Constructor approval | After deployment, check that `usdc.allowance(router, xReserve) == type(uint256).max`. |
| 10 | Immutables set correctly | Assert `router.transmitter()`, `router.xReserve()`, `router.usdc()` return constructor args. |
| 11 | Consumed nonce recovery | First call `transmitter.receiveMessage()` directly (outside router) to consume nonce and mint to router. Then call `receiveAndForward`. Assert: `RecoveredFromConsumedNonce` + successful forwarding. |
| 12 | Message replay blocked | Call `receiveAndForward` twice with the same attested message. Assert second call reverts with `transfer settled`. |
| 13 | Empty BurnMessage hookData | Build message with `hookData = 0x`. Assert router routes minted amount to operator wallet and emits `OperatorRouted(..., reason=1)`. |
| 14 | Malformed BurnMessage hookData | Build message with non-decodable hook payload. Assert router routes minted amount to operator wallet and emits `OperatorRouted(..., reason=2)`. |

### 7.2 Building Test Messages

Helper function to construct a valid CCTP MessageV2 + BurnMessageV2 for tests:

```solidity
function buildTestMessage(
    uint32 sourceDomain,
    uint256 amount,
    uint256 feeExecuted,
    uint256 cctpMaxFee,
    bytes memory forwardParamsEncoded
) internal pure returns (bytes memory) {
    // Outer MessageV2 header (148 bytes)
    bytes memory header = abi.encodePacked(
        uint32(1),              // version
        sourceDomain,           // sourceDomain
        uint32(0),              // destinationDomain (Ethereum = 0)
        bytes32(0),             // nonce
        bytes32(0),             // sender
        bytes32(0),             // recipient
        bytes32(uint256(uint160(routerAddress))), // destinationCaller = router
        uint32(2000),           // minFinalityThreshold (finalized)
        uint32(2000)            // finalityThresholdExecuted (finalized)
    );

    // Inner BurnMessageV2 body
    bytes memory body = abi.encodePacked(
        uint32(1),              // version (burn message)
        bytes32(0),             // burnToken
        bytes32(uint256(uint160(routerAddress))),  // mintRecipient
        amount,                 // amount
        bytes32(0),             // messageSender
        cctpMaxFee,             // maxFee (CCTP)
        feeExecuted,            // feeExecuted
        uint256(0),             // expirationBlock
        forwardParamsEncoded    // hookData = our ForwardParams
    );

    return abi.encodePacked(header, body);
}
```

### 7.3 Integration Tests (Forked)

For integration testing against real CCTP and xReserve deployments:

- Use Hardhat's `forking` mode to fork Ethereum mainnet (or Sepolia).
- Use real `MessageTransmitterV2` and `xReserve` contract addresses.
- Note: `receiveMessage` requires a valid attestation signed by Circle's attesters, so forked integration tests would need to either:
  - Use `hardhat_impersonateAccount` to impersonate the attester and pre-sign messages, OR
  - Use Hardhat's `hardhat_setStorageAt` to mark a nonce as unused and bypass signature checks.

These are secondary priority. Unit tests with mocks should cover the router logic.

---

## 8. Deployment

### 8.1 Constructor Parameters

| Parameter | Sepolia | Ethereum Mainnet |
|-----------|---------|------------------|
| `_transmitter` | CCTP v2 MessageTransmitterV2 on Sepolia | CCTP v2 MessageTransmitterV2 on mainnet |
| `_xReserve` | xReserve proxy on Sepolia | xReserve proxy on mainnet |
| `_usdc` | USDC on Sepolia | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| `_operatorWallet` | Ops wallet on Sepolia | Ops wallet on mainnet |

Exact Sepolia addresses must be looked up from Circle's documentation or contract registries at deploy time.

### 8.2 Deployment Script

```javascript
// scripts/deploy.js
async function main() {
    const [deployer] = await ethers.getSigners();

    const TRANSMITTER = process.env.TRANSMITTER_ADDRESS;
    const XRESERVE    = process.env.XRESERVE_ADDRESS;
    const USDC        = process.env.USDC_ADDRESS;
    const OPERATOR_WALLET = process.env.OPERATOR_WALLET;

    const Router = await ethers.getContractFactory("XReserveRouter");
    const router = await Router.deploy(
        TRANSMITTER,
        XRESERVE,
        USDC,
        OPERATOR_WALLET
    );
    await router.deployed();

    console.log("XReserveRouter deployed to:", router.address);

    // Verify constructor set the approval
    // (optional verification step)
}
```

### 8.3 Post-Deployment Steps

1. **Verify on Etherscan**: `npx hardhat verify --network sepolia <address> <transmitter> <xReserve> <usdc> <operatorWallet>`
2. **Verify approval**: Confirm `usdc.allowance(router, xReserve) == type(uint256).max`.
3. **Test relay**: On a CCTP source chain testnet, burn USDC with `mintRecipient = router` and `destinationCaller = router`, with ForwardParams as hookData. Wait for attestation. Submit `receiveAndForward` on Sepolia.
4. **Monitor**: Watch for `Forwarded`, `FallbackTriggered`, `RecoveredFromConsumedNonce`, and `OperatorRouted` events.

### 8.4 Deployment Order

1. Deploy and test on Sepolia with testnet USDC, CCTP, and xReserve.
2. Run full end-to-end test: source chain burn → attestation → router relay → xReserve deposit.
3. Deploy on Ethereum mainnet with production addresses.

---

## Appendix A: Contract Address References

These must be confirmed at deploy time from Circle's official documentation:

| Contract | Chain | Purpose |
|----------|-------|---------|
| MessageTransmitterV2 | Ethereum | CCTP v2 message receiver |
| TokenMessengerV2 | Source chains | Where users call depositForBurn |
| xReserve (proxy) | Ethereum | Reserve contract for cross-chain deposits |
| USDC | Ethereum | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` (mainnet) |

## Appendix B: Gas Considerations

- **TypedMemView vs calldata slicing**: TypedMemView copies calldata to memory (~3 gas/byte + memory expansion). For a 400-byte message, this is ~1,200 gas + expansion. Calldata slicing avoids this copy entirely. For a production contract processing many relays, calldata slicing saves meaningful gas.
- **Constructor approval**: Costs ~46,000 gas (SSTORE for the allowance). One-time cost at deploy.
- **USDC transfer in fallback**: ~65,000 gas (ERC-20 transfer).
- **depositToRemote**: Variable, depends on xReserve internals (safeTransferFrom + GatewayWallet deposit + possible hook execution).

## Appendix C: Security Considerations

1. **No access control by design**: The CCTP attestation (signed by Circle's attesters) is the main authorization. Recovery mode additionally requires a consumed nonce check and one-time settlement guard.

2. **ForwardParams are user-controlled**: The `fallbackRecipient`, `remoteDomain`, `remoteRecipient`, `maxFee`, and `hookData` are all set by the user at burn time. The router trusts these values. If a user encodes a bad fallback address, their USDC goes there on failure — this is by design.

3. **Reentrancy surface is small but non-zero**: The router has no complex mutable state and forwards only the attested per-message amount. External calls still exist (`receiveMessage`, `depositToRemote`, token transfers), so safety relies on invariant checks and replay guards.

4. **Infinite approval**: The router grants max approval to xReserve. This remains a trust assumption on the xReserve address (especially if proxied/upgradable). The router mitigates accidental drainage with strict message parsing and one-time message settlement.

5. **Destination caller policy**: New burns should set `destinationCaller = router` to prevent third parties from consuming nonces first. Recovery mode exists as a backstop for legacy/open-caller burns.

6. **Fallback transfer uses `SafeERC20.safeTransfer`**: This prevents silent failures on non-standard ERC-20 behavior and ensures fallback semantics are explicit.
