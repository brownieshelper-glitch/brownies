// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/*//////////////////////////////////////////////////////////////////////////
                 BrownieCore, the five launch contracts in one transaction
//////////////////////////////////////////////////////////////////////////*/
/*
  Staking and the minter need SUGAR's address in their constructors, and SUGAR needs theirs: a cycle that only address
  prediction breaks. A fresh contract's CREATE addresses are exact (its nonce starts at 1 and counts its own
  creations), so this contract deploys everything in its constructor and checks the prediction before it finishes.
  One transaction, no initializer: every child is born with its immutables final.

  Order, by this contract's nonce: 1 staking, 2 minter, 3 SUGAR, 4 team vault, 5 harvester.

  The BROWNIE token address is itself computed before the launch (Programmable deploys the coin with CREATE2 from the
  creator, the salt and the metadata, and the creator is the harvester, child 5 of this contract) and passed in; the
  launch that follows must use exactly those parameters, and the deploy script checks the two match before it
  broadcasts anything.
*/

import {Sugar} from "./Sugar.sol";
import {SugarMinter} from "./SugarMinter.sol";
import {BrownieStaking} from "./BrownieStaking.sol";
import {BrownieHarvester} from "./BrownieHarvester.sol";
import {TeamVault} from "./TeamVault.sol";
import {ISugar} from "./interfaces/IBrownies.sol";

contract BrownieCore {
    BrownieStaking public immutable STAKING;
    SugarMinter public immutable MINTER;
    Sugar public immutable SUGAR;
    TeamVault public immutable TEAM_VAULT;
    BrownieHarvester public immutable HARVESTER;

    /// The harvester is this contract's fifth child; the launch names it as the coin's creator, so it must be known first.
    uint256 public constant HARVESTER_NONCE = 5;

    error Misprediction(address predicted, address actual);

    struct Config {
        address token; // BROWNIE, the coin, computed before the launch
        address weth;
        address usdc;
        address wethUsdcPool; // Uniswap v3, deep and with price history
        address mainWallet; // the protocol's cut
        address fundingWallet; // the inference funding wallet
        address teamOwner; // who chooses the brownies in the team vault, and holds the harvester's switch
        uint256 minPosition; // BROWNIE wei
    }

    constructor(Config memory c) {
        address predictedSugar = _createAddress(address(this), 3);
        STAKING = new BrownieStaking(c.token, predictedSugar, c.usdc, c.fundingWallet, c.minPosition, c.teamOwner);
        MINTER = new SugarMinter(c.usdc, predictedSugar, c.fundingWallet);
        SUGAR = new Sugar(address(STAKING), address(MINTER));
        if (address(SUGAR) != predictedSugar) revert Misprediction(predictedSugar, address(SUGAR));
        TEAM_VAULT = new TeamVault(address(SUGAR), c.teamOwner);
        HARVESTER = new BrownieHarvester(
            c.token, c.weth, c.usdc, c.wethUsdcPool, address(STAKING), address(MINTER), c.mainWallet, address(TEAM_VAULT), c.teamOwner
        );
    }

    /// The CREATE address of `deployer` at `nonce`, for nonces under 128 (RLP of a short list).
    function _createAddress(address deployer, uint256 nonce) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xd6), bytes1(0x94), deployer, bytes1(uint8(nonce)))))));
    }
}
