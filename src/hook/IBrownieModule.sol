// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/*
  A module is the part of the BROWNIE hook that can change after launch. The hook (BrownieHook) is immutable and asks
  the module two things: what fee this swap pays, and whether it wants to hear about the pool's events. The hook
  bounds everything the module says: the fee never passes the ceilings written into the hook, the module's share of
  the fee never passes its cap, a failing module never blocks a trade (the base fee applies), and a new module only
  takes effect after the hook's delay. So a module can add functions to the coin for ever, inside walls that do not move.

  feeFor()  is a view: it runs inside every swap with a gas budget. Keep it cheap.
  onPhase() runs after the hook's own work for the phases the module asked for in phases(). For the "before" phases
            a revert blocks the action (that is what those phases are for); for the "after" phases a revert is
            ignored and logged. A module that wants no events returns phases() == 0 and the hook never calls it.
*/
/// Phase bits for phases() and onPhase(). The before-swap phase is feeFor() itself.
library Phases {
    uint16 internal constant AFTER_SWAP = 1;
    uint16 internal constant BEFORE_ADD_LIQUIDITY = 2;
    uint16 internal constant AFTER_ADD_LIQUIDITY = 4;
    uint16 internal constant BEFORE_REMOVE_LIQUIDITY = 8;
    uint16 internal constant AFTER_REMOVE_LIQUIDITY = 16;
    uint16 internal constant BEFORE_DONATE = 32;
    uint16 internal constant AFTER_DONATE = 64;
    uint16 internal constant AFTER_INITIALIZE = 128;
}

interface IBrownieModule {
    struct SwapView {
        bytes32 poolId;
        address router; // the contract that called the pool manager (the Universal Router for ordinary trades)
        bool buy; // the swapper gives the quote (ETH as WETH) and receives the coin
        bool exactInput;
        uint256 specifiedAmount;
    }

    function moduleId() external view returns (bytes32);
    function phases() external view returns (uint16);

    /// The fee of this swap in basis points of its ETH value, and the share of that fee (in basis points) the module
    /// keeps for its own purposes (buybacks, rewards, games). The hook clamps both.
    function feeFor(SwapView calldata s) external view returns (uint16 feeBps, uint16 moduleShareBps);

    /// After a swap: the deltas as the swapper saw them (negative = paid) and the fee the hook took.
    function onAfterSwap(SwapView calldata s, int128 quoteDelta, int128 tokenDelta, uint256 fee) external;

    /// Any other phase. `data` is the abi encoding of the pool manager's own callback arguments.
    function onPhase(uint16 phase, address sender, bytes calldata data) external;
}
