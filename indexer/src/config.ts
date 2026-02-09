import { ethers } from "ethers";

export interface Config {
  isTestnet: boolean;
  irisApiBaseUrl: string;

  routerAddress: string;
  routerBytes32: string;

  ethereumRpcUrl: string;
  relayerPrivateKey: string;
  transmitterAddress: string;

  apiPort: number;

  pollCycleIntervalMs: number;
  attestationTimeoutMs: number;

  maxRetries: number;
  submitterPollIntervalMs: number;

  relayFee: bigint;

  dbPath: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export function loadConfig(): Config {
  const isTestnet = process.env.IS_TESTNET === "true";
  const routerAddress = required("ROUTER_ADDRESS");

  // Pad address to bytes32: 0x000...{20-byte address}
  const routerBytes32 = ethers.zeroPadValue(routerAddress, 32);

  return {
    isTestnet,
    irisApiBaseUrl: isTestnet
      ? "https://iris-api-sandbox.circle.com"
      : "https://iris-api.circle.com",

    routerAddress,
    routerBytes32,

    ethereumRpcUrl: required("ETHEREUM_RPC_URL"),
    relayerPrivateKey: required("RELAYER_PRIVATE_KEY"),
    transmitterAddress: required("TRANSMITTER_ADDRESS"),

    apiPort: parseInt(process.env.API_PORT ?? "3000", 10),

    pollCycleIntervalMs: parseInt(
      process.env.POLL_CYCLE_INTERVAL_MS ?? "2000",
      10,
    ),
    attestationTimeoutMs: parseInt(
      process.env.ATTESTATION_TIMEOUT_MS ?? "1800000",
      10,
    ),

    maxRetries: parseInt(process.env.MAX_RETRIES ?? "3", 10),
    submitterPollIntervalMs: parseInt(
      process.env.SUBMITTER_POLL_INTERVAL_MS ?? "2000",
      10,
    ),

    relayFee: BigInt(process.env.RELAY_FEE ?? "0"),

    dbPath: process.env.DB_PATH ?? "./data/relay.db",
  };
}
