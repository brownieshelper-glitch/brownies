// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/*//////////////////////////////////////////////////////////////////////////
                         SUGAR, 1 SUGAR = 1 dollar of inference
//////////////////////////////////////////////////////////////////////////*/
/*
  The Brownies credit token. ERC-20 with 6 decimals, like USDG, so one atom of SUGAR is one atom of USDG.

  Who can mint, fixed for ever in the constructor:
    STAKING  BrownieStaking, which mints the SUGAR that stakers earned. Every atom it mints was funded first: the
             staking contract only books a reward budget when the same amount of USDG has just been pulled from the
             funder and sent to the inference funding wallet.
    MINTER   SugarMinter, the par door: one USDG in, one SUGAR out, the USDG to the inference funding wallet.
  So issuance can never outrun funding. There is no owner, no other minter, no pause, no upgrade, no fee.

  activate(amount, beneficiary) burns SUGAR and emits Activated. The gateway indexes the event and credits one dollar
  of inference per atom to the beneficiary, an opaque bytes32 that is bytes32(uint256(uint160(wallet))) for a wallet
  key, the same encoding Orbio uses, so tooling written for Orbio ports. Activation is final: an activated dollar pays
  for inference and nothing else, and it never comes back as a token.
*/

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

contract Sugar is ERC20, ERC20Permit {
    address public immutable STAKING;
    address public immutable MINTER;

    uint256 public lastActivationId;
    uint256 public totalActivated;

    event Activated(uint256 indexed id, address indexed from, bytes32 indexed beneficiary, uint256 amount);

    error NotMinter();
    error ZeroAmount();
    error ZeroBeneficiary();
    error ZeroAddress();

    constructor(address staking, address minter) ERC20("Brownie Sugar", "SUGAR") ERC20Permit("Brownie Sugar") {
        if (staking == address(0) || minter == address(0) || staking == minter) revert ZeroAddress();
        STAKING = staking;
        MINTER = minter;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// Only the two minters fixed at deploy. Both mint exactly as many atoms as the USDG that reached the funding wallet.
    function mint(address to, uint256 amount) external {
        if (msg.sender != STAKING && msg.sender != MINTER) revert NotMinter();
        _mint(to, amount);
    }

    /// Burn `amount` for the caller's own wallet key.
    function activate(uint256 amount) external returns (uint256 id) {
        return _activate(amount, bytes32(uint256(uint160(msg.sender))));
    }

    /// Burn `amount` for any beneficiary: another wallet, an agent's key, a brownie's key.
    function activate(uint256 amount, bytes32 beneficiary) external returns (uint256 id) {
        return _activate(amount, beneficiary);
    }

    function _activate(uint256 amount, bytes32 beneficiary) internal returns (uint256 id) {
        if (amount == 0) revert ZeroAmount();
        if (beneficiary == bytes32(0)) revert ZeroBeneficiary();
        _burn(msg.sender, amount);
        id = ++lastActivationId;
        totalActivated += amount;
        emit Activated(id, msg.sender, beneficiary, amount);
    }
}
