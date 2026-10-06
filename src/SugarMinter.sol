// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/*//////////////////////////////////////////////////////////////////////////
                           SugarMinter, the par door
//////////////////////////////////////////////////////////////////////////*/
/*
  One USDG in, one SUGAR out, always. The USDG goes straight to the inference funding wallet, the wallet that buys the
  gateway's inference (OpenRouter balance). That transfer is what backs the SUGAR: a SUGAR is minted here only in the
  same call that moved its dollar to the wallet that will spend it on inference.

  Anyone may use it: a person who wants SUGAR at par, the harvester for the Brownies agent's row, an agent treasury in
  phase 2. mintAndActivate does the mint and the activation in one call, so a buyer who only wants inference never
  holds the token.

  No owner, no fee, no pause. The funding wallet is an immutable address and the one trusted step of the system: the
  owner converts what lands there into gateway balance. The site says so.
*/

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISugar} from "./interfaces/IBrownies.sol";

contract SugarMinter {
    using SafeERC20 for IERC20;

    IERC20 public immutable USDG;
    ISugar public immutable SUGAR;
    address public immutable FUNDING;

    uint256 public totalMinted;

    event Minted(address indexed payer, address indexed to, uint256 amount);
    event MintedAndActivated(address indexed payer, bytes32 indexed beneficiary, uint256 amount, uint256 activationId);

    error ZeroAddress();
    error ZeroAmount();
    error WrongDecimals();

    constructor(address usdg, address sugar, address funding) {
        if (usdg == address(0) || sugar == address(0) || funding == address(0)) revert ZeroAddress();
        if (IERC20Metadata(usdg).decimals() != 6) revert WrongDecimals();
        USDG = IERC20(usdg);
        SUGAR = ISugar(sugar);
        FUNDING = funding;
    }

    /// Pull `usdgAtoms` from the caller to the funding wallet, mint the same number of SUGAR atoms to `to`.
    function mint(address to, uint256 usdgAtoms) external returns (uint256 minted) {
        if (usdgAtoms == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        USDG.safeTransferFrom(msg.sender, FUNDING, usdgAtoms);
        SUGAR.mint(to, usdgAtoms);
        totalMinted += usdgAtoms;
        emit Minted(msg.sender, to, usdgAtoms);
        return usdgAtoms;
    }

    /// The same, then burn it at once for `beneficiary`. The buyer never holds the token.
    function mintAndActivate(uint256 usdgAtoms, bytes32 beneficiary) external returns (uint256 id) {
        if (usdgAtoms == 0) revert ZeroAmount();
        USDG.safeTransferFrom(msg.sender, FUNDING, usdgAtoms);
        SUGAR.mint(address(this), usdgAtoms);
        id = SUGAR.activate(usdgAtoms, beneficiary);
        totalMinted += usdgAtoms;
        emit MintedAndActivated(msg.sender, beneficiary, usdgAtoms, id);
    }
}
