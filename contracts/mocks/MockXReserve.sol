// SPDX-License-Identifier: MIT
pragma solidity ^0.7.6;
pragma abicoder v2;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Simulates xReserve.depositToRemote().
///      Records the last call's arguments for assertion in tests.
///      Can be configured to revert to test the fallback path.
contract MockXReserve {
    bool public shouldRevert;

    // Recorded call data from the last depositToRemote call
    bool    public called;
    uint256 public lastValue;
    uint32  public lastRemoteDomain;
    bytes32 public lastRemoteRecipient;
    address public lastLocalToken;
    uint256 public lastMaxFee;
    bytes   public lastHookData;

    function setShouldRevert(bool _shouldRevert) external {
        shouldRevert = _shouldRevert;
    }

    function depositToRemote(
        uint256 value,
        uint32 remoteDomain,
        bytes32 remoteRecipient,
        address localToken,
        uint256 maxFee,
        bytes calldata hookData
    ) external {
        if (shouldRevert) {
            revert("MockXReserve: forced revert");
        }

        // Pull tokens from caller (same as real xReserve)
        IERC20(localToken).transferFrom(msg.sender, address(this), value);

        // Record call data
        called = true;
        lastValue = value;
        lastRemoteDomain = remoteDomain;
        lastRemoteRecipient = remoteRecipient;
        lastLocalToken = localToken;
        lastMaxFee = maxFee;
        lastHookData = hookData;
    }
}
