import { ethers } from "ethers";

export const ROUTER_ABI = [
  "function receiveAndForward(bytes calldata message, bytes calldata attestation, uint256 relayFee) external",
  "event Relayed(uint32 indexed sourceDomain, bytes32 indexed sourceSender, bytes32 indexed nonce, uint256 amount, uint256 relayFee)",
  "event FallbackTriggered(address indexed fallbackRecipient, uint256 amount, uint256 relayFee)",
  "event RecoveredFromConsumedNonce(bytes32 indexed nonce, uint256 amount)",
  "event OperatorRouted(bytes32 indexed transferId, bytes32 indexed nonce, uint256 amount, uint8 reason)",
];

export const RELAYED_TOPIC0 = ethers.id(
  "Relayed(uint32,bytes32,bytes32,uint256,uint256)",
);

export const FALLBACK_TRIGGERED_TOPIC0 = ethers.id(
  "FallbackTriggered(address,uint256,uint256)",
);

export const RECOVERED_FROM_CONSUMED_NONCE_TOPIC0 = ethers.id(
  "RecoveredFromConsumedNonce(bytes32,uint256)",
);

export const OPERATOR_ROUTED_TOPIC0 = ethers.id(
  "OperatorRouted(bytes32,bytes32,uint256,uint8)",
);
