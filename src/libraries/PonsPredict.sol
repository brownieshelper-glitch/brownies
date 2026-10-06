// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/*
  Predict the address Pons v2 will give a coin before launching it. Pons deploys deterministically from the launch
  parameters (PonsV2LaunchDeployer.predictLaunchAddresses), so the token address can be fixed in the harvester's
  constructor first and the launch made afterwards with exactly the same parameters. The fork test and the deploy
  script both go through this one function, so what was rehearsed is what is broadcast.
*/

import {IPonsV2Factory, IPonsV2MemeHook, IPonsV2LaunchDeployer, PonsLaunchDeployment} from "../interfaces/IPonsV2.sol";

library PonsPredict {
    /// The token and curve Pons will create for `launcher` calling launchToken(params, configId, ETH pair, ...).
    function predict(IPonsV2Factory pons, IPonsV2Factory.TokenParams memory p, uint256 configId, address launcher)
        internal
        view
        returns (address token, address curve)
    {
        IPonsV2Factory.LaunchConfig memory cfg = pons.getLaunchConfig(configId);
        address hook = pons.memeHook();
        PonsLaunchDeployment memory ld;
        ld.pairToken = address(0);
        ld.creatorFeeRecipient = p.creatorFeeRecipient;
        ld.originalDeployer = launcher;
        ld.feePolicy = hook;
        ld.policy = IPonsV2MemeHook(hook).currentFeePolicy();
        ld.feeEscrow = pons.feeEscrow();
        ld.buybackVault = pons.buybackVault();
        ld.phantomQuote = cfg.phantomQuote;
        ld.curveFeeBps = cfg.curveFeeBps;
        ld.creatorTaxBps = p.creatorTaxBps;
        ld.buybackEnabled = p.buybackEnabled;
        ld.graduationThreshold = cfg.graduationThreshold;
        ld.supply = cfg.supply;
        ld.salt = p.salt;
        ld.name = p.name;
        ld.symbol = p.symbol;
        ld.logo = p.logo;
        ld.description = p.description;
        ld.socials = p.socials;
        (token, curve) = IPonsV2LaunchDeployer(pons.launchDeployer()).predictLaunchAddresses(ld);
    }

    /// The CREATE address of `deployer` at `nonce`: keccak256(rlp([deployer, nonce])), any nonce up to 2^32 - 1.
    function createAddress(address deployer, uint256 nonce) internal pure returns (address) {
        bytes memory n;
        if (nonce == 0) n = hex"80";
        else if (nonce < 0x80) n = abi.encodePacked(bytes1(uint8(nonce)));
        else if (nonce < 0x100) n = abi.encodePacked(bytes1(0x81), bytes1(uint8(nonce)));
        else if (nonce < 0x10000) n = abi.encodePacked(bytes1(0x82), bytes2(uint16(nonce)));
        else if (nonce < 0x1000000) n = abi.encodePacked(bytes1(0x83), bytes3(uint24(nonce)));
        else n = abi.encodePacked(bytes1(0x84), bytes4(uint32(nonce)));
        bytes memory rlp = abi.encodePacked(bytes1(uint8(0xc0 + 21 + n.length)), bytes1(0x94), deployer, n);
        return address(uint160(uint256(keccak256(rlp))));
    }
}
