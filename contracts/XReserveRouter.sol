// SPDX-License-Identifier: MIT
pragma solidity ^0.7.6;
pragma abicoder v2;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

// ──────────────────────────────────────────────────────────────────
//  External interfaces
// ──────────────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────────────
//  ForwardParams — ABI-encoded into the CCTP BurnMessageV2 hookData
//  by the user on the source chain.
// ──────────────────────────────────────────────────────────────────

struct ForwardParams {
    address fallbackRecipient; // receives USDC if depositToRemote fails
    uint32  remoteDomain;      // xReserve domain ID (not a chain ID)
    bytes32 remoteRecipient;   // USDCx recipient on the partner chain
    uint256 maxFee;            // fee budget for xReserve relayer
    uint256 relayMaxFee;       // max USDC the relay operator may claim
    bytes   hookData;          // optional data for xReserve hook executor
}

// ──────────────────────────────────────────────────────────────────
//  XReserveRouter
//
//  Receives USDC via CCTP v2 and atomically forwards it into
//  xReserve's depositToRemote in a single transaction.
//
//  CCTP MessageV2 layout (abi.encodePacked, 148-byte fixed header):
//    [0..4)     version            uint32
//    [4..8)     sourceDomain       uint32
//    [8..12)    destinationDomain  uint32
//    [12..44)   nonce              bytes32
//    [44..76)   sender             bytes32
//    [76..108)  recipient          bytes32
//    [108..140) destinationCaller  bytes32
//    [140..144) minFinalityThresh  uint32
//    [144..148) finalityExec       uint32
//    [148..)    messageBody        bytes    ← BurnMessageV2
//
//  BurnMessageV2 layout (offsets relative to messageBody start):
//    [0..4)     version            uint32
//    [4..36)    burnToken          bytes32
//    [36..68)   mintRecipient      bytes32
//    [68..100)  amount             uint256
//    [100..132) messageSender      bytes32
//    [132..164) maxFee (CCTP)      uint256
//    [164..196) feeExecuted        uint256
//    [196..228) expirationBlock    uint256
//    [228..)    hookData           bytes    ← ForwardParams (abi.encode)
// ──────────────────────────────────────────────────────────────────

contract XReserveRouter {
    using SafeERC20 for IERC20;

    // ── Byte offsets (absolute, from start of full CCTP message) ──

    // Outer MessageV2 header ends / BurnMessageV2 body begins
    uint256 private constant MSG_BODY_OFFSET = 148;
    uint256 private constant SOURCE_DOMAIN_OFFSET = 4;
    uint256 private constant DESTINATION_DOMAIN_OFFSET = 8;
    uint256 private constant NONCE_OFFSET = 12;
    uint256 private constant DESTINATION_CALLER_OFFSET = 108;
    uint256 private constant NONCE_USED = 1;
    uint32 private constant ETHEREUM_CCTP_DOMAIN = 0;
    uint8 private constant OPERATOR_ROUTE_EMPTY_HOOK_DATA = 1;
    uint8 private constant OPERATOR_ROUTE_MALFORMED_HOOK_DATA = 2;

    // BurnMessageV2 fields (absolute = MSG_BODY_OFFSET + relative)
    uint256 private constant MINT_RECIPIENT_OFFSET = MSG_BODY_OFFSET + 36; // 184
    uint256 private constant AMOUNT_OFFSET       = MSG_BODY_OFFSET + 68;   // 216
    uint256 private constant MESSAGE_SENDER_OFFSET = MSG_BODY_OFFSET + 100; // 248
    uint256 private constant FEE_EXECUTED_OFFSET  = MSG_BODY_OFFSET + 164;  // 312
    uint256 private constant HOOK_DATA_OFFSET     = MSG_BODY_OFFSET + 228;  // 376

    // Minimum valid message length: 148-byte header + 228-byte min body
    uint256 private constant MIN_MESSAGE_LENGTH = 376;

    // ── Immutables ───────────────────────────────────────────────

    IMessageTransmitterV2 public immutable transmitter;
    IXReserve             public immutable xReserve;
    IERC20                public immutable usdc;
    address               public immutable operatorWallet;

    // replay protection for already-settled transfers by canonical key:
    // keccak256(abi.encodePacked(sourceDomain, nonce))
    mapping(bytes32 => bool) public settledTransfers;

    // ── Events ───────────────────────────────────────────────────

    event Relayed(
        uint32 indexed sourceDomain,
        bytes32 indexed sourceSender,
        bytes32 indexed nonce,
        uint256 amount,
        uint256 relayFee
    );

    event FallbackTriggered(
        address indexed fallbackRecipient,
        uint256 amount,
        uint256 relayFee
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

    // ── Constructor ──────────────────────────────────────────────

    constructor(
        address _transmitter,
        address _xReserve,
        address _usdc,
        address _operatorWallet
    ) {
        require(_transmitter != address(0), "zero transmitter");
        require(_xReserve != address(0), "zero xReserve");
        require(_usdc != address(0), "zero usdc");
        require(_operatorWallet != address(0), "zero operator");

        transmitter = IMessageTransmitterV2(_transmitter);
        xReserve    = IXReserve(_xReserve);
        usdc        = IERC20(_usdc);
        operatorWallet = _operatorWallet;

        // Grant xReserve an infinite allowance so depositToRemote
        // can pull USDC from this contract via safeTransferFrom.
        IERC20(_usdc).safeApprove(_xReserve, type(uint256).max);
    }

    // ── Core Function ────────────────────────────────────────────

    /// @notice Mint USDC via CCTP and forward it to xReserve in one tx.
    /// @param message     The full CCTP MessageV2 bytes (header + BurnMessageV2 body).
    /// @param attestation The Circle-attested signature over `message`.
    /// @param relayFee    USDC fee claimed by the relay operator (must be <= relayMaxFee in ForwardParams).
    function receiveAndForward(
        bytes calldata message,
        bytes calldata attestation,
        uint256 relayFee
    ) external {
        // ── 1. Validate minimum length ───────────────────────────
        require(message.length >= MIN_MESSAGE_LENGTH, "message too short");
        bytes32 nonce = _readBytes32(message, NONCE_OFFSET);
        uint32 sourceDomain = _readUint32(message, SOURCE_DOMAIN_OFFSET);
        bytes32 transferId = bytes32(0);

        {
            uint32 destinationDomain = _readUint32(message, DESTINATION_DOMAIN_OFFSET);
            require(destinationDomain == ETHEREUM_CCTP_DOMAIN, "invalid destinationDomain");

            bytes32 destinationCaller = _readBytes32(message, DESTINATION_CALLER_OFFSET);
            bytes32 routerAsBytes32 = _toBytes32Address(address(this));
            require(
                destinationCaller == bytes32(0) || destinationCaller == routerAsBytes32,
                "invalid destinationCaller"
            );

            transferId = _transferId(sourceDomain, nonce);
            require(!settledTransfers[transferId], "transfer settled");

            // ── 2. Parse BurnMessageV2 fields via calldata slicing ───
            //
            // mintRecipient: absolute bytes [184..216)
            // amount:       absolute bytes [216..248)
            // feeExecuted:  absolute bytes [312..344)
            // hookData:     absolute bytes [376..end)
            //
            // These are uint256 values encoded as big-endian 32-byte words
            // (abi.encodePacked for fixed-size fields).
            bytes32 mintRecipient = _readBytes32(message, MINT_RECIPIENT_OFFSET);
            require(
                mintRecipient == routerAsBytes32,
                "invalid mintRecipient"
            );
        }

        uint256 expectedMintedAmount = 0;
        {
            uint256 amount = _readUint256(message, AMOUNT_OFFSET);
            uint256 feeExecuted = _readUint256(message, FEE_EXECUTED_OFFSET);

            // CCTP attestation must always have amount > feeExecuted.
            // Keep this explicit because Solidity 0.7.x arithmetic is unchecked.
            require(amount > feeExecuted, "invalid fee");
            expectedMintedAmount = amount - feeExecuted;
        }

        // ── 3. Mint USDC to this contract via CCTP ───────────────
        // This verifies the attestation, marks the nonce as used,
        // and mints (amount - feeExecuted) USDC to this contract
        // (mintRecipient encoded in the BurnMessageV2).
        uint256 balanceBefore = usdc.balanceOf(address(this));
        uint256 mintedAmount = 0;

        try transmitter.receiveMessage(message, attestation) returns (bool received) {
            require(received, "receive failed");
            uint256 balanceAfter = usdc.balanceOf(address(this));
            require(balanceAfter >= balanceBefore, "balance mismatch");

            // Forward only what this call actually minted.
            mintedAmount = balanceAfter - balanceBefore;
            require(mintedAmount == expectedMintedAmount, "mint mismatch");
        } catch Error(string memory reason) {
            require(_stringEq(reason, "Nonce already used"), "receive reverted");
            require(transmitter.usedNonces(nonce) == NONCE_USED, "nonce not used");

            // In recovery mode, this tx mints nothing; use the attested amount
            // and ensure the router already holds enough balance to settle it.
            uint256 balanceAfter = usdc.balanceOf(address(this));
            require(balanceAfter >= expectedMintedAmount, "insufficient recovered");
            mintedAmount = expectedMintedAmount;

            emit RecoveredFromConsumedNonce(nonce, mintedAmount);
        } catch (bytes memory) {
            revert("receive reverted");
        }

        require(mintedAmount > 0, "zero minted amount");
        _settleAndRoute(
            message,
            transferId,
            sourceDomain,
            nonce,
            mintedAmount,
            relayFee
        );
    }

    /// @notice Decodes BurnMessageV2 hookData as ForwardParams.
    /// @dev External self-call target used so decode failures can be caught.
    function decodeForwardParams(
        bytes calldata rawHookData
    ) external pure returns (ForwardParams memory params) {
        params = abi.decode(rawHookData, (ForwardParams));
    }

    function _settleAndRoute(
        bytes calldata message,
        bytes32 transferId,
        uint32 sourceDomain,
        bytes32 nonce,
        uint256 mintedAmount,
        uint256 relayFee
    ) private {
        bytes32 sourceSender = _readBytes32(message, MESSAGE_SENDER_OFFSET);
        bytes calldata rawHookData = message[HOOK_DATA_OFFSET:];

        settledTransfers[transferId] = true;

        if (rawHookData.length == 0) {
            _routeToOperator(
                transferId,
                nonce,
                mintedAmount,
                OPERATOR_ROUTE_EMPTY_HOOK_DATA
            );
            return;
        }

        try this.decodeForwardParams(rawHookData) returns (ForwardParams memory params) {
            require(params.fallbackRecipient != address(0), "zero fallback");
            require(relayFee <= params.relayMaxFee, "relay fee exceeds max");
            require(mintedAmount > relayFee, "relay fee too high");

            // ── 4. Pay relay operator, then forward remainder ────────
            if (relayFee > 0) {
                usdc.safeTransfer(msg.sender, relayFee);
            }

            uint256 forwardAmount = mintedAmount - relayFee;

            try xReserve.depositToRemote(
                forwardAmount,
                params.remoteDomain,
                params.remoteRecipient,
                address(usdc),
                params.maxFee,
                params.hookData
            ) {
                emit Relayed(
                    sourceDomain,
                    sourceSender,
                    nonce,
                    forwardAmount,
                    relayFee
                );
            } catch {
                usdc.safeTransfer(params.fallbackRecipient, forwardAmount);
                emit FallbackTriggered(params.fallbackRecipient, forwardAmount, relayFee);
            }
        } catch {
            _routeToOperator(
                transferId,
                nonce,
                mintedAmount,
                OPERATOR_ROUTE_MALFORMED_HOOK_DATA
            );
        }
    }

    // ── Internal Helpers ─────────────────────────────────────────

    /// @dev Read a uint256 from a bytes calldata at the given byte offset.
    ///      Uses abi.decode on a 32-byte calldata slice. Works because
    ///      a big-endian uint256 has identical encoding in both
    ///      abi.encodePacked and standard ABI encoding.
    function _readUint256(
        bytes calldata data,
        uint256 offset
    ) private pure returns (uint256 value) {
        (value) = abi.decode(data[offset:offset + 32], (uint256));
    }

    /// @dev Read a bytes32 from bytes calldata at the given byte offset.
    function _readBytes32(
        bytes calldata data,
        uint256 offset
    ) private pure returns (bytes32 value) {
        (value) = abi.decode(data[offset:offset + 32], (bytes32));
    }

    /// @dev Read a uint32 from bytes calldata at the given byte offset.
    function _readUint32(
        bytes calldata data,
        uint256 offset
    ) private pure returns (uint32 value) {
        uint256 raw;
        assembly {
            raw := calldataload(add(data.offset, offset))
        }
        value = uint32(raw >> 224);
    }

    /// @dev Build canonical transfer identity from sourceDomain + nonce.
    function _transferId(
        uint32 sourceDomain,
        bytes32 nonce
    ) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(sourceDomain, nonce));
    }

    /// @dev Convert an address to the left-padded bytes32 format used by CCTP.
    function _toBytes32Address(address account)
        private
        pure
        returns (bytes32)
    {
        return bytes32(uint256(uint160(account)));
    }

    /// @dev Compare two strings by keccak hash.
    function _stringEq(string memory a, string memory b)
        private
        pure
        returns (bool)
    {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    function _routeToOperator(
        bytes32 transferId,
        bytes32 nonce,
        uint256 amount,
        uint8 reason
    ) private {
        usdc.safeTransfer(operatorWallet, amount);
        emit OperatorRouted(transferId, nonce, amount, reason);
    }
}
