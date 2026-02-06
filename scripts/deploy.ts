import { network } from "hardhat";

const { ethers, networkName } = await network.connect();

// ── Required environment variables ──
const TRANSMITTER = process.env.TRANSMITTER_ADDRESS;
const XRESERVE = process.env.XRESERVE_ADDRESS;
const USDC = process.env.USDC_ADDRESS;
const OPERATOR_WALLET = process.env.OPERATOR_WALLET;

if (!TRANSMITTER || !XRESERVE || !USDC || !OPERATOR_WALLET) {
  console.error(
    "Missing required env vars: TRANSMITTER_ADDRESS, XRESERVE_ADDRESS, USDC_ADDRESS, OPERATOR_WALLET"
  );
  process.exit(1);
}

console.log(`Deploying XReserveRouter to ${networkName}...`);
console.log(`  Transmitter: ${TRANSMITTER}`);
console.log(`  xReserve:    ${XRESERVE}`);
console.log(`  USDC:        ${USDC}`);
console.log(`  Operator:    ${OPERATOR_WALLET}`);

const factory = await ethers.getContractFactory("XReserveRouter");
const router = await factory.deploy(
  TRANSMITTER,
  XRESERVE,
  USDC,
  OPERATOR_WALLET
);
await router.waitForDeployment();

const routerAddress = await router.getAddress();
console.log(`\nXReserveRouter deployed to: ${routerAddress}`);

// ── Verify constructor approval ──
const usdcContract = await ethers.getContractAt("IERC20", USDC);
const allowance = await usdcContract.allowance(routerAddress, XRESERVE);
console.log(`USDC allowance (router → xReserve): ${allowance}`);

if (allowance === ethers.MaxUint256) {
  console.log("Approval verified (max uint256).");
} else {
  console.warn("WARNING: Approval is not max uint256!");
}
