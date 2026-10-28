// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AzaadAwaazRegistry} from "../src/AzaadAwaazRegistry.sol";

/// Drives the registry with random publish attempts from several keys and random publisher rotations, and keeps a
/// ghost model of what must be stored per (storyId, version, publisher).
contract RegistryHandler is Test {
    AzaadAwaazRegistry public registry;
    address public owner;

    bytes16[3] public stories = [bytes16(uint128(1)), bytes16(uint128(2)), bytes16(uint128(3))];
    address[3] public keys;
    /// Small version domain (0..8, plus 2^32-1) so collisions and the max version are exercised.
    uint32[10] public versionDomain = [uint32(0), 1, 2, 3, 4, 5, 6, 7, 8, type(uint32).max];

    address public ghostPublisher;
    mapping(bytes16 => mapping(uint32 => mapping(address => bytes32))) public ghostSha;
    mapping(bytes16 => mapping(uint32 => mapping(address => uint64))) public ghostTs;
    uint256 public acceptedCount;
    uint256 public rotations;
    /// Incremented whenever the contract's accept/reject decision disagrees with the model. Must stay 0.
    uint256 public mismatches;

    constructor(AzaadAwaazRegistry registry_, address owner_, address[3] memory keys_) {
        registry = registry_;
        owner = owner_;
        keys = keys_;
        ghostPublisher = keys_[0];
    }

    function publish(uint8 keySeed, uint8 storySeed, uint8 versionSeed, bytes32 sha, uint32 timeJump) external {
        address caller = keys[keySeed % 3];
        bytes16 storyId = stories[storySeed % 3];
        uint32 version = versionDomain[versionSeed % 10];
        vm.warp(block.timestamp + bound(timeJump, 0, 7 days));

        bool expectOk = caller == ghostPublisher && version != 0 && sha != bytes32(0)
            && ghostSha[storyId][version][caller] == bytes32(0);

        vm.prank(caller);
        try registry.publish(storyId, version, sha, "bafy") {
            if (!expectOk) mismatches++;
            ghostSha[storyId][version][caller] = sha;
            ghostTs[storyId][version][caller] = uint64(block.timestamp);
            acceptedCount++;
        } catch {
            if (expectOk) mismatches++;
        }
    }

    function rotate(uint8 keySeed) external {
        address next = keys[keySeed % 3];
        vm.prank(owner);
        registry.setPublisher(next);
        ghostPublisher = next;
        rotations++;
    }
}

contract AzaadAwaazRegistryInvariantTest is Test {
    AzaadAwaazRegistry internal registry;
    RegistryHandler internal handler;
    address internal owner = makeAddr("owner");
    address[3] internal keys = [makeAddr("keyA"), makeAddr("keyB"), makeAddr("keyC")];

    function setUp() public {
        registry = new AzaadAwaazRegistry(owner, keys[0]);
        handler = new RegistryHandler(registry, owner, keys);
        targetContract(address(handler));
    }

    /// Every (story, version, key) in the domain reads exactly what the model says, and the number of stored
    /// receipts equals the number of accepted publishes (nothing overwritten, nothing deleted).
    function invariant_StateMatchesModel() public view {
        uint256 stored = 0;
        for (uint256 s = 0; s < 3; s++) {
            bytes16 storyId = handler.stories(s);
            for (uint256 v = 0; v < 10; v++) {
                uint32 version = handler.versionDomain(v);
                for (uint256 k = 0; k < 3; k++) {
                    address by = keys[k];
                    (bytes32 sha, uint64 ts) = registry.receipt(storyId, version, by);
                    assertEq(sha, handler.ghostSha(storyId, version, by));
                    assertEq(ts, handler.ghostTs(storyId, version, by));
                    if (version == 0) assertEq(sha, bytes32(0));
                    if (sha != bytes32(0)) {
                        assertGt(ts, 0);
                        stored++;
                    }
                }
            }
        }
        assertEq(stored, handler.acceptedCount());
    }

    function invariant_DecisionsMatchModel() public view {
        assertEq(handler.mismatches(), 0);
    }

    function invariant_OwnerFixed_PublisherTracked_NoFunds() public view {
        assertEq(registry.owner(), owner);
        assertEq(registry.publisher(), handler.ghostPublisher());
        assertEq(address(registry).balance, 0);
    }
}
