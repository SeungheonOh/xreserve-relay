// SPDX-License-Identifier: MIT
pragma solidity ^0.7.6;

import "./MockUSDC.sol";

/// @dev Simulates MessageTransmitterV2.receiveMessage().
///      Parses the BurnMessageV2 body from the CCTP message to extract
///      amount, feeExecuted, and mintRecipient, then mints
///      (amount - feeExecuted) USDC to the mintRecipient.
contract MockMessageTransmitter {
    MockUSDC public immutable usdc;
    bool public shouldReturnFalse;
    bool public shouldRevert;
    mapping(bytes32 => uint256) public usedNonces;

    // MessageV2 header = 148 bytes
    // BurnMessageV2 offsets within body:
    //   mintRecipient: 36..68  (absolute 184..216)
    //   amount:        68..100 (absolute 216..248)
    //   feeExecuted:   164..196 (absolute 312..344)

    uint256 private constant MINT_RECIPIENT_OFFSET = 184;
    uint256 private constant NONCE_OFFSET          = 12;
    uint256 private constant AMOUNT_OFFSET         = 216;
    uint256 private constant FEE_EXECUTED_OFFSET   = 312;

    constructor(address _usdc) {
        usdc = MockUSDC(_usdc);
    }

    function setShouldReturnFalse(bool _shouldReturnFalse) external {
        shouldReturnFalse = _shouldReturnFalse;
    }

    function setShouldRevert(bool _shouldRevert) external {
        shouldRevert = _shouldRevert;
    }

    function receiveMessage(
        bytes calldata message,
        bytes calldata /* attestation */
    ) external returns (bool) {
        if (shouldRevert) {
            revert("MockMessageTransmitter: forced revert");
        }

        if (shouldReturnFalse) {
            return false;
        }

        bytes32 nonce = abi.decode(
            message[NONCE_OFFSET:NONCE_OFFSET + 32],
            (bytes32)
        );
        if (usedNonces[nonce] == 1) {
            revert("Nonce already used");
        }
        usedNonces[nonce] = 1;

        // Parse mintRecipient (bytes32, take low 20 bytes as address)
        bytes32 recipientRaw = abi.decode(
            message[MINT_RECIPIENT_OFFSET:MINT_RECIPIENT_OFFSET + 32],
            (bytes32)
        );
        address mintRecipient = address(uint160(uint256(recipientRaw)));

        // Parse amount and feeExecuted
        uint256 amount      = abi.decode(message[AMOUNT_OFFSET:AMOUNT_OFFSET + 32], (uint256));
        uint256 feeExecuted = abi.decode(message[FEE_EXECUTED_OFFSET:FEE_EXECUTED_OFFSET + 32], (uint256));

        // Mint (amount - feeExecuted) to mintRecipient
        usdc.mint(mintRecipient, amount - feeExecuted);

        return true;
    }
}
