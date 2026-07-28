// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {
    ArcOpenRailsFactoryV1
} from "./ArcOpenRailsFactoryV1.sol";

/**
 * @title OpenRails Factory V1
 * @notice Chain-neutral factory entry point for OpenRails vault clones.
 */
contract OpenRailsFactoryV1 is ArcOpenRailsFactoryV1 {
    constructor(address masterLogicHub)
        ArcOpenRailsFactoryV1(masterLogicHub)
    {}
}
