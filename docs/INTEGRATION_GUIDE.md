# XReserve Relay — Integration Guide

This guide explains how to send USDC from any CCTP-supported chain through the XReserve Relay system to an xReserve partner chain.

## Overview

```
Source Chain                    Relay Indexer              Ethereum                    Partner Chain
(Arbitrum, Base, etc.)          (off-chain)                                            (xReserve)

1. Approve USDC
2. Call depositForBurnWithHook  ───────────────────────────────────────────────────▶ CCTP burns USDC
3. Get txHash
4. POST /relay {txHash} ──────▶ 5. Poll Circle for
                                   attestation
                                6. Submit
                                   receiveAndForward ────▶ 7. Mint USDC to router
                                                           8. Forward to xReserve ──▶ 9. USDCx minted
                                                                                       to recipient
```

The user does steps 1–4. The relay indexer handles 5–8 automatically. Step 9 is handled by Circle's xReserve infrastructure.

---

## Step 1: Encode ForwardParams

The `ForwardParams` struct tells the router where to forward the USDC after it's minted on Ethereum.

```solidity
struct ForwardParams {
    address fallbackRecipient; // Ethereum address that gets USDC if xReserve fails
    uint32  remoteDomain;      // xReserve domain ID (NOT a chain ID)
    bytes32 remoteRecipient;   // USDCx recipient on the partner chain
    uint256 maxFee;            // Fee budget for xReserve relayer (in USDC, 6 decimals)
    bytes   hookData;          // Optional data for xReserve hook executor (usually empty)
}
```

### Field details

**`fallbackRecipient`** — An Ethereum address you control. If `xReserve.depositToRemote()` reverts for any reason (domain paused, token not supported, etc.), the minted USDC is sent here instead. **Must not be address(0).**

**`remoteDomain`** — The xReserve domain ID for the destination partner chain. This is assigned by Circle's xReserve operator and is **not** the same as the CCTP domain ID or chain ID. Check Circle's xReserve documentation for the correct value.

**`remoteRecipient`** — The recipient address on the partner chain, left-padded to bytes32. For EVM chains: `bytes32(uint256(uint160(address)))`.

**`maxFee`** — Maximum fee (in USDC, 6 decimals) you're willing to pay the xReserve relayer on the partner chain. The partner chain requires `amount >= maxFee`. Set to 0 if no fee is expected.

**`hookData`** — Optional. Pass empty bytes (`""` / `0x`) unless the partner chain has a configured hook executor.

### Encoding in Solidity

```solidity
bytes memory forwardParams = abi.encode(
    ForwardParams({
        fallbackRecipient: 0xYourEthereumAddress,
        remoteDomain: 7,
        remoteRecipient: bytes32(uint256(uint160(0xRecipientOnPartnerChain))),
        maxFee: 1e6,       // 1 USDC
        hookData: ""
    })
);
```

### Encoding in ethers.js (v6)

```typescript
const forwardParams = ethers.AbiCoder.defaultAbiCoder().encode(
  ["tuple(address,uint32,bytes32,uint256,bytes)"],
  [[
    "0xYourFallbackAddress",         // fallbackRecipient
    7,                                // remoteDomain
    ethers.zeroPadValue("0xRecipientOnPartnerChain", 32), // remoteRecipient
    1_000_000n,                       // maxFee (1 USDC)
    "0x",                             // hookData
  ]]
);
```

---

## Step 2: Call depositForBurnWithHook on the source chain

Call `TokenMessengerV2.depositForBurnWithHook()` on the source chain (e.g., Arbitrum, Base).

### Parameters

| Parameter | Value |
|-----------|-------|
| `amount` | USDC amount to burn (6 decimals). e.g., `10_000_000` = 10 USDC |
| `destinationDomain` | `0` (Ethereum) |
| `mintRecipient` | Router address as bytes32: `bytes32(uint256(uint160(routerAddress)))` |
| `burnToken` | USDC address on the source chain |
| `maxFee` | Max CCTP fee you agree to pay (set by Circle, usually 0 on testnet) |
| `hookData` | The encoded `ForwardParams` from Step 1 |

### Critical: set destinationCaller

You **must** also set `destinationCaller` to the router address (as bytes32) to prevent third parties from front-running the CCTP nonce. If you leave it as `bytes32(0)` (open caller), anyone can call `receiveMessage` before the relay, which forces the router into a recovery path that requires pre-funded balance.

### Contract addresses

**XReserveRouter (Sepolia):** `0xaAfaaaeBF0FF656990a67467b7Eb2d97014AD747`

**TokenMessengerV2** — varies per source chain. Consult [Circle's CCTP docs](https://developers.circle.com/stablecoins/cctp-getting-started) for the address on your source chain.

**USDC** — varies per source chain.

### Solidity example

```solidity
// On the source chain (e.g., Arbitrum)
address constant ROUTER = 0xaAfaaaeBF0FF656990a67467b7Eb2d97014AD747;
uint32  constant ETHEREUM_DOMAIN = 0;

// 1. Approve USDC to TokenMessengerV2
IERC20(usdc).approve(address(tokenMessengerV2), amount);

// 2. Encode ForwardParams
bytes memory forwardParams = abi.encode(
    ForwardParams({
        fallbackRecipient: msg.sender,
        remoteDomain: 7,
        remoteRecipient: bytes32(uint256(uint160(recipientAddr))),
        maxFee: 1e6,
        hookData: ""
    })
);

// 3. Burn USDC via CCTP
tokenMessengerV2.depositForBurnWithHook(
    amount,
    ETHEREUM_DOMAIN,
    bytes32(uint256(uint160(ROUTER))),   // mintRecipient
    address(usdc),
    maxCctpFee,
    forwardParams                         // hookData = encoded ForwardParams
);
// destinationCaller is set to ROUTER automatically by depositForBurnWithHook
// if using the version that accepts it, otherwise use depositForBurnWithCaller
```

### ethers.js example

```typescript
const ROUTER = "0xaAfaaaeBF0FF656990a67467b7Eb2d97014AD747";
const ETHEREUM_DOMAIN = 0;

// Approve USDC to TokenMessengerV2
const usdc = new ethers.Contract(USDC_ADDRESS, [
  "function approve(address spender, uint256 amount) returns (bool)",
], signer);
await usdc.approve(TOKEN_MESSENGER_V2_ADDRESS, amount);

// Encode ForwardParams
const forwardParams = ethers.AbiCoder.defaultAbiCoder().encode(
  ["tuple(address,uint32,bytes32,uint256,bytes)"],
  [[
    fallbackAddress,
    remoteDomain,
    ethers.zeroPadValue(recipientAddress, 32),
    maxXReserveFee,
    "0x",
  ]]
);

// Burn via CCTP
const tokenMessenger = new ethers.Contract(TOKEN_MESSENGER_V2_ADDRESS, [
  "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, uint256 maxFee, bytes calldata hookData) returns (uint64)",
], signer);

const tx = await tokenMessenger.depositForBurnWithHook(
  amount,
  ETHEREUM_DOMAIN,
  ethers.zeroPadValue(ROUTER, 32),       // mintRecipient
  USDC_ADDRESS,                           // burnToken on source chain
  maxCctpFee,
  forwardParams,                          // hookData
);

const receipt = await tx.wait();
console.log("Source txHash:", receipt.hash);
```

---

## Step 3: Submit the source txHash to the relay indexer

After the burn transaction confirms on the source chain, submit it to the relay indexer API.

### Request

```sh
curl -X POST https://your-indexer-host:3000/relay \
  -H "Content-Type: application/json" \
  -d '{
    "sourceDomain": 3,
    "txHash": "0xYourSourceChainTxHash..."
  }'
```

**`sourceDomain`** — the CCTP domain ID of the chain where you burned:

| Chain | Domain ID |
|-------|-----------|
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

**`txHash`** — the 0x-prefixed, 64-character hex hash of the burn transaction on the source chain.

### Response (201 Created)

```json
{
  "txHash": "0xabc123...",
  "status": "pending",
  "message": "Relay job created. Poll GET /relay/:txHash for status."
}
```

If you submit the same txHash again, you get the existing job back (200 OK, idempotent).

---

## Step 4: Poll for status

```sh
curl https://your-indexer-host:3000/relay/0xYourSourceChainTxHash
```

### Response

```json
{
  "txHash": "0xabc123...",
  "sourceDomain": 3,
  "status": "confirmed",
  "outcome": "forwarded",
  "error": null,
  "ethTxHash": "0xdef456...",
  "createdAt": "2025-01-15T10:30:00.000Z",
  "attestedAt": "2025-01-15T10:30:12.000Z",
  "submittedAt": "2025-01-15T10:30:14.000Z",
  "confirmedAt": "2025-01-15T10:30:26.000Z"
}
```

### Status progression

```
pending → polling → attested → submitted → confirmed
                                              │
                                              └─ check "outcome" field
```

| Status | Meaning |
|--------|---------|
| `pending` | Job created, not yet polled |
| `polling` | Polling Circle API for attestation |
| `attested` | Attestation received, queued for Ethereum submission |
| `submitted` | Ethereum tx sent, awaiting confirmation |
| `confirmed` | Done. Check the `outcome` field. |
| `failed` | Permanently failed. Check the `error` field. |

### Outcome values (when status = confirmed)

| Outcome | What happened | User action |
|---------|---------------|-------------|
| `forwarded` | USDC forwarded to xReserve. USDCx will be minted on the partner chain. | None — wait for xReserve to mint on the partner chain. |
| `fallback` | `xReserve.depositToRemote()` reverted. USDC sent to your `fallbackRecipient` on Ethereum. | Collect USDC from your fallback address. Investigate why xReserve rejected the deposit. |
| `operator_routed` | hookData was empty or malformed. USDC sent to the operator wallet. | Contact the operator to recover funds. Fix the hookData encoding. |

---

## Timing expectations

| Phase | Typical duration |
|-------|-----------------|
| Attestation (fast transfer, L2 source) | ~8–20 seconds |
| Attestation (standard transfer, L2 source) | ~15–19 minutes |
| Attestation (standard transfer, Ethereum source) | ~15–19 minutes |
| Ethereum submission + 1 confirmation | ~15–30 seconds |
| **Total (fast L2 → Ethereum)** | **~30–60 seconds** |

After the relay confirms on Ethereum, the xReserve partner chain minting is handled by Circle's xReserve off-chain infrastructure (timing depends on the partner chain).

---

## Error cases

| Error | Meaning | What to do |
|-------|---------|------------|
| `attestation_timeout` | Circle's API didn't return an attestation within 30 minutes | Verify the source txHash is valid. The burn may have been reorged out. |
| `mintRecipient ... != router` | The burn wasn't destined for this router | Check that `mintRecipient` was set to the router address. |
| `destinationCaller ... != router or zero` | The burn locked the caller to a different address | Only the designated `destinationCaller` can relay. |
| `transfer settled` | This transfer was already relayed | No action needed — it was already processed. |
| `Gas estimation failed` | The CCTP nonce was already used, or the message expired | Check if the relay was completed by another party. |

---

## Testnet deployment

| Component | Address / URL |
|-----------|---------------|
| XReserveRouter (Sepolia) | `0xaAfaaaeBF0FF656990a67467b7Eb2d97014AD747` |
| MessageTransmitterV2 (all testnets) | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` |
| USDC (Sepolia) | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |
| Relay indexer API | `http://localhost:3000` (or your deployed host) |

---

## Checklist

Before submitting a relay:

- [ ] `ForwardParams.fallbackRecipient` is a valid Ethereum address you control (not zero)
- [ ] `ForwardParams.remoteDomain` is the correct xReserve domain ID (not CCTP domain, not chain ID)
- [ ] `ForwardParams.remoteRecipient` is correctly left-padded to bytes32
- [ ] `ForwardParams.maxFee` is set (partner chain requires `amount >= maxFee`)
- [ ] `mintRecipient` in the burn call = router address (bytes32-padded)
- [ ] `destinationDomain` in the burn call = `0` (Ethereum)
- [ ] `destinationCaller` = router address (recommended) to prevent nonce front-running
- [ ] USDC approved to `TokenMessengerV2` on the source chain
- [ ] `sourceDomain` in the POST /relay request matches the chain you burned on
