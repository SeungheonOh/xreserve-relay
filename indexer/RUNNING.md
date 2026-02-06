# Running the XReserve Relay Indexer

## What this service does

The indexer accepts CCTP burn transaction hashes via HTTP, polls Circle's Iris API for attestations, and submits `receiveAndForward` transactions on Ethereum. It requires:

- An Ethereum RPC endpoint (the only chain connection needed)
- A funded Ethereum wallet (pays gas for relay transactions)
- The deployed XReserveRouter contract address
- Access to Circle's public Iris API (no auth required)

---

## 1. Prerequisites

- **Node.js 18+** (for native `fetch` support)
- **npm**

Install dependencies:

```sh
cd indexer
npm install
```

---

## 2. Create the relayer wallet

The indexer needs a dedicated Ethereum wallet to sign and submit `receiveAndForward` transactions. This wallet pays the gas.

### Generate a new wallet

```sh
node -e "const w = require('ethers').Wallet.createRandom(); console.log('Address:', w.address); console.log('Private key:', w.privateKey)"
```

Or using `cast` (Foundry):

```sh
cast wallet new
```

Save the private key securely. You'll set it as `RELAYER_PRIVATE_KEY`.

### Fund the wallet with ETH

The wallet needs ETH on the destination chain (Ethereum mainnet or Sepolia, depending on your environment) to pay gas for `receiveAndForward` calls. Each relay costs roughly 200k-300k gas.

**For testnet (Sepolia):** Use a faucet like https://sepoliafaucet.com or https://faucets.chain.link.

**For mainnet:** Transfer ETH from an existing wallet.

A good starting balance is 0.5 ETH for testnet, or whatever you're comfortable with for mainnet. At ~300k gas per relay and ~30 gwei gas price, each relay costs ~0.009 ETH (~$25 at $2800/ETH). 0.5 ETH covers ~55 relays.

---

## 3. Get an Ethereum RPC URL

You need an RPC endpoint for the destination chain only (Ethereum mainnet or Sepolia). No source chain RPCs are needed.

Providers:
- **Alchemy** — https://www.alchemy.com (free tier: 300M compute units/month)
- **Infura** — https://infura.io (free tier: 100k requests/day)
- **QuickNode** — https://www.quicknode.com
- **Public RPCs** — not recommended for production (rate limits, reliability)

For Sepolia testnet, the URL looks like:
```
https://eth-sepolia.g.alchemy.com/v2/YOUR_API_KEY
```

For mainnet:
```
https://eth-mainnet.g.alchemy.com/v2/YOUR_API_KEY
```

---

## 4. Know your contract addresses

### XReserveRouter

This is the contract you deployed. Set it as `ROUTER_ADDRESS`.

If you haven't deployed yet, deploy the router first and note the address.

### MessageTransmitterV2

This is Circle's contract. The address is the same on all EVM chains:

| Network | Address |
|---------|---------|
| All mainnets | `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` |
| All testnets | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` |

Set this as `TRANSMITTER_ADDRESS`.

---

## 5. Configure environment variables

Create an `.env` file in the `indexer/` directory (or export vars in your shell):

```sh
# Required
IS_TESTNET=true                  # "true" for Sepolia/testnet, anything else for mainnet
ROUTER_ADDRESS=0xYourRouterAddress
ETHEREUM_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY
RELAYER_PRIVATE_KEY=0xYourPrivateKey
TRANSMITTER_ADDRESS=0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275

# Optional (defaults shown)
API_PORT=3000
POLL_CYCLE_INTERVAL_MS=2000      # How often the poller checks for new work
ATTESTATION_TIMEOUT_MS=1800000   # 30 min — fail jobs if no attestation by then
MAX_RETRIES=3                    # Ethereum submission retries before marking failed
SUBMITTER_POLL_INTERVAL_MS=2000  # How often the submitter checks for attested jobs
DB_PATH=./data/relay.db          # SQLite database path
```

### Mainnet example

```sh
IS_TESTNET=false
ROUTER_ADDRESS=0xYourMainnetRouterAddress
ETHEREUM_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
RELAYER_PRIVATE_KEY=0xYourPrivateKey
TRANSMITTER_ADDRESS=0x81D40F21F12A8F0E3252Bccb954D722d4c464B64
```

> **Security note:** Never commit `RELAYER_PRIVATE_KEY` to version control. Use a secrets manager in production. The `.env` file should be in `.gitignore`.

---

## 6. Start the indexer

The indexer doesn't have a `.env` loader built in. Either export the variables in your shell or use a tool like `env` or `dotenv-cli`:

### Option A: Export variables directly

```sh
export IS_TESTNET=true
export ROUTER_ADDRESS=0x...
export ETHEREUM_RPC_URL=https://...
export RELAYER_PRIVATE_KEY=0x...
export TRANSMITTER_ADDRESS=0x...

cd indexer
npm start
```

### Option B: Inline with env file

```sh
cd indexer
env $(cat .env | xargs) npm start
```

You should see:

```
HTTP API listening on port 3000
XReserve Relay Indexer started
```

The service is now running three components in one process:
1. **HTTP API** on the configured port (default 3000)
2. **Attestation poller** — checks Circle's API every 2 seconds
3. **Ethereum submitter** — submits relay transactions sequentially

---

## 7. Using the API

### Submit a relay request

After a user burns USDC on a source chain (e.g., Arbitrum) via CCTP with `mintRecipient` set to the XReserveRouter, submit the source chain txHash:

```sh
curl -X POST http://localhost:3000/relay \
  -H "Content-Type: application/json" \
  -d '{
    "sourceDomain": 3,
    "txHash": "0xabc123...your64charhex..."
  }'
```

**sourceDomain** is the CCTP domain ID of the chain where the burn happened:

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

Response (201 Created):

```json
{
  "txHash": "0xabc123...",
  "status": "pending",
  "message": "Relay job created. Poll GET /relay/:txHash for status."
}
```

### Check relay status

```sh
curl http://localhost:3000/relay/0xabc123...
```

Response:

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

**Status progression:** `pending` → `polling` → `attested` → `submitted` → `confirmed`

If something goes wrong, status becomes `failed` and the `error` field explains why.

**Outcome values** (only set when confirmed):
- `forwarded` — USDC successfully forwarded to xReserve
- `fallback` — xReserve deposit failed; USDC sent to fallback address
- `operator_routed` — hookData was empty or malformed; USDC sent to the operator wallet for manual handling

The logs may also show `Nonce-consumed recovery used for ...` — this means a third party (or Circle's Forwarding Service) called `receiveMessage` before our relay, but the router recovered from its own balance. The final outcome is still one of the three above.

### Health check

```sh
curl http://localhost:3000/health
```

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

---

## 8. What happens end-to-end

1. User burns USDC on a source chain via CCTP, setting `mintRecipient` = XReserveRouter address on Ethereum
2. User (or frontend) POSTs the source txHash to `POST /relay`
3. The **poller** polls Circle's Iris API (`GET /v2/messages/{domain}?transactionHash={txHash}`) until the attestation is ready (typically 8-20 seconds for L2s)
4. The poller validates the attested message: destinationDomain must be 0 (Ethereum), mintRecipient must match the router, and destinationCaller must be either the router or zero (open caller logs a warning about nonce front-run risk)
5. The **submitter** picks up the attested job, estimates gas, and calls `router.receiveAndForward(message, attestation)` on Ethereum
6. The router calls `MessageTransmitterV2.receiveMessage()` to mint USDC to itself, then calls `xReserve.depositToRemote()` to forward onward
7. The submitter parses the receipt for `Forwarded`, `FallbackTriggered`, `OperatorRouted`, or `RecoveredFromConsumedNonce` events and records the outcome

---

## 9. Monitoring the relayer wallet

The relayer wallet balance is the main operational concern. If it runs out of ETH, relay transactions will fail and jobs will accumulate in `attested` status (no data loss — they'll be processed once refunded).

Check the balance:

```sh
cast balance 0xYourRelayerAddress --rpc-url YOUR_RPC_URL
```

Or via the RPC:

```sh
curl -X POST YOUR_RPC_URL \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_getBalance","params":["0xYourRelayerAddress","latest"],"id":1}'
```

Set up an alert when the balance drops below 0.1 ETH.

---

## 10. Stopping and restarting

Press `Ctrl+C` to stop. The indexer shuts down gracefully (closes HTTP server, waits up to 10 seconds).

On restart, all state is recovered from SQLite:
- `pending`/`polling` jobs resume attestation polling
- `attested` jobs resume Ethereum submission
- `submitted` jobs will be retried (gas estimation catches already-consumed nonces and the router's `transfer settled` replay guard)
- `confirmed`/`failed` jobs are terminal — no further action

The SQLite database is stored at `DB_PATH` (default `./data/relay.db`). Back this up if needed.

---

## 11. Running in production

### With systemd

Create `/etc/systemd/system/xreserve-relay.service`:

```ini
[Unit]
Description=XReserve Relay Indexer
After=network.target

[Service]
Type=simple
User=relay
WorkingDirectory=/opt/xreserve-relay/indexer
EnvironmentFile=/opt/xreserve-relay/indexer/.env
ExecStart=/usr/bin/npx tsx src/index.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Note: systemd `EnvironmentFile` reads `KEY=VALUE` lines directly — no `export` prefix needed.

```sh
sudo systemctl enable xreserve-relay
sudo systemctl start xreserve-relay
sudo journalctl -u xreserve-relay -f   # follow logs
```

### With Docker

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
CMD ["npx", "tsx", "src/index.ts"]
```

```sh
docker build -t xreserve-relay-indexer .
docker run -d \
  --name relay \
  --restart unless-stopped \
  -p 3000:3000 \
  -v relay-data:/app/data \
  --env-file .env \
  xreserve-relay-indexer
```

The `-v relay-data:/app/data` mount persists the SQLite database across container restarts.

---

## 12. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Jobs stuck in `polling` | Circle API slow, or txHash doesn't correspond to a real CCTP burn | Check the source txHash on a block explorer. Jobs timeout after 30 min. |
| Jobs failing with `attestation_timeout` | Attestation never arrived. Source tx may have been reorged, or the txHash is wrong. | Verify the burn tx exists on the source chain. Resubmit if valid. |
| Jobs failing with `Gas estimation failed` | CCTP nonce already used (someone else relayed), or message expired | Check if the relay was already completed by another party. |
| Jobs failing with `transfer settled` | The router's replay guard fired — this transfer (sourceDomain + nonce) was already processed | Terminal failure, no action needed. The relay already completed. |
| Jobs accumulating in `attested` | Relayer wallet out of ETH | Fund the wallet. Jobs auto-resume. |
| `Missing required env var` on startup | Forgot to set an env var | Check all required vars: `ROUTER_ADDRESS`, `ETHEREUM_RPC_URL`, `RELAYER_PRIVATE_KEY`, `TRANSMITTER_ADDRESS` |
| Jobs failing with `mintRecipient ... != router` | The burn was not destined for your router | Expected — someone submitted a txHash for a different CCTP transfer |
| Jobs failing with `destinationCaller ... != router or zero` | The burn specified a different `destinationCaller` | Only the designated caller can relay this message. Not meant for your router. |
| Log: `destinationCaller is zero (open)` | The burn used an open caller — any address can call `receiveMessage` | Warning only. A third party could front-run the nonce, but the router's recovery path handles this. For production, source burns should set `destinationCaller` to the router address. |
| Log: `Operator-routed for ...` | The burn's hookData was empty or couldn't be decoded as `ForwardParams` | USDC was sent to the operator wallet. The operator must handle it manually. Check the source burn transaction to understand why hookData was missing/malformed. |
| Log: `Nonce-consumed recovery used for ...` | Someone else called `receiveMessage` first, but the router recovered from its balance | The relay still succeeded. Check that the router holds sufficient USDC balance for future recoveries. |
