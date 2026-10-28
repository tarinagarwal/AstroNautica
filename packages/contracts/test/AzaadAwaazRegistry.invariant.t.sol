// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AzaadAwaazRegistry} from "../src/AzaadAwaazRegistry.sol";

/// Drives the registry with random publish attempts and keeps a ghost model of what must be stored.
contract RegistryHandler is Test {
    AzaadAwaazRegistry public registry;
    address public publisher;

    bytes16[3] public stories = [bytes16(uint128(1)), bytes16(uint128(2)), bytes16(uint128(3))];
    mapping(bytes16 => uint32) public ghostLatest;
    mapping(bytes16 => mapping(uint32 => bytes32)) public ghostSha;
    mapping(bytes16 => mapping(uint32 => uint64)) public ghostTs;
    mapping(bytes16 => uint32[]) internal _accepted;
    uint256 public acceptedCount;

    constructor(AzaadAwaazRegistry registry_, address publisher_) {
        registry = registry_;
        publisher = publisher_;
    }

    function accepted(bytes16 storyId) external view returns (uint32[] memory) {
        return _accepted[storyId];
    }

    function publish(uint8 storySeed, uint32 versionSeed, bytes32 sha, uint32 timeJump) external {
        bytes16 storyId = stories[storySeed % 3];
        uint32 version = uint32(bound(versionSeed, 0, 30));
        vm.warp(block.timestamp + bound(timeJump, 0, 7 days));
        vm.prank(publisher);
        try registry.publish(storyId, version, sha, "bafy") {
            ghostLatest[storyId] = version;
            ghostSha[storyId][version] = sha;
            ghostTs[storyId][version] = uint64(block.timestamp);
            _accepted[storyId].push(version);
            acceptedCount++;
        } catch {}
    }
}

contract AzaadAwaazRegistryInvariantTest is Test {
    AzaadAwaazRegistry internal registry;
    RegistryHandler internal handler;
    address internal owner = makeAddr("owner");
    address internal publisher = makeAddr("publisher");

    function setUp() public {
        registry = new AzaadAwaazRegistry(owner, publisher);
        handler = new RegistryHandler(registry, publisher);
        targetContract(address(handler));
    }

    function invariant_StateMatchesModel() public view {
        for (uint256 s = 0; s < 3; s++) {
            bytes16 storyId = handler.stories(s);
            assertEq(registry.latestVersion(storyId), handler.ghostLatest(storyId));
            uint32[] memory versions = handler.accepted(storyId);
            for (uint256 i = 0; i < versions.length; i++) {
                if (i > 0) assertGt(versions[i], versions[i - 1]);
                (bytes32 sha, uint64 ts) = registry.receipt(storyId, versions[i]);
                assertEq(sha, handler.ghostSha(storyId, versions[i]));
                assertEq(ts, handler.ghostTs(storyId, versions[i]));
                assertTrue(sha != bytes32(0));
            }
        }
    }

    function invariant_OwnerAndPublisherUnchanged() public view {
        assertEq(registry.owner(), owner);
        assertEq(registry.publisher(), publisher);
        assertEq(address(registry).balance, 0);
    }
}
