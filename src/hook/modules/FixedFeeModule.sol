// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IBrownieModule} from "../IBrownieModule.sol";

/// The simplest module: one buy fee, one sell fee, nothing else. The launch module.
contract FixedFeeModule is IBrownieModule {
    uint16 public immutable BUY_BPS;
    uint16 public immutable SELL_BPS;

    constructor(uint16 buyBps, uint16 sellBps) {
        BUY_BPS = buyBps;
        SELL_BPS = sellBps;
    }

    function moduleId() external pure returns (bytes32) {
        return keccak256("brownies.module.fixed-fee.v1");
    }

    function phases() external pure returns (uint16) {
        return 0;
    }

    function feeFor(SwapView calldata s) external view returns (uint16, uint16) {
        return (s.buy ? BUY_BPS : SELL_BPS, 0);
    }

    function onAfterSwap(SwapView calldata, int128, int128, uint256) external pure {}

    function onPhase(uint16, address, bytes calldata) external pure {}
}
