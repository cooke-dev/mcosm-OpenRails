// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {
    ArcOpenRailsHubV2Initializable
} from "./ArcOpenRailsHubV2Initializable.sol";

/**
 * @title OpenRails Hub V2
 * @notice Chain-neutral entry point for OpenRails settlement vaults.
 *
 * The Arc-prefixed implementation remains available for backward
 * compatibility. New deployments should use this contract name.
 */
contract OpenRailsHubV2Initializable
    is ArcOpenRailsHubV2Initializable
{}
