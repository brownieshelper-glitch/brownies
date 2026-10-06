// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/*
  The parts of the Pons v2 launchpad on Robinhood Chain (4663) that HELIX point 4 uses (LONGSHORT.md A28.0, A28.5).
  Written from the verified sources (Sourcify, PonsV2LaunchFactory 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e,
  PonsV2MemeHook 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044, PonsV2FeeEscrow 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e).
  Only the ABI matters here: struct layouts and argument orders are copied exactly, enums are uint8 on the wire.

  HELIX calls exactly these non-view functions of Pons: launchToken (4-argument overload, the adapter), curve.buy (the
  adapter, once, in the launch transaction), curve.sweepFees(0), memeHook.sweepPoolFees(poolId, 0, 0) and
  escrow.claim(amount) (the tax router, as the coin's creator fee recipient). transferCreatorFeeRecipient and
  setBuybackEnabled are deliberately NOT declared here: no HELIX contract can call them.
*/

interface IPonsV2Factory {
    struct Socials {
        string twitter;
        string telegram;
        string discord;
        string website;
        string farcaster;
    }

    struct TokenParams {
        string name;
        string symbol;
        string logo;
        string description;
        Socials socials;
        address creatorFeeRecipient;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        bytes32 expectedEconomics;
        bytes32 salt;
    }

    struct LaunchConfig {
        uint256 supply;
        uint256 curveFeeBps;
        uint256 phantomQuote;
        uint256 graduationThreshold;
        uint24 poolFee;
        int24 tickSpacing;
        bool enabled;
    }

    /// phase: 0 NotGraduated (curve), 1 Swept, 2 PoolCreated (Pons v4 pool), 3 Rescued
    struct LaunchedToken {
        address token;
        address curve;
        address deployer;
        address creatorFeeRecipient;
        address pairToken;
        uint256 graduationThreshold;
        uint24 poolFee;
        int24 tickSpacing;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        uint8 phase;
        uint256 sweptQuote;
        uint256 sweptTokens;
        uint256 sweptAt;
        bool exists;
    }

    function launchFee() external view returns (uint256);
    function launchEnabled() external view returns (bool);
    function canLaunch(address launcher) external view returns (bool);
    function maxCreatorTaxBps() external view returns (uint256);
    function snipeTaxStartBps() external view returns (uint256);
    function snipeTaxSeconds() external view returns (uint256);
    function launchConfigCount() external view returns (uint256);
    function getLaunchConfig(uint256 id) external view returns (LaunchConfig memory);
    function getLaunchedToken(address token) external view returns (LaunchedToken memory);
    function pendingCreatorFeeRecipient(address token)
        external view returns (address newRecipient, uint256 effectiveAt, uint256 expiresAt);
    function previewLaunchEconomics(uint256 launchConfigId, address pairToken) external view returns (bytes32);
    function memeHook() external view returns (address);
    function feeEscrow() external view returns (address);
    function buybackVault() external view returns (address);
    function launchDeployer() external view returns (address);
    function poolManager() external view returns (address);
    function owner() external view returns (address);

    function launchToken(
        TokenParams calldata params,
        uint256 launchConfigId,
        address pairToken,
        address[] calldata snipeTaxExemptions
    ) external payable returns (address token, address curve);
}

struct PonsFeePolicySnapshot {
    address protocolFeeRecipient;
    uint16 protocolFeeShareBps;
    uint16 buybackBurnBps;
    uint16 hookFeeBps;
    uint16 maxInternalPriceImpactBps;
}

/// PonsV2LaunchDeployer.LaunchDeployment, field for field (interface types are addresses on the wire).
struct PonsLaunchDeployment {
    address pairToken;
    address creatorFeeRecipient;
    address originalDeployer;
    address feePolicy;
    PonsFeePolicySnapshot policy;
    address feeEscrow;
    address buybackVault;
    uint256 phantomQuote;
    uint256 curveFeeBps;
    uint256 creatorTaxBps;
    bool buybackEnabled;
    uint256 graduationThreshold;
    uint256 supply;
    bytes32 salt;
    string name;
    string symbol;
    string logo;
    string description;
    IPonsV2Factory.Socials socials;
}

interface IPonsV2LaunchDeployer {
    function factory() external view returns (address);
    function predictLaunchAddresses(PonsLaunchDeployment calldata params) external view returns (address token, address curve);
}

interface IPonsV2Curve {
    function token() external view returns (address);
    function pairToken() external view returns (address);
    function deployer() external view returns (address); // the CURRENT creator fee recipient, despite its name
    function factory() external view returns (address);
    function feeBps() external view returns (uint256);
    function creatorTaxBps() external view returns (uint256);
    function phantomQuote() external view returns (uint256);
    function graduationThreshold() external view returns (uint256);
    function reservedTokens() external view returns (uint256);
    function buybackEnabled() external view returns (bool);
    function graduated() external view returns (bool);
    function readyToGraduate() external view returns (bool);
    function sellableTokens() external view returns (uint256);
    function getReserves() external view returns (uint256 quoteReserve_, uint256 tokenReserve_);
    function currentSnipeTaxBps(address recipient) external view returns (uint256);
    function snipeTaxExempt(address account) external view returns (bool);
    function launchedAt() external view returns (uint256);
    function quoteFeeBalance() external view returns (uint256);
    function creatorTaxBalance() external view returns (uint256);

    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256 tokensOut);
    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) external returns (uint256 quoteOut);
    function sweepFees(uint256 minBuybackTokensOut) external;
}

interface IPonsV2Escrow {
    function credit(address recipient) external payable;
    function claim(uint256 amount) external returns (uint256);
    function balanceOf(address recipient) external view returns (uint256);
}

interface IPonsV2MemeHook {
    function feeSweepOperator() external view returns (address);
    function currentFeePolicy() external view returns (PonsFeePolicySnapshot memory);
    function sweepPoolFees(bytes32 poolId, uint256 minConversionQuoteOut, uint256 minBuybackTokensOut) external;
}

interface IPonsV2Token {
    function deployer() external view returns (address);
    function launchFactory() external view returns (address);
    function curve() external view returns (address);
}
