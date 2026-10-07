// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// The studio's splitter: the deal is the constructor (two wallets, a share at most half), every split pays the
// whole balance out at once in the two shares, plain ETH is wrapped first, totals add up, and nothing can be
// changed or taken by anyone.
import {Test} from "forge-std/Test.sol";
import {StudioSplitter} from "../src/StudioSplitter.sol";

contract MockWETH {
    string public constant name = "Wrapped Ether";
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function withdraw(uint256 wad) external { balanceOf[msg.sender] -= wad; (bool ok,) = msg.sender.call{value: wad}(""); require(ok); }
    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; return true; }
    function transfer(address to, uint256 amount) external returns (bool) { balanceOf[msg.sender] -= amount; balanceOf[to] += amount; return true; }
    /// a mint for the tests: the ledger paying the creator in WETH
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    receive() external payable {}
}

contract StudioSplitterTest is Test {
    MockWETH weth;
    StudioSplitter s;
    address studio = address(0x5700);
    address client = address(0xC11E);

    event Split(uint256 amount, uint256 toStudio, uint256 toClient);

    function setUp() public {
        weth = new MockWETH();
        s = new StudioSplitter(address(weth), studio, client, 1_000); // 10%
    }

    function test_constructorIsTheDeal() public {
        assertEq(address(s.WETH()), address(weth));
        assertEq(s.STUDIO(), studio);
        assertEq(s.CLIENT(), client);
        assertEq(s.STUDIO_BPS(), 1_000);
        vm.expectRevert(StudioSplitter.ZeroAddress.selector);
        new StudioSplitter(address(0), studio, client, 1_000);
        vm.expectRevert(StudioSplitter.ZeroAddress.selector);
        new StudioSplitter(address(weth), address(0), client, 1_000);
        vm.expectRevert(StudioSplitter.ZeroAddress.selector);
        new StudioSplitter(address(weth), studio, address(0), 1_000);
        vm.expectRevert(StudioSplitter.SameWallet.selector);
        new StudioSplitter(address(weth), studio, studio, 1_000);
        vm.expectRevert(abi.encodeWithSelector(StudioSplitter.BadShare.selector, 0));
        new StudioSplitter(address(weth), studio, client, 0);
        vm.expectRevert(abi.encodeWithSelector(StudioSplitter.BadShare.selector, 5_001));
        new StudioSplitter(address(weth), studio, client, 5_001);
        new StudioSplitter(address(weth), studio, client, 5_000); // half is the most
    }

    function test_splitPaysWethInTwoShares() public {
        weth.mint(address(s), 10 ether); // the ledger paid the creator
        assertEq(s.pending(), 10 ether);
        vm.expectEmit(true, true, true, true);
        emit Split(10 ether, 1 ether, 9 ether);
        vm.prank(address(0xBEEF)); // anyone
        s.split();
        assertEq(weth.balanceOf(studio), 1 ether);
        assertEq(weth.balanceOf(client), 9 ether);
        assertEq(weth.balanceOf(address(s)), 0);
        assertEq(s.totalToStudio(), 1 ether);
        assertEq(s.totalToClient(), 9 ether);
        assertEq(s.pending(), 0);
    }

    function test_plainEthIsWrappedAndSplitToo() public {
        vm.deal(address(this), 3 ether);
        (bool ok,) = address(s).call{value: 3 ether}("");
        assertTrue(ok);
        weth.mint(address(s), 1 ether);
        assertEq(s.pending(), 4 ether);
        s.split();
        assertEq(weth.balanceOf(studio), 0.4 ether);
        assertEq(weth.balanceOf(client), 3.6 ether);
        assertEq(address(s).balance, 0);
    }

    function test_nothingToSplitReverts() public {
        vm.expectRevert(StudioSplitter.Nothing.selector);
        s.split();
    }

    function test_roundingFavoursTheClientAndTotalsAddUp() public {
        weth.mint(address(s), 7); // 7 wei, 10% = 0 for the studio
        s.split();
        assertEq(weth.balanceOf(studio), 0);
        assertEq(weth.balanceOf(client), 7);
        weth.mint(address(s), 123_456_789);
        s.split();
        assertEq(s.totalToStudio() + s.totalToClient(), 7 + 123_456_789);
        assertEq(s.totalToStudio(), 12_345_678);
    }

    function testFuzz_everySplitIsExactAndComplete(uint96 amount, uint16 bps) public {
        bps = uint16(bound(bps, 1, 5_000));
        StudioSplitter x = new StudioSplitter(address(weth), studio, client, bps);
        vm.assume(amount > 0);
        weth.mint(address(x), amount);
        x.split();
        uint256 toStudio = uint256(amount) * bps / 10_000;
        assertEq(weth.balanceOf(studio), toStudio);
        assertEq(weth.balanceOf(client), uint256(amount) - toStudio);
        assertEq(weth.balanceOf(address(x)), 0);
    }
}
