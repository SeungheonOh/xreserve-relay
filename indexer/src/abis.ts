import { ethers } from "ethers";

export const ROUTER_ABI = [
  "function receiveAndForward(bytes calldata message, bytes calldata attestation) external",
  "event Forwarded(uint32 indexed remoteDomain, bytes32 indexed remoteRecipient, uint256 amount)",
  "event FallbackTriggered(address indexed fallbackRecipient, uint256 amount)",
  "event RecoveredFromConsumedNonce(bytes32 indexed nonce, uint256 amount)",
  "event OperatorRouted(bytes32 indexed transferId, bytes32 indexed nonce, uint256 amount, uint8 reason)",
];

export const FORWARDED_TOPIC0 = ethers.id(
  "Forwarded(uint32,bytes32,uint256)",
);

export const FALLBACK_TRIGGERED_TOPIC0 = ethers.id(
  "FallbackTriggered(address,uint256)",
);

export const RECOVERED_FROM_CONSUMED_NONCE_TOPIC0 = ethers.id(
  "RecoveredFromConsumedNonce(bytes32,uint256)",
);

export const OPERATOR_ROUTED_TOPIC0 = ethers.id(
  "OperatorRouted(bytes32,bytes32,uint256,uint8)",
);
