// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/*//////////////////////////////////////////////////////////////////////////
          BrownieHarvester, BROWNIE's creator and fee receiver on Ethereum
//////////////////////////////////////////////////////////////////////////*/
/*
  BROWNIE is launched on Programmable (Foundation mode, Ethereum) with THIS contract as the coin's creator. The
  creator's fee on every buy and sell accrues in WETH in the launch's ledger; anyone may call the ledger's
  claimCreator(), which pays the creator, this contract. Anyone may then call claim() here; our keeper does both
  whenever at least a few hundredths of an ETH have gathered. Each claim:

    1. wraps any plain ETH that arrived into WETH, and counts what is new;
    2. while the program is ON, books 40% of the new WETH for the Brownies main wallet and 60% for the swap;
       while it is OFF, books all of it for the main wallet;
    3. when at least MIN_SWAP is waiting, swaps up to MAX_SWAP of it for USDC on the Uniswap v3 WETH/USDC pool,
       refusing any swap whose output is more than BAND_BPS under the pool's own 30-minute average price. The swap
       runs in its own call: if it fails, the WETH simply waits for the next claim and nothing else is blocked;
    4. of that USDC, 5/6 (50% of the whole) funds the stakers' stream in BrownieStaking, and 1/6 (10% of the whole)
       is minted as SUGAR at par into the TeamVault, the budget of the brownies;
    5. unwraps what the main wallet is owed and sends it as ETH.

  Both USDC legs end in the inference funding wallet: BrownieStaking.fund and SugarMinter.mint each pull the USDC
  from here and forward it there before they book a single atom.

  THE SWITCH. The owner (the Brownies team) can switch the program off and on at any time, with an event on chain.
  Off means every fee claimed from then on goes to the main wallet; what was already booked for stakers is still
  swapped and paid. SUGAR already minted is unaffected: its dollars are already in the funding wallet. Stakers
  should know this: the split is fixed, but the team can stop the program whenever it wants.

  No upgrade, no rescue, no way to move the creator role: Programmable fixes the creator forever at launch, and
  nobody, not even Programmable, can redirect the fees. The rows are constants.
*/

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {IBrownieStaking, ISugarMinter, IWETH9, IUniswapV3PoolMinimal} from "./interfaces/IBrownies.sol";

contract BrownieHarvester {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                 CONSTANTS
    //////////////////////////////////////////////////////////////*/

    uint256 public constant BPS = 10_000;
    uint256 public constant MAIN_BPS = 4_000; // 40% of every claim, the protocol's cut
    uint256 public constant STAKERS_BPS = 5_000; // 50%, streamed to BROWNIE stakers as SUGAR
    uint256 public constant TEAM_BPS = 1_000; // 10%, SUGAR minted into the TeamVault for the brownies
    uint256 public constant MIN_SWAP = 0.03 ether; // below this the WETH waits, so dust is never sandwiched
    uint256 public constant MAX_SWAP = 20 ether; // one claim swaps at most this; the rest waits for the next one
    uint256 public constant BAND_BPS = 100; // the swap must land within 1% of the pool's 30-minute average
    uint32 public constant TWAP_WINDOW = 1800;
    uint16 public constant MIN_CARDINALITY = 100; // the pool must keep enough price history for that average
    /// A swap that runs out of gas is caught and simply waits, so a wallet's gas estimator could settle on a gas
    /// amount at which the claim "succeeds" and swaps nothing. When a swap is due, this floor makes it supply enough.
    uint256 public constant MIN_SWAP_GAS = 700_000;

    /*//////////////////////////////////////////////////////////////
                                 IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    address public immutable TOKEN; // BROWNIE, computed before the launch from this contract's address
    IWETH9 public immutable WETH;
    IERC20 public immutable USDC;
    IUniswapV3PoolMinimal public immutable POOL; // the WETH/USDC v3 pool
    bool public immutable WETH_IS_0;
    IBrownieStaking public immutable STAKING;
    ISugarMinter public immutable MINTER;
    address public immutable MAIN_WALLET;
    address public immutable TEAM_VAULT; // receives the brownies' 10% as SUGAR

    /*//////////////////////////////////////////////////////////////
                                   STATE
    //////////////////////////////////////////////////////////////*/

    address public owner;
    address public pendingOwner;
    bool public programOn = true;

    uint256 public mainOwed; // WETH booked for the main wallet and not paid yet
    uint256 public pendingRest; // WETH booked for the swap and not swapped yet
    uint256 public totalMainPaid;
    uint256 public totalStakersFunded; // USDC atoms
    uint256 public totalTeamFunded; // USDC atoms, minted 1:1 as SUGAR into the TeamVault

    // the swap in flight, for the v3 callback
    address private _expectedPool;
    uint256 private _owed;

    uint256 private _lock = 1;

    event Claimed(uint256 newWeth, uint256 toMain, uint256 toRest);
    event Swapped(uint256 wethIn, uint256 usdcOut, uint256 toStakers, uint256 toTeam);
    event SwapWaited(uint256 wethWaiting, bytes reason);
    event MainPaid(uint256 amount);
    event ProgramSet(bool on);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    error ZeroAddress();
    error BadPool();
    error ThinOracle(uint16 cardinality);
    error Reentered();
    error NotSelf();
    error NotPool();
    error Overpay();
    error OutsideBand(uint256 out, uint256 expected);
    error NothingOwed();
    error NeedMoreGas(uint256 have, uint256 need);
    error NotOwner();
    error NotPendingOwner();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentered();
        _lock = 2;
        _;
        _lock = 1;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        address token,
        address weth,
        address usdc,
        address pool,
        address staking,
        address minter,
        address mainWallet,
        address teamVault,
        address owner_
    ) {
        if (
            token == address(0) || weth == address(0) || usdc == address(0) || pool == address(0) || staking == address(0)
                || minter == address(0) || mainWallet == address(0) || teamVault == address(0) || owner_ == address(0)
        ) revert ZeroAddress();
        TOKEN = token;
        WETH = IWETH9(weth);
        USDC = IERC20(usdc);
        POOL = IUniswapV3PoolMinimal(pool);
        address t0 = POOL.token0();
        address t1 = POOL.token1();
        if (t0 == weth && t1 == usdc) WETH_IS_0 = true;
        else if (t0 == usdc && t1 == weth) WETH_IS_0 = false;
        else revert BadPool();
        (,,, uint16 cardinality,,,) = POOL.slot0();
        if (cardinality < MIN_CARDINALITY) revert ThinOracle(cardinality);
        STAKING = IBrownieStaking(staking);
        MINTER = ISugarMinter(minter);
        MAIN_WALLET = mainWallet;
        TEAM_VAULT = teamVault;
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    /*//////////////////////////////////////////////////////////////
                                  THE CLAIM
    //////////////////////////////////////////////////////////////*/

    /// Count what arrived, book the rows, swap when enough is waiting, pay the main wallet. Anyone may call it.
    function claim() external nonReentrant {
        uint256 loose = address(this).balance;
        if (loose != 0) WETH.deposit{value: loose}();
        uint256 bal = WETH.balanceOf(address(this));
        uint256 known = mainOwed + pendingRest;
        uint256 fresh = bal > known ? bal - known : 0;
        if (fresh != 0) {
            uint256 toMain = programOn ? fresh * MAIN_BPS / BPS : fresh;
            mainOwed += toMain;
            pendingRest += fresh - toMain;
            emit Claimed(fresh, toMain, fresh - toMain);
        }
        if (pendingRest >= MIN_SWAP) {
            if (gasleft() < MIN_SWAP_GAS) revert NeedMoreGas(gasleft(), MIN_SWAP_GAS);
            uint256 amount = pendingRest > MAX_SWAP ? MAX_SWAP : pendingRest;
            // the swap in its own call: a bad price, a paused pool or a frozen token makes it wait, not fail
            try this.swapLeg(amount) {}
            catch (bytes memory reason) {
                emit SwapWaited(pendingRest, reason);
            }
        }
        if (mainOwed != 0) _payMain();
    }

    /// Send the main wallet what it is owed, as ETH. Anyone may call it; it only ever pays MAIN_WALLET.
    function payMain() external nonReentrant {
        if (mainOwed == 0) revert NothingOwed();
        _payMain();
    }

    function _payMain() internal {
        uint256 amount = mainOwed;
        mainOwed = 0;
        WETH.withdraw(amount);
        (bool ok,) = MAIN_WALLET.call{value: amount, gas: 40_000}("");
        if (!ok) {
            WETH.deposit{value: amount}();
            mainOwed = amount; // a wallet that cannot take ETH right now blocks nothing else; it is paid next time
            return;
        }
        totalMainPaid += amount;
        emit MainPaid(amount);
    }

    /*//////////////////////////////////////////////////////////////
                           THE SWAP AND THE TWO LEGS
    //////////////////////////////////////////////////////////////*/

    /// Swap `wethIn` for USDC and hand it to the two legs. Only this contract calls it (from claim, in a try).
    function swapLeg(uint256 wethIn) external {
        if (msg.sender != address(this)) revert NotSelf();
        pendingRest -= wethIn;
        uint256 expected = _expectedOut(wethIn);
        uint256 before = USDC.balanceOf(address(this));
        _expectedPool = address(POOL);
        _owed = wethIn;
        POOL.swap(
            address(this),
            WETH_IS_0,
            int256(wethIn),
            WETH_IS_0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1,
            ""
        );
        _expectedPool = address(0);
        _owed = 0;
        uint256 out = USDC.balanceOf(address(this)) - before; // measured, never the pool's word
        if (out < expected * (BPS - BAND_BPS) / BPS) revert OutsideBand(out, expected);

        uint256 toStakers = out * STAKERS_BPS / (STAKERS_BPS + TEAM_BPS);
        uint256 toTeam = out - toStakers;
        USDC.forceApprove(address(STAKING), toStakers);
        STAKING.fund(toStakers);
        USDC.forceApprove(address(MINTER), toTeam);
        MINTER.mint(TEAM_VAULT, toTeam);
        totalStakersFunded += toStakers;
        totalTeamFunded += toTeam;
        emit Swapped(wethIn, out, toStakers, toTeam);
    }

    /// The pool pays first and calls back for its input. Only our pool, only the input token, never more than owed.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        if (msg.sender == address(0) || msg.sender != _expectedPool) revert NotPool();
        int256 inDelta = WETH_IS_0 ? amount0Delta : amount1Delta;
        int256 otherDelta = WETH_IS_0 ? amount1Delta : amount0Delta;
        if (otherDelta > 0) revert Overpay();
        uint256 pay = inDelta > 0 ? uint256(inDelta) : 0;
        if (pay > _owed) revert Overpay();
        _owed -= pay;
        if (pay != 0 && !WETH.transfer(msg.sender, pay)) revert Overpay();
    }

    /// USDC the pool's 30-minute average price says `wethIn` is worth.
    function _expectedOut(uint256 wethIn) internal view returns (uint256) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = TWAP_WINDOW;
        ago[1] = 0;
        (int56[] memory tc,) = POOL.observe(ago);
        int56 delta = tc[1] - tc[0];
        int24 tick = int24(delta / int56(uint56(TWAP_WINDOW)));
        if (delta < 0 && delta % int56(uint56(TWAP_WINDOW)) != 0) tick--;
        uint160 sqrtP = TickMath.getSqrtPriceAtTick(tick);
        uint256 priceX192 = uint256(sqrtP) * uint256(sqrtP); // token1 per token0, Q192
        if (WETH_IS_0) return FullMath.mulDiv(wethIn, priceX192, 1 << 192);
        return FullMath.mulDiv(wethIn, 1 << 192, priceX192);
    }

    /// What the pool's average price says the waiting WETH is worth in USDC, for the site.
    function previewSwap() external view returns (uint256 wethWaiting, uint256 usdcExpected) {
        wethWaiting = pendingRest;
        if (wethWaiting != 0) usdcExpected = _expectedOut(wethWaiting);
    }

    /*//////////////////////////////////////////////////////////////
                                  THE OWNER
    //////////////////////////////////////////////////////////////*/

    /// Switch the program off (every new fee to the main wallet) or on again.
    function setProgram(bool on) external onlyOwner {
        programOn = on;
        emit ProgramSet(on);
    }

    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
        emit OwnershipTransferStarted(owner, to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    /// ETH may arrive from WETH.withdraw, from a launch refund, or as a gift to the fee rows.
    receive() external payable {}
}
