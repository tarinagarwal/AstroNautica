// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {AzaadAwaazRegistry} from "../src/AzaadAwaazRegistry.sol";

/// @notice Deploys AzaadAwaazRegistry with OWNER and PUBLISHER taken from the environment.
/// @dev forge script script/Deploy.s.sol:Deploy --rpc-url <url> --broadcast [--private-key ... | --ledger | --account ...]
contract Deploy is Script {
    function run() external returns (AzaadAwaazRegistry registry) {
        address owner = vm.envAddress("OWNER");
        address publisher = vm.envAddress("PUBLISHER");
        require(owner != address(0) && publisher != address(0), "OWNER and PUBLISHER must be non-zero");

        vm.startBroadcast();
        registry = new AzaadAwaazRegistry(owner, publisher);
        vm.stopBroadcast();

        console2.log("AzaadAwaazRegistry deployed at", address(registry));
        console2.log("chainId", block.chainid);
        console2.log("owner", owner);
        console2.log("publisher", publisher);
    }
}
