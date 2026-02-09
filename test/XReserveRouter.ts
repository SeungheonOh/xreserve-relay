import { expect } from "chai";
import { network } from "hardhat";
import { type Contract } from "ethers";

const { ethers, networkHelpers } = await network.connect();

// ── Helpers ──────────────────────────────────────────────────────

const ZERO_BYTES32 = ethers.zeroPadValue("0x", 32);

function addressToBytes32(addr: string): string {
  return ethers.zeroPadValue(addr, 32);
}

function uintToBytes32(value: number): string {
  return ethers.zeroPadValue(ethers.toBeHex(value), 32);
}

/**
 * Encode the CCTP BurnMessageV2 hookData as a ForwardParams struct.
 */
function encodeForwardParams(params: {
  fallbackRecipient: string;
  remoteDomain: number;
  remoteRecipient: string;
  maxFee: bigint;
  relayMaxFee: bigint;
  hookData: string;
}): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    [
      "tuple(address fallbackRecipient, uint32 remoteDomain, bytes32 remoteRecipient, uint256 maxFee, uint256 relayMaxFee, bytes hookData)",
    ],
    [params]
  );
}

/**
 * Build a full CCTP MessageV2 + BurnMessageV2.
 *
 * Outer MessageV2 header (148 bytes, abi.encodePacked):
 *   version(4) + sourceDomain(4) + destinationDomain(4) + nonce(32) +
 *   sender(32) + recipient(32) + destinationCaller(32) +
 *   minFinalityThreshold(4) + finalityThresholdExecuted(4)
 *
 * Inner BurnMessageV2 body (228+ bytes, abi.encodePacked):
 *   version(4) + burnToken(32) + mintRecipient(32) + amount(32) +
 *   messageSender(32) + maxFeeCctp(32) + feeExecuted(32) +
 *   expirationBlock(32) + hookData(var)
 */
function buildCctpMessage(opts: {
  mintRecipient: string;
  amount: bigint;
  feeExecuted: bigint;
  cctpMaxFee: bigint;
  hookData: string;
  sourceDomain?: number;
  nonce?: string;
  sender?: string;
  messageSender?: string;
}): string {
  const sourceDomain = opts.sourceDomain ?? 3; // Arbitrum domain
  const nonce = opts.nonce ?? ZERO_BYTES32;
  const sender = opts.sender ?? ZERO_BYTES32;
  const messageSender = opts.messageSender ?? ZERO_BYTES32;

  // ── Outer MessageV2 header ──
  const header = ethers.solidityPacked(
    [
      "uint32",  // version
      "uint32",  // sourceDomain
      "uint32",  // destinationDomain
      "bytes32", // nonce
      "bytes32", // sender
      "bytes32", // recipient
      "bytes32", // destinationCaller
      "uint32",  // minFinalityThreshold
      "uint32",  // finalityThresholdExecuted
    ],
    [
      1,                 // version
      sourceDomain,      // sourceDomain
      0,                 // destinationDomain (Ethereum = 0)
      nonce,             // nonce
      sender,            // sender
      ZERO_BYTES32,      // recipient
      ZERO_BYTES32,      // destinationCaller
      2000,              // minFinalityThreshold (finalized)
      2000,              // finalityThresholdExecuted (finalized)
    ]
  );

  // ── Inner BurnMessageV2 body ──
  const body = ethers.solidityPacked(
    [
      "uint32",  // version
      "bytes32", // burnToken
      "bytes32", // mintRecipient
      "uint256", // amount
      "bytes32", // messageSender
      "uint256", // maxFee (CCTP)
      "uint256", // feeExecuted
      "uint256", // expirationBlock
      "bytes",   // hookData (ForwardParams)
    ],
    [
      1,                                         // version
      ZERO_BYTES32,                              // burnToken
      addressToBytes32(opts.mintRecipient),       // mintRecipient
      opts.amount,                               // amount
      messageSender,                             // messageSender
      opts.cctpMaxFee,                           // maxFee (CCTP)
      opts.feeExecuted,                          // feeExecuted
      0n,                                        // expirationBlock
      opts.hookData,                             // hookData
    ]
  );

  return ethers.concat([header, body]);
}

// ── Fixture ──────────────────────────────────────────────────────

async function deployFixture() {
  const [deployer, fallbackAddr, otherUser] = await ethers.getSigners();

  // Deploy MockUSDC
  const usdcFactory = await ethers.getContractFactory("MockUSDC");
  const usdc = await usdcFactory.deploy();
  await usdc.waitForDeployment();

  // Deploy MockMessageTransmitter
  const transmitterFactory = await ethers.getContractFactory(
    "MockMessageTransmitter"
  );
  const transmitter = await transmitterFactory.deploy(
    await usdc.getAddress()
  );
  await transmitter.waitForDeployment();

  // Deploy MockXReserve
  const xReserveFactory = await ethers.getContractFactory("MockXReserve");
  const xReserve = await xReserveFactory.deploy();
  await xReserve.waitForDeployment();

  // Deploy XReserveRouter
  const routerFactory = await ethers.getContractFactory("XReserveRouter");
  const router = await routerFactory.deploy(
    await transmitter.getAddress(),
    await xReserve.getAddress(),
    await usdc.getAddress(),
    await deployer.getAddress()
  );
  await router.waitForDeployment();

  return {
    usdc,
    transmitter,
    xReserve,
    router,
    deployer,
    fallbackAddr,
    otherUser,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe("XReserveRouter", function () {
  // ────────────────────────────────────────────────────────────
  // Test 1: Happy path
  // ────────────────────────────────────────────────────────────
  it("should forward USDC to xReserve on the happy path", async function () {
    const { router, xReserve, usdc, fallbackAddr } =
      await networkHelpers.loadFixture(deployFixture);

    const amount = 1_000_000n; // 1 USDC
    const feeExecuted = 0n;
    const remoteDomain = 7;
    const remoteRecipient = addressToBytes32(
      "0x000000000000000000000000000000000000dEaD"
    );
    const outerSender = addressToBytes32(
      "0x0000000000000000000000000000000000001111"
    );
    const burnMessageSender = addressToBytes32(
      "0x0000000000000000000000000000000000002222"
    );
    const xReserveMaxFee = 100n;

    const hookData = encodeForwardParams({
      fallbackRecipient: await fallbackAddr.getAddress(),
      remoteDomain,
      remoteRecipient,
      maxFee: xReserveMaxFee,
      relayMaxFee: 0n,
      hookData: "0x",
    });

    const message = buildCctpMessage({
      mintRecipient: await router.getAddress(),
      amount,
      feeExecuted,
      cctpMaxFee: 0n,
      hookData,
      sender: outerSender,
      messageSender: burnMessageSender,
    });

    const attestation = "0x";

    await expect(router.receiveAndForward(message, attestation, 0n))
      .to.emit(router, "Relayed")
      .withArgs(3, burnMessageSender, ZERO_BYTES32, amount, 0n);

    // Verify xReserve received the correct call
    expect(await xReserve.called()).to.equal(true);
    expect(await xReserve.lastValue()).to.equal(amount);
    expect(await xReserve.lastRemoteDomain()).to.equal(remoteDomain);
    expect(await xReserve.lastRemoteRecipient()).to.equal(remoteRecipient);
    expect(await xReserve.lastLocalToken()).to.equal(await usdc.getAddress());
    expect(await xReserve.lastMaxFee()).to.equal(xReserveMaxFee);

    // Router should have 0 USDC balance (all forwarded)
    expect(await usdc.balanceOf(await router.getAddress())).to.equal(0n);
  });

  // ────────────────────────────────────────────────────────────
  // Test 2: Fee deduction
  // ────────────────────────────────────────────────────────────
  it("should deduct feeExecuted from amount", async function () {
    const { router, xReserve, fallbackAddr } =
      await networkHelpers.loadFixture(deployFixture);

    const amount = 1_000_000n;
    const feeExecuted = 500n;
    const expectedMinted = amount - feeExecuted;
    const remoteDomain = 7;
    const remoteRecipient = addressToBytes32(
      "0x000000000000000000000000000000000000dEaD"
    );

    const hookData = encodeForwardParams({
      fallbackRecipient: await fallbackAddr.getAddress(),
      remoteDomain,
      remoteRecipient,
      maxFee: 0n,
      relayMaxFee: 0n,
      hookData: "0x",
    });

    const message = buildCctpMessage({
      mintRecipient: await router.getAddress(),
      amount,
      feeExecuted,
      cctpMaxFee: 1000n,
      hookData,
    });

    await expect(router.receiveAndForward(message, "0x", 0n))
      .to.emit(router, "Relayed")
      .withArgs(3, ZERO_BYTES32, ZERO_BYTES32, expectedMinted, 0n);

    expect(await xReserve.lastValue()).to.equal(expectedMinted);
  });

  // ────────────────────────────────────────────────────────────
  // Test 3: Fallback on xReserve failure
  // ────────────────────────────────────────────────────────────
  it("should transfer USDC to fallback when xReserve reverts", async function () {
    const { router, xReserve, usdc, fallbackAddr } =
      await networkHelpers.loadFixture(deployFixture);

    // Configure xReserve to revert
    await xReserve.setShouldRevert(true);

    const amount = 2_000_000n;
    const feeExecuted = 0n;
    const fallbackAddress = await fallbackAddr.getAddress();

    const hookData = encodeForwardParams({
      fallbackRecipient: fallbackAddress,
      remoteDomain: 7,
      remoteRecipient: addressToBytes32(
        "0x000000000000000000000000000000000000dEaD"
      ),
      maxFee: 0n,
      relayMaxFee: 0n,
      hookData: "0x",
    });

    const message = buildCctpMessage({
      mintRecipient: await router.getAddress(),
      amount,
      feeExecuted,
      cctpMaxFee: 0n,
      hookData,
    });

    await expect(router.receiveAndForward(message, "0x", 0n))
      .to.emit(router, "FallbackTriggered")
      .withArgs(fallbackAddress, amount, 0n);

    // Fallback address should have received the USDC
    expect(await usdc.balanceOf(fallbackAddress)).to.equal(amount);

    // xReserve should NOT have been called successfully
    expect(await xReserve.called()).to.equal(false);
  });

  // ────────────────────────────────────────────────────────────
  // Test 4: Zero fallback address reverts
  // ────────────────────────────────────────────────────────────
  it("should revert when fallbackRecipient is address(0)", async function () {
    const { router } = await networkHelpers.loadFixture(deployFixture);

    const hookData = encodeForwardParams({
      fallbackRecipient: ethers.ZeroAddress,
      remoteDomain: 7,
      remoteRecipient: ZERO_BYTES32,
      maxFee: 0n,
      relayMaxFee: 0n,
      hookData: "0x",
    });

    const message = buildCctpMessage({
      mintRecipient: await router.getAddress(),
      amount: 1_000_000n,
      feeExecuted: 0n,
      cctpMaxFee: 0n,
      hookData,
    });

    await expect(
      router.receiveAndForward(message, "0x", 0n)
    ).to.be.revertedWith("zero fallback");
  });

  // ────────────────────────────────────────────────────────────
  // Test 4b: mintRecipient must be router
  // ────────────────────────────────────────────────────────────
  it("should revert when burn message mintRecipient is not the router", async function () {
    const { router, fallbackAddr, otherUser } =
      await networkHelpers.loadFixture(deployFixture);

    const hookData = encodeForwardParams({
      fallbackRecipient: await fallbackAddr.getAddress(),
      remoteDomain: 7,
      remoteRecipient: ZERO_BYTES32,
      maxFee: 0n,
      relayMaxFee: 0n,
      hookData: "0x",
    });

    const message = buildCctpMessage({
      mintRecipient: await otherUser.getAddress(),
      amount: 1_000_000n,
      feeExecuted: 0n,
      cctpMaxFee: 0n,
      hookData,
    });

    await expect(
      router.receiveAndForward(message, "0x", 0n)
    ).to.be.revertedWith("invalid mintRecipient");
  });

  // ────────────────────────────────────────────────────────────
  // Test 4c: transmitter must report success
  // ────────────────────────────────────────────────────────────
  it("should revert when transmitter returns false", async function () {
    const { router, transmitter, fallbackAddr } =
      await networkHelpers.loadFixture(deployFixture);

    await transmitter.setShouldReturnFalse(true);

    const hookData = encodeForwardParams({
      fallbackRecipient: await fallbackAddr.getAddress(),
      remoteDomain: 7,
      remoteRecipient: ZERO_BYTES32,
      maxFee: 0n,
      relayMaxFee: 0n,
      hookData: "0x",
    });

    const message = buildCctpMessage({
      mintRecipient: await router.getAddress(),
      amount: 1_000_000n,
      feeExecuted: 0n,
      cctpMaxFee: 0n,
      hookData,
    });

    await expect(
      router.receiveAndForward(message, "0x", 0n)
    ).to.be.revertedWith("receive failed");
  });

  // ────────────────────────────────────────────────────────────
  // Test 4d: amount must be greater than feeExecuted
  // ────────────────────────────────────────────────────────────
  it("should revert when amount is not greater than feeExecuted", async function () {
    const { router, fallbackAddr } =
      await networkHelpers.loadFixture(deployFixture);

    const hookData = encodeForwardParams({
      fallbackRecipient: await fallbackAddr.getAddress(),
      remoteDomain: 7,
      remoteRecipient: ZERO_BYTES32,
      maxFee: 0n,
      relayMaxFee: 0n,
      hookData: "0x",
    });

    const message = buildCctpMessage({
      mintRecipient: await router.getAddress(),
      amount: 1_000_000n,
      feeExecuted: 1_000_000n,
      cctpMaxFee: 1_000_000n,
      hookData,
    });

    await expect(
      router.receiveAndForward(message, "0x", 0n)
    ).to.be.revertedWith("invalid fee");
  });

  // ────────────────────────────────────────────────────────────
  // Test 4e: recover when nonce was consumed outside router
  // ────────────────────────────────────────────────────────────
  it("should recover and forward when receiveMessage nonce is already consumed", async function () {
    const { router, transmitter, xReserve, usdc, fallbackAddr, otherUser } =
      await networkHelpers.loadFixture(deployFixture);

    const amount = 1_500_000n;
    const remoteDomain = 7;
    const nonce = uintToBytes32(77);
    const remoteRecipient = addressToBytes32(
      "0x000000000000000000000000000000000000dEaD"
    );

    const hookData = encodeForwardParams({
      fallbackRecipient: await fallbackAddr.getAddress(),
      remoteDomain,
      remoteRecipient,
      maxFee: 0n,
      relayMaxFee: 0n,
      hookData: "0x",
    });

    const message = buildCctpMessage({
      mintRecipient: await router.getAddress(),
      amount,
      feeExecuted: 0n,
      cctpMaxFee: 0n,
      hookData,
      nonce,
    });

    // Simulate a third party consuming the CCTP nonce first.
    await transmitter.connect(otherUser).receiveMessage(message, "0x");
    expect(await usdc.balanceOf(await router.getAddress())).to.equal(amount);

    await expect(router.receiveAndForward(message, "0x", 0n))
      .to.emit(router, "RecoveredFromConsumedNonce")
      .withArgs(nonce, amount)
      .and.to.emit(router, "Relayed")
      .withArgs(3, ZERO_BYTES32, nonce, amount, 0n);

    expect(await usdc.balanceOf(await router.getAddress())).to.equal(0n);
    expect(await xReserve.lastValue()).to.equal(amount);

    // The same attested message can only be settled once.
    await expect(
      router.receiveAndForward(message, "0x", 0n)
    ).to.be.revertedWith("transfer settled");
  });

  // ────────────────────────────────────────────────────────────
  // Test 4f: empty BurnMessage hookData routes to operator
  // ────────────────────────────────────────────────────────────
  it("should route to operator when BurnMessage hookData is empty", async function () {
    const { router, usdc, deployer } =
      await networkHelpers.loadFixture(deployFixture);

    const amount = 777_000n;
    const nonce = uintToBytes32(88);
    const operatorAddress = await deployer.getAddress();

    const message = buildCctpMessage({
      mintRecipient: await router.getAddress(),
      amount,
      feeExecuted: 0n,
      cctpMaxFee: 0n,
      hookData: "0x",
      nonce,
    });

    await expect(router.receiveAndForward(message, "0x", 0n))
      .to.emit(router, "OperatorRouted")
      .withArgs(
        ethers.solidityPackedKeccak256(["uint32", "bytes32"], [3, nonce]),
        nonce,
        amount,
        1
      );

    expect(await usdc.balanceOf(await router.getAddress())).to.equal(0n);
    expect(await usdc.balanceOf(operatorAddress)).to.equal(amount);
  });

  // ────────────────────────────────────────────────────────────
  // Test 4g: malformed BurnMessage hookData routes to operator
  // ────────────────────────────────────────────────────────────
  it("should route to operator when BurnMessage hookData cannot decode", async function () {
    const { router, usdc, deployer, xReserve } =
      await networkHelpers.loadFixture(deployFixture);

    const amount = 654_321n;
    const malformedHookData = ethers.solidityPacked(["uint256"], [42n]);

    const message = buildCctpMessage({
      mintRecipient: await router.getAddress(),
      amount,
      feeExecuted: 0n,
      cctpMaxFee: 0n,
      hookData: malformedHookData,
      nonce: uintToBytes32(89),
    });

    await expect(router.receiveAndForward(message, "0x", 0n))
      .to.emit(router, "OperatorRouted")
      .withArgs(
        ethers.solidityPackedKeccak256(
          ["uint32", "bytes32"],
          [3, uintToBytes32(89)]
        ),
        uintToBytes32(89),
        amount,
        2
      );

    expect(await xReserve.called()).to.equal(false);
    expect(await usdc.balanceOf(await router.getAddress())).to.equal(0n);
    expect(await usdc.balanceOf(await deployer.getAddress())).to.equal(amount);
  });

  // ────────────────────────────────────────────────────────────
  // Test 4h: consumed nonce + malformed hookData routes to operator
  // ────────────────────────────────────────────────────────────
  it("should route consumed-nonce settlements with malformed hookData to operator", async function () {
    const { router, transmitter, usdc, deployer, otherUser, xReserve } =
      await networkHelpers.loadFixture(deployFixture);

    const amount = 333_333n;
    const nonce = uintToBytes32(90);
    const malformedHookData = ethers.solidityPacked(["uint256"], [99n]);

    const message = buildCctpMessage({
      mintRecipient: await router.getAddress(),
      amount,
      feeExecuted: 0n,
      cctpMaxFee: 0n,
      hookData: malformedHookData,
      nonce,
    });

    // Consume nonce externally and mint to router.
    await transmitter.connect(otherUser).receiveMessage(message, "0x");

    await expect(router.receiveAndForward(message, "0x", 0n))
      .to.emit(router, "RecoveredFromConsumedNonce")
      .withArgs(nonce, amount)
      .and.to.emit(router, "OperatorRouted")
      .withArgs(
        ethers.solidityPackedKeccak256(["uint32", "bytes32"], [3, nonce]),
        nonce,
        amount,
        2
      );

    expect(await xReserve.called()).to.equal(false);
    expect(await usdc.balanceOf(await router.getAddress())).to.equal(0n);
    expect(await usdc.balanceOf(await deployer.getAddress())).to.equal(amount);
  });

  // ────────────────────────────────────────────────────────────
  // Test 4i: replay blocked by canonical transfer identity
  // ────────────────────────────────────────────────────────────
  it("should reject different message bytes that reuse sourceDomain+nonce", async function () {
    const { router, fallbackAddr } =
      await networkHelpers.loadFixture(deployFixture);

    const nonce = uintToBytes32(91);
    const baseParams = {
      fallbackRecipient: await fallbackAddr.getAddress(),
      maxFee: 0n,
      relayMaxFee: 0n,
      hookData: "0x",
    };

    const hookData1 = encodeForwardParams({
      ...baseParams,
      remoteDomain: 7,
      remoteRecipient: addressToBytes32(
        "0x0000000000000000000000000000000000000001"
      ),
    });

    const hookData2 = encodeForwardParams({
      ...baseParams,
      remoteDomain: 9,
      remoteRecipient: addressToBytes32(
        "0x0000000000000000000000000000000000000002"
      ),
    });

    const message1 = buildCctpMessage({
      mintRecipient: await router.getAddress(),
      amount: 1_000_000n,
      feeExecuted: 0n,
      cctpMaxFee: 0n,
      hookData: hookData1,
      nonce,
    });

    const message2 = buildCctpMessage({
      mintRecipient: await router.getAddress(),
      amount: 1_000_000n,
      feeExecuted: 0n,
      cctpMaxFee: 0n,
      hookData: hookData2,
      nonce,
    });

    await router.receiveAndForward(message1, "0x", 0n);
    await expect(
      router.receiveAndForward(message2, "0x", 0n)
    ).to.be.revertedWith("transfer settled");
  });

  // ────────────────────────────────────────────────────────────
  // Test 5: Empty inner hookData
  // ────────────────────────────────────────────────────────────
  it("should pass empty hookData to xReserve", async function () {
    const { router, xReserve, fallbackAddr } =
      await networkHelpers.loadFixture(deployFixture);

    const hookData = encodeForwardParams({
      fallbackRecipient: await fallbackAddr.getAddress(),
      remoteDomain: 7,
      remoteRecipient: addressToBytes32(
        "0x000000000000000000000000000000000000dEaD"
      ),
      maxFee: 0n,
      relayMaxFee: 0n,
      hookData: "0x",
    });

    const message = buildCctpMessage({
      mintRecipient: await router.getAddress(),
      amount: 1_000_000n,
      feeExecuted: 0n,
      cctpMaxFee: 0n,
      hookData,
    });

    await router.receiveAndForward(message, "0x", 0n);

    expect(await xReserve.lastHookData()).to.equal("0x");
  });

  // ────────────────────────────────────────────────────────────
  // Test 6: Non-empty inner hookData
  // ────────────────────────────────────────────────────────────
  it("should pass non-empty hookData through to xReserve", async function () {
    const { router, xReserve, fallbackAddr } =
      await networkHelpers.loadFixture(deployFixture);

    const innerHookData = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "address"],
      [42n, "0x000000000000000000000000000000000000bEEF"]
    );

    const hookData = encodeForwardParams({
      fallbackRecipient: await fallbackAddr.getAddress(),
      remoteDomain: 7,
      remoteRecipient: addressToBytes32(
        "0x000000000000000000000000000000000000dEaD"
      ),
      maxFee: 0n,
      relayMaxFee: 0n,
      hookData: innerHookData,
    });

    const message = buildCctpMessage({
      mintRecipient: await router.getAddress(),
      amount: 1_000_000n,
      feeExecuted: 0n,
      cctpMaxFee: 0n,
      hookData,
    });

    await router.receiveAndForward(message, "0x", 0n);

    expect(await xReserve.lastHookData()).to.equal(
      innerHookData.toLowerCase()
    );
  });

  // ────────────────────────────────────────────────────────────
  // Test 7: Multiple sequential relays
  // ────────────────────────────────────────────────────────────
  it("should handle multiple relays with correct amounts", async function () {
    const { router, xReserve, usdc, fallbackAddr } =
      await networkHelpers.loadFixture(deployFixture);

    const fallbackAddress = await fallbackAddr.getAddress();
    const routerAddress = await router.getAddress();

    // Relay 1: 5 USDC
    const hookData1 = encodeForwardParams({
      fallbackRecipient: fallbackAddress,
      remoteDomain: 7,
      remoteRecipient: addressToBytes32(
        "0x0000000000000000000000000000000000000001"
      ),
      maxFee: 0n,
      relayMaxFee: 0n,
      hookData: "0x",
    });

    const message1 = buildCctpMessage({
      mintRecipient: routerAddress,
      amount: 5_000_000n,
      feeExecuted: 0n,
      cctpMaxFee: 0n,
      hookData: hookData1,
      nonce: uintToBytes32(11),
    });

    await router.receiveAndForward(message1, "0x", 0n);
    expect(await xReserve.lastValue()).to.equal(5_000_000n);

    // Relay 2: 3 USDC with 100 fee
    const hookData2 = encodeForwardParams({
      fallbackRecipient: fallbackAddress,
      remoteDomain: 9,
      remoteRecipient: addressToBytes32(
        "0x0000000000000000000000000000000000000002"
      ),
      maxFee: 50n,
      relayMaxFee: 0n,
      hookData: "0x",
    });

    const message2 = buildCctpMessage({
      mintRecipient: routerAddress,
      amount: 3_000_000n,
      feeExecuted: 100n,
      cctpMaxFee: 200n,
      hookData: hookData2,
      nonce: uintToBytes32(12),
    });

    await router.receiveAndForward(message2, "0x", 0n);
    expect(await xReserve.lastValue()).to.equal(3_000_000n - 100n);
    expect(await xReserve.lastRemoteDomain()).to.equal(9);

    // Router should hold 0 USDC
    expect(await usdc.balanceOf(routerAddress)).to.equal(0n);
  });

  // ────────────────────────────────────────────────────────────
  // Test 8: Message too short
  // ────────────────────────────────────────────────────────────
  it("should revert when message is too short", async function () {
    const { router } = await networkHelpers.loadFixture(deployFixture);

    // 375 bytes = 1 byte short of the minimum 376
    const shortMessage = "0x" + "00".repeat(375);

    await expect(
      router.receiveAndForward(shortMessage, "0x", 0n)
    ).to.be.revertedWith("message too short");
  });

  // ────────────────────────────────────────────────────────────
  // Test 9: Constructor approval
  // ────────────────────────────────────────────────────────────
  it("should approve xReserve for max USDC in constructor", async function () {
    const { router, xReserve, usdc } =
      await networkHelpers.loadFixture(deployFixture);

    const allowance = await usdc.allowance(
      await router.getAddress(),
      await xReserve.getAddress()
    );
    expect(allowance).to.equal(ethers.MaxUint256);
  });

  // ────────────────────────────────────────────────────────────
  // Test 10: Immutables set correctly
  // ────────────────────────────────────────────────────────────
  it("should set immutables correctly in constructor", async function () {
    const { router, transmitter, xReserve, usdc, deployer } =
      await networkHelpers.loadFixture(deployFixture);

    expect(await router.transmitter()).to.equal(
      await transmitter.getAddress()
    );
    expect(await router.xReserve()).to.equal(await xReserve.getAddress());
    expect(await router.usdc()).to.equal(await usdc.getAddress());
    expect(await router.operatorWallet()).to.equal(await deployer.getAddress());
  });

  // ────────────────────────────────────────────────────────────
  // Test 11: Relay fee — happy path
  // ────────────────────────────────────────────────────────────
  it("should pay relay fee to msg.sender and forward remainder", async function () {
    const { router, xReserve, usdc, deployer, fallbackAddr } =
      await networkHelpers.loadFixture(deployFixture);

    const amount = 1_000_000n;
    const relayMaxFee = 5_000n;
    const relayFee = 3_000n;
    const relayerAddress = await deployer.getAddress();

    const hookData = encodeForwardParams({
      fallbackRecipient: await fallbackAddr.getAddress(),
      remoteDomain: 7,
      remoteRecipient: addressToBytes32(
        "0x000000000000000000000000000000000000dEaD"
      ),
      maxFee: 0n,
      relayMaxFee,
      hookData: "0x",
    });

    const message = buildCctpMessage({
      mintRecipient: await router.getAddress(),
      amount,
      feeExecuted: 0n,
      cctpMaxFee: 0n,
      hookData,
    });

    const expectedForward = amount - relayFee;

    await expect(router.receiveAndForward(message, "0x", relayFee))
      .to.emit(router, "Relayed")
      .withArgs(3, ZERO_BYTES32, ZERO_BYTES32, expectedForward, relayFee);

    expect(await xReserve.lastValue()).to.equal(expectedForward);
    expect(await usdc.balanceOf(relayerAddress)).to.equal(relayFee);
    expect(await usdc.balanceOf(await router.getAddress())).to.equal(0n);
  });

  // ────────────────────────────────────────────────────────────
  // Test 12: Relay fee — fallback still pays operator
  // ────────────────────────────────────────────────────────────
  it("should pay relay fee even when xReserve reverts (fallback)", async function () {
    const { router, xReserve, usdc, deployer, fallbackAddr } =
      await networkHelpers.loadFixture(deployFixture);

    await xReserve.setShouldRevert(true);

    const amount = 2_000_000n;
    const relayFee = 1_000n;
    const fallbackAddress = await fallbackAddr.getAddress();
    const relayerAddress = await deployer.getAddress();

    const hookData = encodeForwardParams({
      fallbackRecipient: fallbackAddress,
      remoteDomain: 7,
      remoteRecipient: addressToBytes32(
        "0x000000000000000000000000000000000000dEaD"
      ),
      maxFee: 0n,
      relayMaxFee: 10_000n,
      hookData: "0x",
    });

    const message = buildCctpMessage({
      mintRecipient: await router.getAddress(),
      amount,
      feeExecuted: 0n,
      cctpMaxFee: 0n,
      hookData,
    });

    const expectedFallback = amount - relayFee;

    await expect(router.receiveAndForward(message, "0x", relayFee))
      .to.emit(router, "FallbackTriggered")
      .withArgs(fallbackAddress, expectedFallback, relayFee);

    expect(await usdc.balanceOf(relayerAddress)).to.equal(relayFee);
    expect(await usdc.balanceOf(fallbackAddress)).to.equal(expectedFallback);
    expect(await usdc.balanceOf(await router.getAddress())).to.equal(0n);
  });

  // ────────────────────────────────────────────────────────────
  // Test 13: Relay fee exceeds relayMaxFee
  // ────────────────────────────────────────────────────────────
  it("should revert when relayFee exceeds relayMaxFee", async function () {
    const { router, fallbackAddr } =
      await networkHelpers.loadFixture(deployFixture);

    const hookData = encodeForwardParams({
      fallbackRecipient: await fallbackAddr.getAddress(),
      remoteDomain: 7,
      remoteRecipient: ZERO_BYTES32,
      maxFee: 0n,
      relayMaxFee: 500n,
      hookData: "0x",
    });

    const message = buildCctpMessage({
      mintRecipient: await router.getAddress(),
      amount: 1_000_000n,
      feeExecuted: 0n,
      cctpMaxFee: 0n,
      hookData,
    });

    await expect(
      router.receiveAndForward(message, "0x", 501n)
    ).to.be.revertedWith("relay fee exceeds max");
  });

  // ────────────────────────────────────────────────────────────
  // Test 14: Relay fee equals minted amount
  // ────────────────────────────────────────────────────────────
  it("should revert when relayFee equals minted amount", async function () {
    const { router, fallbackAddr } =
      await networkHelpers.loadFixture(deployFixture);

    const amount = 1_000_000n;

    const hookData = encodeForwardParams({
      fallbackRecipient: await fallbackAddr.getAddress(),
      remoteDomain: 7,
      remoteRecipient: ZERO_BYTES32,
      maxFee: 0n,
      relayMaxFee: amount,
      hookData: "0x",
    });

    const message = buildCctpMessage({
      mintRecipient: await router.getAddress(),
      amount,
      feeExecuted: 0n,
      cctpMaxFee: 0n,
      hookData,
    });

    await expect(
      router.receiveAndForward(message, "0x", amount)
    ).to.be.revertedWith("relay fee too high");
  });

  // ────────────────────────────────────────────────────────────
  // Test 15: Relay fee of zero (backward compatible)
  // ────────────────────────────────────────────────────────────
  it("should forward full amount when relayFee is 0", async function () {
    const { router, xReserve, usdc, deployer, fallbackAddr } =
      await networkHelpers.loadFixture(deployFixture);

    const amount = 1_000_000n;

    const hookData = encodeForwardParams({
      fallbackRecipient: await fallbackAddr.getAddress(),
      remoteDomain: 7,
      remoteRecipient: addressToBytes32(
        "0x000000000000000000000000000000000000dEaD"
      ),
      maxFee: 0n,
      relayMaxFee: 5_000n,
      hookData: "0x",
    });

    const message = buildCctpMessage({
      mintRecipient: await router.getAddress(),
      amount,
      feeExecuted: 0n,
      cctpMaxFee: 0n,
      hookData,
    });

    await expect(router.receiveAndForward(message, "0x", 0n))
      .to.emit(router, "Relayed")
      .withArgs(3, ZERO_BYTES32, ZERO_BYTES32, amount, 0n);

    expect(await xReserve.lastValue()).to.equal(amount);
    expect(await usdc.balanceOf(await deployer.getAddress())).to.equal(0n);
  });

  // ────────────────────────────────────────────────────────────
  // Test 16: Constructor zero-address guards
  // ────────────────────────────────────────────────────────────
  it("should revert deployment on zero constructor addresses", async function () {
    const { transmitter, xReserve, usdc, deployer } =
      await networkHelpers.loadFixture(deployFixture);

    const routerFactory = await ethers.getContractFactory("XReserveRouter");

    await expect(
      routerFactory.deploy(
        ethers.ZeroAddress,
        await xReserve.getAddress(),
        await usdc.getAddress(),
        await deployer.getAddress()
      )
    ).to.be.revertedWith("zero transmitter");

    await expect(
      routerFactory.deploy(
        await transmitter.getAddress(),
        ethers.ZeroAddress,
        await usdc.getAddress(),
        await deployer.getAddress()
      )
    ).to.be.revertedWith("zero xReserve");

    await expect(
      routerFactory.deploy(
        await transmitter.getAddress(),
        await xReserve.getAddress(),
        ethers.ZeroAddress,
        await deployer.getAddress()
      )
    ).to.be.revertedWith("zero usdc");

    await expect(
      routerFactory.deploy(
        await transmitter.getAddress(),
        await xReserve.getAddress(),
        await usdc.getAddress(),
        ethers.ZeroAddress
      )
    ).to.be.revertedWith("zero operator");
  });
});
