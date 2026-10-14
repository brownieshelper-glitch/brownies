// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "solmate/src/tokens/ERC20.sol";

/*
  BROWNIE, the coin. A plain token: one billion, minted once to the launcher, which puts all of it into the pool.
  No owner, no mint, no pause, no fee inside the token, no way to change its name. Everything that can change
  lives in the hook's module, never here.

  metadata() is what Programmable's site reads (description, website, image, extra data); it is fixed at birth.
*/
contract BrownieToken is ERC20 {
    uint256 public constant SUPPLY = 1_000_000_000 ether;

    string private _description;
    string private _website;
    string private _image;
    bytes private _extraData;

    constructor(string memory name_, string memory symbol_, address to, string memory description_, string memory website_, string memory image_, bytes memory extraData_)
        ERC20(name_, symbol_, 18)
    {
        _description = description_;
        _website = website_;
        _image = image_;
        _extraData = extraData_;
        _mint(to, SUPPLY);
    }

    function metadata() external view returns (string memory description, string memory website, string memory image, bytes memory extraData) {
        return (_description, _website, _image, _extraData);
    }
}
