// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/*
  The small interfaces the Brownies contracts use to talk to each other and to Uniswap v3 / WETH9.
  Everything here is the minimum the code needs; nothing is an admin surface.
*/

interface ISugar {
    function mint(address to, uint256 amount) external;
    function activate(uint256 amount, bytes32 beneficiary) external returns (uint256 id);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface ISugarMinter {
    function mint(address to, uint256 usdgAtoms) external returns (uint256 minted);
    function mintAndActivate(uint256 usdgAtoms, bytes32 beneficiary) external returns (uint256 id);
}

interface IBrownieStaking {
    function fund(uint256 usdgAtoms) external;
}

/// WETH9: the wrapped ether a Uniswap v3 pool settles ETH through.
interface IWETH9 {
    function deposit() external payable;
    function withdraw(uint256 wad) external;
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// The parts of a Uniswap v3 pool the harvester uses: identity, the oracle and the swap.
interface IUniswapV3PoolMinimal {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}
