// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IWETH9} from "./interfaces/IBrownies.sol";

/*
  StudioSplitter: the studio's slice of a client coin's creator fee.

  When the Brownies studio launches a coin for a client, this contract is the coin's creator on Programmable, so
  the creator's fee (WETH, claimable by anyone from the launch's ledger) lands here. Anyone may then call split():
  plain ETH that arrived is wrapped, and the whole WETH balance is paid out at once, STUDIO_BPS to the studio
  wallet and the rest to the client. Nothing else: no owner, no admin, no pause, no rescue, no way to change the
  two wallets or the share after deployment. The share is capped at half, so a client can never be given less than
  the studio takes. One contract per client coin; the constructor is the whole deal.
*/
contract StudioSplitter {
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_STUDIO_BPS = 5_000;

    IWETH9 public immutable WETH;
    address public immutable STUDIO; // the Brownies studio wallet
    address public immutable CLIENT; // the client's wallet
    uint256 public immutable STUDIO_BPS;

    uint256 public totalToStudio;
    uint256 public totalToClient;

    event Split(uint256 amount, uint256 toStudio, uint256 toClient);

    error ZeroAddress();
    error BadShare(uint256 bps);
    error SameWallet();
    error Nothing();
    error TransferFailed();

    constructor(address weth, address studio, address client, uint256 studioBps) {
        if (weth == address(0) || studio == address(0) || client == address(0)) revert ZeroAddress();
        if (studio == client) revert SameWallet();
        if (studioBps == 0 || studioBps > MAX_STUDIO_BPS) revert BadShare(studioBps);
        WETH = IWETH9(weth);
        STUDIO = studio;
        CLIENT = client;
        STUDIO_BPS = studioBps;
    }

    /// The ledger pays in WETH; a kind soul may also send ETH. Both are split the same way.
    receive() external payable {}

    /// Everything waiting here, ETH and WETH together.
    function pending() external view returns (uint256) {
        return address(this).balance + WETH.balanceOf(address(this));
    }

    /// Pay out everything that is here: the studio's share, then the client's. Anyone may call it.
    function split() external {
        uint256 loose = address(this).balance;
        if (loose != 0) WETH.deposit{value: loose}();
        uint256 bal = WETH.balanceOf(address(this));
        if (bal == 0) revert Nothing();
        uint256 toStudio = bal * STUDIO_BPS / BPS;
        uint256 toClient = bal - toStudio;
        totalToStudio += toStudio;
        totalToClient += toClient;
        if (toStudio != 0 && !WETH.transfer(STUDIO, toStudio)) revert TransferFailed();
        if (!WETH.transfer(CLIENT, toClient)) revert TransferFailed();
        emit Split(bal, toStudio, toClient);
    }
}
