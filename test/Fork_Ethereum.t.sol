// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/*
  The harvester against the real Ethereum mainnet: the real WETH, the real USDC, the real WETH/USDC 0.05% pool.
    forge test --fork-url https://ethereum-rpc.publicnode.com --match-path test/Fork_Ethereum.t.sol
  The fee inflow is stood in for by dealing WETH to the harvester: on Programmable the ledger's claimCreator() does
  exactly that, a plain WETH transfer to the creator.
*/
import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {BrownieCore} from "../src/BrownieCore.sol";
import {BrownieHarvester} from "../src/BrownieHarvester.sol";
import {IUniswapV3PoolMinimal, IWETH9} from "../src/interfaces/IBrownies.sol";

contract CoinMock is ERC20 {
    constructor() ERC20("Brownies", "BROWNIE") {}
}

contract ForkEthereumTest is Test {
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant POOL = 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640; // WETH/USDC 0.05%, USDC is token0

    address main = makeAddr("main");
    address funding = makeAddr("funding");
    address team = makeAddr("team");
    BrownieCore core;
    BrownieHarvester h;

    modifier onlyFork() {
        if (block.chainid != 1) return;
        _;
    }

    function setUp() public {
        if (block.chainid != 1) return;
        CoinMock coin = new CoinMock();
        core = new BrownieCore(
            BrownieCore.Config({
                token: address(coin),
                weth: WETH,
                usdc: USDC,
                wethUsdcPool: POOL,
                mainWallet: main,
                fundingWallet: funding,
                teamOwner: team,
                minPosition: 10_000e18
            })
        );
        h = core.HARVESTER();
    }

    function _fees(uint256 weth) internal {
        deal(WETH, address(h), IERC20Like(WETH).balanceOf(address(h)) + weth);
    }

    function test_fork_poolIsUsdcWeth() public onlyFork {
        assertEq(h.WETH_IS_0(), false, "on Ethereum USDC is token0");
        (,,, uint16 card,,,) = IUniswapV3PoolMinimal(POOL).slot0();
        assertGe(card, h.MIN_CARDINALITY());
    }

    function test_fork_claimSplitsSwapsAndFunds() public onlyFork {
        _fees(1 ether);
        (, uint256 expected) = h.previewSwap();
        assertEq(expected, 0, "nothing booked before the claim");
        h.claim();
        assertEq(main.balance, 0.35 ether, "35% to the main wallet, as ETH");
        assertEq(h.pendingRest(), 0, "the 65% was swapped");
        uint256 usdc = IERC20Like(USDC).balanceOf(funding);
        assertGt(usdc, 650e6, "0.65 ETH is worth more than 650 dollars");
        assertEq(h.totalStakersFunded() + h.totalTeamFunded(), usdc, "every dollar reached the funding wallet");
        assertEq(h.totalStakersFunded(), usdc * 35 / 65);
        assertEq(core.SUGAR().balanceOf(address(core.TEAM_VAULT())), h.totalTeamFunded(), "the brownies' 30% as SUGAR");
        assertEq(core.STAKING().totalFunded(), h.totalStakersFunded());
        assertEq(IERC20Like(WETH).balanceOf(address(h)), 0);
    }

    function test_fork_switchOffSendsEverythingToMain_andOnAgain() public onlyFork {
        vm.prank(team);
        h.setProgram(false);
        _fees(1 ether);
        h.claim();
        assertEq(main.balance, 1 ether, "off: all of it to the main wallet");
        assertEq(h.pendingRest(), 0);
        vm.prank(team);
        h.setProgram(true);
        _fees(1 ether);
        h.claim();
        assertEq(main.balance, 1.35 ether, "on again: 35%");
        vm.prank(main);
        vm.expectRevert(BrownieHarvester.NotOwner.selector);
        h.setProgram(false);
    }

    function test_fork_aBadPriceMakesTheSwapWait_notTheMainPayout() public onlyFork {
        _fees(1 ether);
        // the pool's average says ETH is worth 3% more than it is right now: the swap would land under the band
        (, int24 spot,,,,,) = IUniswapV3PoolMinimal(POOL).slot0();
        int56[] memory tc = new int56[](2);
        tc[0] = 0;
        tc[1] = int56(spot - 300) * 1800; // USDC is token0: a lower tick is a higher ETH price
        vm.mockCall(POOL, abi.encodeWithSelector(IUniswapV3PoolMinimal.observe.selector), abi.encode(tc, new uint160[](2)));
        h.claim();
        assertEq(main.balance, 0.35 ether, "the main wallet was paid all the same");
        assertEq(h.pendingRest(), 0.65 ether, "the 65% waits for a better price");
        assertEq(IERC20Like(USDC).balanceOf(funding), 0);
        vm.clearMockedCalls();
        h.claim();
        assertEq(h.pendingRest(), 0, "swapped on the next claim");
    }

    function test_fork_oneClaimSwapsAtMostTheCap() public onlyFork {
        _fees(50 ether);
        h.claim();
        assertEq(main.balance, 17.5 ether);
        assertEq(h.pendingRest(), 12.5 ether, "32.5 were due, 20 swapped, 12.5 wait");
        h.claim();
        assertEq(h.pendingRest(), 0);
    }

    function test_fork_claimNeedsGasWhenASwapIsDue() public onlyFork {
        _fees(1 ether);
        vm.expectRevert();
        h.claim{gas: 300_000}();
        _fees(0); // no change
        h.claim(); // plenty of gas: fine
        assertEq(h.pendingRest(), 0);
    }

    function test_fork_strangersCannotUseTheCallbackOrTheSwapLeg() public onlyFork {
        vm.expectRevert(BrownieHarvester.NotPool.selector);
        h.uniswapV3SwapCallback(1, 1, "");
        vm.expectRevert(BrownieHarvester.NotSelf.selector);
        h.swapLeg(1 ether);
    }

    function test_fork_plainEthIsWrappedAndCounted() public onlyFork {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(h).call{value: 1 ether}("");
        assertTrue(ok);
        h.claim();
        assertEq(main.balance, 0.35 ether);
        assertGt(IERC20Like(USDC).balanceOf(funding), 0);
    }
}

interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
}
