// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {AzaadAwaazRegistry} from "../src/AzaadAwaazRegistry.sol";

contract AzaadAwaazRegistryTest is Test {
    event Published(
        bytes16 indexed storyId, uint32 version, bytes32 manifestSha256, string manifestCid, uint64 timestamp
    );
    event PublisherChanged(address indexed oldPublisher, address indexed newPublisher);

    AzaadAwaazRegistry internal registry;

    address internal owner = makeAddr("owner");
    address internal publisher = makeAddr("publisher");
    address internal stranger = makeAddr("stranger");

    bytes16 internal constant STORY = bytes16(0x0192f0c1a2b34c5d8e9f00112233aabb);
    bytes32 internal constant SHA = keccak256("manifest-v1");
    string internal constant CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

    function setUp() public {
        vm.warp(1_760_000_000);
        registry = new AzaadAwaazRegistry(owner, publisher);
    }

    function _publish(bytes16 storyId, uint32 version, bytes32 sha, string memory cid) internal {
        vm.prank(publisher);
        registry.publish(storyId, version, sha, cid);
    }

    function _cidOfLength(uint256 n) internal pure returns (string memory) {
        bytes memory b = new bytes(n);
        for (uint256 i = 0; i < n; i++) {
            b[i] = "a";
        }
        return string(b);
    }

    // ---------------------------------------------------------------- constructor

    function test_Constructor_SetsOwnerAndPublisher() public view {
        assertEq(registry.owner(), owner);
        assertEq(registry.publisher(), publisher);
        assertEq(registry.MAX_CID_LENGTH(), 128);
    }

    function test_Constructor_EmitsPublisherChanged() public {
        vm.expectEmit(true, true, false, false);
        emit PublisherChanged(address(0), publisher);
        new AzaadAwaazRegistry(owner, publisher);
    }

    function test_Constructor_RevertsOnZeroOwner() public {
        vm.expectRevert(AzaadAwaazRegistry.ZeroAddress.selector);
        new AzaadAwaazRegistry(address(0), publisher);
    }

    function test_Constructor_RevertsOnZeroPublisher() public {
        vm.expectRevert(AzaadAwaazRegistry.ZeroAddress.selector);
        new AzaadAwaazRegistry(owner, address(0));
    }

    function test_Constructor_OwnerMayAlsoBePublisher() public {
        AzaadAwaazRegistry r = new AzaadAwaazRegistry(owner, owner);
        vm.prank(owner);
        r.publish(STORY, 1, SHA, CID);
        assertEq(r.latestVersion(STORY), 1);
    }

    // ---------------------------------------------------------------- publish: happy path

    function test_Publish_StoresReceiptAndLatestVersion() public {
        _publish(STORY, 1, SHA, CID);
        (bytes32 sha, uint64 ts) = registry.receipt(STORY, 1);
        assertEq(sha, SHA);
        assertEq(ts, uint64(block.timestamp));
        assertEq(registry.latestVersion(STORY), 1);
    }

    function test_Publish_EmitsPublished() public {
        vm.expectEmit(true, false, false, true, address(registry));
        emit Published(STORY, 1, SHA, CID, uint64(block.timestamp));
        _publish(STORY, 1, SHA, CID);
    }

    function test_Publish_EventEncodingIsExact() public {
        vm.recordLogs();
        _publish(STORY, 7, SHA, CID);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].emitter, address(registry));
        assertEq(logs[0].topics.length, 2);
        assertEq(logs[0].topics[0], keccak256("Published(bytes16,uint32,bytes32,string,uint64)"));
        assertEq(logs[0].topics[1], bytes32(STORY));
        (uint32 v, bytes32 sha, string memory cid, uint64 ts) =
            abi.decode(logs[0].data, (uint32, bytes32, string, uint64));
        assertEq(v, 7);
        assertEq(sha, SHA);
        assertEq(cid, CID);
        assertEq(ts, uint64(block.timestamp));
    }

    function test_Publish_UnknownReceiptReadsAsZero() public view {
        (bytes32 sha, uint64 ts) = registry.receipt(STORY, 1);
        assertEq(sha, bytes32(0));
        assertEq(ts, 0);
        assertEq(registry.latestVersion(STORY), 0);
    }

    function test_Publish_MultipleVersionsKeepOldReceipts() public {
        _publish(STORY, 1, SHA, CID);
        vm.warp(block.timestamp + 1 days);
        bytes32 sha2 = keccak256("manifest-v2");
        _publish(STORY, 2, sha2, CID);

        (bytes32 s1, uint64 t1) = registry.receipt(STORY, 1);
        (bytes32 s2, uint64 t2) = registry.receipt(STORY, 2);
        assertEq(s1, SHA);
        assertEq(s2, sha2);
        assertEq(t2 - t1, 1 days);
        assertEq(registry.latestVersion(STORY), 2);
    }

    function test_Publish_VersionsMaySkip() public {
        _publish(STORY, 1, SHA, CID);
        _publish(STORY, 5, SHA, CID);
        assertEq(registry.latestVersion(STORY), 5);
        (bytes32 sha,) = registry.receipt(STORY, 3);
        assertEq(sha, bytes32(0));
    }

    function test_Publish_FirstVersionMayBeGreaterThanOne() public {
        _publish(STORY, 3, SHA, CID);
        assertEq(registry.latestVersion(STORY), 3);
    }

    function test_Publish_MaxVersion() public {
        _publish(STORY, type(uint32).max, SHA, CID);
        assertEq(registry.latestVersion(STORY), type(uint32).max);
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(AzaadAwaazRegistry.AlreadyPublished.selector, STORY, type(uint32).max));
        registry.publish(STORY, type(uint32).max, SHA, CID);
    }

    function test_Publish_StoriesAreIndependent() public {
        bytes16 other = bytes16(uint128(1));
        _publish(STORY, 4, SHA, CID);
        _publish(other, 1, SHA, CID);
        assertEq(registry.latestVersion(STORY), 4);
        assertEq(registry.latestVersion(other), 1);
    }

    function test_Publish_SameManifestHashAcrossStoriesAllowed() public {
        _publish(STORY, 1, SHA, CID);
        _publish(bytes16(uint128(2)), 1, SHA, CID);
        (bytes32 sha,) = registry.receipt(bytes16(uint128(2)), 1);
        assertEq(sha, SHA);
    }

    function test_Publish_CidAtMaxLength() public {
        string memory cid = _cidOfLength(128);
        vm.expectEmit(true, false, false, true, address(registry));
        emit Published(STORY, 1, SHA, cid, uint64(block.timestamp));
        _publish(STORY, 1, SHA, cid);
    }

    function test_Publish_CidOfOneByte() public {
        _publish(STORY, 1, SHA, "b");
        assertEq(registry.latestVersion(STORY), 1);
    }

    // ---------------------------------------------------------------- publish: rule violations

    function test_RevertWhen_StoryIdZero() public {
        vm.prank(publisher);
        vm.expectRevert(AzaadAwaazRegistry.InvalidStoryId.selector);
        registry.publish(bytes16(0), 1, SHA, CID);
    }

    function test_RevertWhen_VersionZero() public {
        vm.prank(publisher);
        vm.expectRevert(AzaadAwaazRegistry.InvalidVersion.selector);
        registry.publish(STORY, 0, SHA, CID);
    }

    function test_RevertWhen_PairAlreadyPublished() public {
        _publish(STORY, 1, SHA, CID);
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(AzaadAwaazRegistry.AlreadyPublished.selector, STORY, uint32(1)));
        registry.publish(STORY, 1, keccak256("different"), "bafyother");
    }

    function test_RevertWhen_PairAlreadyPublished_ReceiptUnchanged() public {
        _publish(STORY, 1, SHA, CID);
        uint64 firstTs = uint64(block.timestamp);
        vm.warp(block.timestamp + 100);
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(AzaadAwaazRegistry.AlreadyPublished.selector, STORY, uint32(1)));
        registry.publish(STORY, 1, keccak256("different"), CID);
        (bytes32 sha, uint64 ts) = registry.receipt(STORY, 1);
        assertEq(sha, SHA);
        assertEq(ts, firstTs);
    }

    function test_RevertWhen_VersionLowerThanLatest() public {
        _publish(STORY, 5, SHA, CID);
        vm.prank(publisher);
        vm.expectRevert(
            abi.encodeWithSelector(AzaadAwaazRegistry.VersionNotIncreasing.selector, STORY, uint32(5), uint32(3))
        );
        registry.publish(STORY, 3, SHA, CID);
    }

    function test_RevertWhen_ManifestHashZero() public {
        vm.prank(publisher);
        vm.expectRevert(AzaadAwaazRegistry.EmptyManifestHash.selector);
        registry.publish(STORY, 1, bytes32(0), CID);
    }

    function test_RevertWhen_CidEmpty() public {
        vm.prank(publisher);
        vm.expectRevert(AzaadAwaazRegistry.EmptyManifestCid.selector);
        registry.publish(STORY, 1, SHA, "");
    }

    function test_RevertWhen_CidTooLong() public {
        string memory cid = _cidOfLength(129);
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(AzaadAwaazRegistry.ManifestCidTooLong.selector, uint256(129)));
        registry.publish(STORY, 1, SHA, cid);
    }

    function test_FailedPublishLeavesNoState() public {
        vm.prank(publisher);
        vm.expectRevert(AzaadAwaazRegistry.EmptyManifestCid.selector);
        registry.publish(STORY, 1, SHA, "");
        assertEq(registry.latestVersion(STORY), 0);
        (bytes32 sha, uint64 ts) = registry.receipt(STORY, 1);
        assertEq(sha, bytes32(0));
        assertEq(ts, 0);
    }

    // ---------------------------------------------------------------- access control

    function test_RevertWhen_StrangerPublishes() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AzaadAwaazRegistry.NotPublisher.selector, stranger));
        registry.publish(STORY, 1, SHA, CID);
    }

    function test_RevertWhen_OwnerPublishes() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AzaadAwaazRegistry.NotPublisher.selector, owner));
        registry.publish(STORY, 1, SHA, CID);
    }

    function test_AccessCheckedBeforeValidation() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AzaadAwaazRegistry.NotPublisher.selector, stranger));
        registry.publish(bytes16(0), 0, bytes32(0), "");
    }

    function test_SetPublisher_ByOwner() public {
        address next = makeAddr("next");
        vm.expectEmit(true, true, false, false, address(registry));
        emit PublisherChanged(publisher, next);
        vm.prank(owner);
        registry.setPublisher(next);
        assertEq(registry.publisher(), next);
    }

    function test_SetPublisher_OldPublisherLosesAccess_NewGainsIt() public {
        address next = makeAddr("next");
        vm.prank(owner);
        registry.setPublisher(next);

        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(AzaadAwaazRegistry.NotPublisher.selector, publisher));
        registry.publish(STORY, 1, SHA, CID);

        vm.prank(next);
        registry.publish(STORY, 1, SHA, CID);
        assertEq(registry.latestVersion(STORY), 1);
    }

    function test_SetPublisher_HistoryPreservedAcrossRotation() public {
        _publish(STORY, 1, SHA, CID);
        address next = makeAddr("next");
        vm.prank(owner);
        registry.setPublisher(next);

        vm.prank(next);
        vm.expectRevert(abi.encodeWithSelector(AzaadAwaazRegistry.AlreadyPublished.selector, STORY, uint32(1)));
        registry.publish(STORY, 1, SHA, CID);
        assertEq(registry.latestVersion(STORY), 1);
    }

    function test_RevertWhen_StrangerSetsPublisher() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AzaadAwaazRegistry.NotOwner.selector, stranger));
        registry.setPublisher(stranger);
    }

    function test_RevertWhen_PublisherSetsPublisher() public {
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(AzaadAwaazRegistry.NotOwner.selector, publisher));
        registry.setPublisher(stranger);
    }

    function test_RevertWhen_SetPublisherZero() public {
        vm.prank(owner);
        vm.expectRevert(AzaadAwaazRegistry.ZeroAddress.selector);
        registry.setPublisher(address(0));
    }

    // ---------------------------------------------------------------- no funds

    function test_RevertWhen_EtherSent() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(registry).call{value: 1 wei}("");
        assertFalse(ok);
        assertEq(address(registry).balance, 0);
    }

    function test_RevertWhen_EtherSentWithPublish() public {
        vm.deal(publisher, 1 ether);
        vm.prank(publisher);
        (bool ok,) =
            address(registry).call{value: 1 wei}(abi.encodeCall(AzaadAwaazRegistry.publish, (STORY, 1, SHA, CID)));
        assertFalse(ok);
        assertEq(registry.latestVersion(STORY), 0);
    }

    function test_RevertWhen_UnknownSelector() public {
        (bool ok,) = address(registry).call(abi.encodeWithSignature("transferOwnership(address)", stranger));
        assertFalse(ok);
        assertEq(registry.owner(), owner);
    }

    // ---------------------------------------------------------------- fuzz

    function testFuzz_Publish_RoundTrip(bytes16 storyId, uint32 version, bytes32 sha, uint8 cidLen, uint64 when)
        public
    {
        vm.assume(storyId != bytes16(0) && version != 0 && sha != bytes32(0));
        uint256 len = bound(cidLen, 1, 128);
        when = uint64(bound(when, 1, type(uint64).max));
        vm.warp(when);
        string memory cid = _cidOfLength(len);

        vm.expectEmit(true, false, false, true, address(registry));
        emit Published(storyId, version, sha, cid, when);
        _publish(storyId, version, sha, cid);

        (bytes32 gotSha, uint64 gotTs) = registry.receipt(storyId, version);
        assertEq(gotSha, sha);
        assertEq(gotTs, when);
        assertEq(registry.latestVersion(storyId), version);
    }

    function testFuzz_SecondPublish_SucceedsIffStrictlyGreater(uint32 first, uint32 second) public {
        vm.assume(first != 0 && second != 0);
        _publish(STORY, first, SHA, CID);

        vm.prank(publisher);
        if (second == first) {
            vm.expectRevert(abi.encodeWithSelector(AzaadAwaazRegistry.AlreadyPublished.selector, STORY, first));
        } else if (second < first) {
            vm.expectRevert(
                abi.encodeWithSelector(AzaadAwaazRegistry.VersionNotIncreasing.selector, STORY, first, second)
            );
        }
        registry.publish(STORY, second, keccak256("second"), CID);

        assertEq(registry.latestVersion(STORY), second > first ? second : first);
    }

    /// Random sequences against a simple model: latest only ever grows, every accepted version is stored once.
    function testFuzz_VersionSequenceMatchesModel(uint32[16] memory versions) public {
        uint32 latest = 0;
        for (uint256 i = 0; i < versions.length; i++) {
            // Bias towards small numbers so collisions and decreases actually happen.
            uint32 v = uint32(bound(versions[i], 0, 40));
            bytes32 sha = keccak256(abi.encode(i, v));
            (, uint64 existingTs) = registry.receipt(STORY, v);
            vm.prank(publisher);
            if (v == 0) {
                vm.expectRevert(AzaadAwaazRegistry.InvalidVersion.selector);
                registry.publish(STORY, v, sha, CID);
            } else if (v <= latest) {
                if (existingTs != 0) {
                    vm.expectRevert(abi.encodeWithSelector(AzaadAwaazRegistry.AlreadyPublished.selector, STORY, v));
                } else {
                    vm.expectRevert(
                        abi.encodeWithSelector(AzaadAwaazRegistry.VersionNotIncreasing.selector, STORY, latest, v)
                    );
                }
                registry.publish(STORY, v, sha, CID);
            } else {
                registry.publish(STORY, v, sha, CID);
                latest = v;
                (bytes32 gotSha,) = registry.receipt(STORY, v);
                assertEq(gotSha, sha);
            }
            assertEq(registry.latestVersion(STORY), latest);
        }
    }

    function testFuzz_NonPublisherCannotPublish(address caller) public {
        vm.assume(caller != publisher);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(AzaadAwaazRegistry.NotPublisher.selector, caller));
        registry.publish(STORY, 1, SHA, CID);
    }

    function testFuzz_NonOwnerCannotSetPublisher(address caller, address next) public {
        vm.assume(caller != owner);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(AzaadAwaazRegistry.NotOwner.selector, caller));
        registry.setPublisher(next);
    }

    function testFuzz_CidTooLong(uint16 len) public {
        uint256 n = bound(len, 129, 2048);
        string memory cid = _cidOfLength(n);
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(AzaadAwaazRegistry.ManifestCidTooLong.selector, n));
        registry.publish(STORY, 1, SHA, cid);
    }

    // ---------------------------------------------------------------- gas

    function test_Gas_PublishFirstVersion() public {
        vm.prank(publisher);
        registry.publish(STORY, 1, SHA, CID);
        vm.snapshotGasLastCall("publish_first_version");
    }

    function test_Gas_PublishCorrection() public {
        _publish(STORY, 1, SHA, CID);
        vm.prank(publisher);
        registry.publish(STORY, 2, keccak256("v2"), CID);
        vm.snapshotGasLastCall("publish_correction");
    }

    function test_Gas_SetPublisher() public {
        vm.prank(owner);
        registry.setPublisher(stranger);
        vm.snapshotGasLastCall("set_publisher");
    }
}
