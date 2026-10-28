// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {AzaadAwaazRegistry} from "../src/AzaadAwaazRegistry.sol";

contract AzaadAwaazRegistryTest is Test {
    event Published(
        bytes16 indexed storyId,
        uint32 indexed version,
        address indexed publisher,
        bytes32 manifestSha256,
        string manifestCid,
        uint64 timestamp
    );
    event PublisherChanged(address indexed oldPublisher, address indexed newPublisher);

    AzaadAwaazRegistry internal registry;

    address internal owner = makeAddr("owner");
    address internal publisher = makeAddr("publisher");
    address internal stranger = makeAddr("stranger");
    address internal next = makeAddr("next");

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

    function _rotate(address to) internal {
        vm.prank(owner);
        registry.setPublisher(to);
    }

    function _cidOfLength(uint256 n) internal pure returns (string memory) {
        bytes memory b = new bytes(n);
        for (uint256 i = 0; i < n; i++) {
            b[i] = "a";
        }
        return string(b);
    }

    function _assertReceipt(bytes16 storyId, uint32 version, address by, bytes32 sha, uint64 ts) internal view {
        (bytes32 gotSha, uint64 gotTs) = registry.receipt(storyId, version, by);
        assertEq(gotSha, sha);
        assertEq(gotTs, ts);
    }

    function _assertNoReceipt(bytes16 storyId, uint32 version, address by) internal view {
        _assertReceipt(storyId, version, by, bytes32(0), 0);
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
        (bytes32 sha,) = r.receipt(STORY, 1, owner);
        assertEq(sha, SHA);
    }

    // ---------------------------------------------------------------- publish: happy path

    function test_Publish_StoresReceiptUnderPublisher() public {
        _publish(STORY, 1, SHA, CID);
        _assertReceipt(STORY, 1, publisher, SHA, uint64(block.timestamp));
        _assertNoReceipt(STORY, 1, stranger);
        _assertNoReceipt(STORY, 1, owner);
    }

    function test_Publish_EmitsPublished() public {
        vm.expectEmit(true, true, true, true, address(registry));
        emit Published(STORY, 1, publisher, SHA, CID, uint64(block.timestamp));
        _publish(STORY, 1, SHA, CID);
    }

    function test_Publish_EventEncodingIsExact() public {
        vm.recordLogs();
        _publish(STORY, 7, SHA, CID);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].emitter, address(registry));
        assertEq(logs[0].topics.length, 4);
        assertEq(logs[0].topics[0], keccak256("Published(bytes16,uint32,address,bytes32,string,uint64)"));
        assertEq(logs[0].topics[1], bytes32(STORY));
        assertEq(logs[0].topics[2], bytes32(uint256(7)));
        assertEq(logs[0].topics[3], bytes32(uint256(uint160(publisher))));
        (bytes32 sha, string memory cid, uint64 ts) = abi.decode(logs[0].data, (bytes32, string, uint64));
        assertEq(sha, SHA);
        assertEq(cid, CID);
        assertEq(ts, uint64(block.timestamp));
    }

    function test_Publish_UnknownReceiptReadsAsZero() public view {
        _assertNoReceipt(STORY, 1, publisher);
        _assertNoReceipt(STORY, 1, address(0));
    }

    function test_Publish_MultipleVersionsKeepOldReceipts() public {
        _publish(STORY, 1, SHA, CID);
        uint64 t1 = uint64(block.timestamp);
        vm.warp(block.timestamp + 1 days);
        bytes32 sha2 = keccak256("manifest-v2");
        _publish(STORY, 2, sha2, CID);

        _assertReceipt(STORY, 1, publisher, SHA, t1);
        _assertReceipt(STORY, 2, publisher, sha2, t1 + 1 days);
    }

    function test_Publish_VersionsMaySkip() public {
        _publish(STORY, 1, SHA, CID);
        _publish(STORY, 5, SHA, CID);
        _assertNoReceipt(STORY, 3, publisher);
    }

    function test_Publish_VersionsMayGoBackwards() public {
        _publish(STORY, 5, SHA, CID);
        bytes32 sha3 = keccak256("manifest-v3");
        _publish(STORY, 3, sha3, CID);
        _assertReceipt(STORY, 3, publisher, sha3, uint64(block.timestamp));
        _assertReceipt(STORY, 5, publisher, SHA, uint64(block.timestamp));
    }

    function test_Publish_FirstVersionMayBeGreaterThanOne() public {
        _publish(STORY, 3, SHA, CID);
        _assertReceipt(STORY, 3, publisher, SHA, uint64(block.timestamp));
    }

    function test_Publish_MaxVersion_DoesNotBlockOtherVersions() public {
        _publish(STORY, type(uint32).max, SHA, CID);
        bytes32 sha2 = keccak256("manifest-v2");
        _publish(STORY, 2, sha2, CID);
        _publish(STORY, 1, SHA, CID);
        _publish(STORY, type(uint32).max - 1, SHA, CID);
        _assertReceipt(STORY, type(uint32).max, publisher, SHA, uint64(block.timestamp));
        _assertReceipt(STORY, 2, publisher, sha2, uint64(block.timestamp));

        // The max version itself is still write-once for this publisher.
        vm.prank(publisher);
        vm.expectRevert(
            abi.encodeWithSelector(AzaadAwaazRegistry.AlreadyPublished.selector, STORY, type(uint32).max, publisher)
        );
        registry.publish(STORY, type(uint32).max, SHA, CID);
    }

    function test_Publish_StoriesAreIndependent() public {
        bytes16 other = bytes16(uint128(1));
        _publish(STORY, 4, SHA, CID);
        _publish(other, 4, keccak256("other"), CID);
        _assertReceipt(STORY, 4, publisher, SHA, uint64(block.timestamp));
        _assertReceipt(other, 4, publisher, keccak256("other"), uint64(block.timestamp));
    }

    function test_Publish_SameManifestHashAcrossStoriesAllowed() public {
        _publish(STORY, 1, SHA, CID);
        _publish(bytes16(uint128(2)), 1, SHA, CID);
        (bytes32 sha,) = registry.receipt(bytes16(uint128(2)), 1, publisher);
        assertEq(sha, SHA);
    }

    function test_Publish_CidAtMaxLength() public {
        string memory cid = _cidOfLength(128);
        vm.expectEmit(true, true, true, true, address(registry));
        emit Published(STORY, 1, publisher, SHA, cid, uint64(block.timestamp));
        _publish(STORY, 1, SHA, cid);
    }

    function test_Publish_CidOfOneByte() public {
        _publish(STORY, 1, SHA, "b");
        _assertReceipt(STORY, 1, publisher, SHA, uint64(block.timestamp));
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

    function test_RevertWhen_TripleAlreadyPublished() public {
        _publish(STORY, 1, SHA, CID);
        vm.prank(publisher);
        vm.expectRevert(
            abi.encodeWithSelector(AzaadAwaazRegistry.AlreadyPublished.selector, STORY, uint32(1), publisher)
        );
        registry.publish(STORY, 1, keccak256("different"), "bafyother");
    }

    function test_RevertWhen_TripleAlreadyPublished_ReceiptUnchanged() public {
        _publish(STORY, 1, SHA, CID);
        uint64 firstTs = uint64(block.timestamp);
        vm.warp(block.timestamp + 100);
        vm.prank(publisher);
        vm.expectRevert(
            abi.encodeWithSelector(AzaadAwaazRegistry.AlreadyPublished.selector, STORY, uint32(1), publisher)
        );
        registry.publish(STORY, 1, keccak256("different"), CID);
        _assertReceipt(STORY, 1, publisher, SHA, firstTs);
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
        _assertNoReceipt(STORY, 1, publisher);
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
        vm.expectEmit(true, true, false, false, address(registry));
        emit PublisherChanged(publisher, next);
        _rotate(next);
        assertEq(registry.publisher(), next);
    }

    function test_SetPublisher_OldPublisherLosesAccess_NewGainsIt() public {
        _rotate(next);

        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(AzaadAwaazRegistry.NotPublisher.selector, publisher));
        registry.publish(STORY, 1, SHA, CID);

        vm.prank(next);
        registry.publish(STORY, 1, SHA, CID);
        _assertReceipt(STORY, 1, next, SHA, uint64(block.timestamp));
        _assertNoReceipt(STORY, 1, publisher);
    }

    /// The core recovery path: a compromised key squats (STORY, 2) with a wrong hash; after rotation the real
    /// publisher still writes its own receipt for the same pair, and both stay readable by address.
    function test_Rotation_OldPublisherSquatsVersion_NewPublisherCanStillWrite() public {
        bytes32 wrong = keccak256("attacker manifest");
        uint64 tSquat = uint64(block.timestamp);
        _publish(STORY, 2, wrong, "bafyattacker");

        vm.warp(block.timestamp + 1 hours);
        _rotate(next);

        bytes32 right = keccak256("real manifest v2");
        uint64 tReal = uint64(block.timestamp);
        vm.expectEmit(true, true, true, true, address(registry));
        emit Published(STORY, 2, next, right, CID, tReal);
        vm.prank(next);
        registry.publish(STORY, 2, right, CID);

        _assertReceipt(STORY, 2, publisher, wrong, tSquat);
        _assertReceipt(STORY, 2, next, right, tReal);
    }

    /// A compromised key publishing 2^32-1 blocks nothing for the next publisher either.
    function test_Rotation_OldPublisherMaxVersion_DoesNotBlockNewPublisher() public {
        _publish(STORY, type(uint32).max, keccak256("attacker"), CID);
        _rotate(next);

        vm.startPrank(next);
        registry.publish(STORY, 1, SHA, CID);
        registry.publish(STORY, 2, keccak256("v2"), CID);
        registry.publish(STORY, type(uint32).max, keccak256("real max"), CID);
        vm.stopPrank();

        _assertReceipt(STORY, 2, next, keccak256("v2"), uint64(block.timestamp));
        _assertReceipt(STORY, type(uint32).max, next, keccak256("real max"), uint64(block.timestamp));
        _assertReceipt(STORY, type(uint32).max, publisher, keccak256("attacker"), uint64(block.timestamp));
    }

    function test_Rotation_HistoryPreserved() public {
        _publish(STORY, 1, SHA, CID);
        uint64 t = uint64(block.timestamp);
        _rotate(next);
        vm.warp(block.timestamp + 1 days);
        _assertReceipt(STORY, 1, publisher, SHA, t);
    }

    function test_Rotation_NewPublisherIsAlsoWriteOnce() public {
        _publish(STORY, 1, SHA, CID);
        _rotate(next);
        vm.prank(next);
        registry.publish(STORY, 1, SHA, CID);
        vm.prank(next);
        vm.expectRevert(abi.encodeWithSelector(AzaadAwaazRegistry.AlreadyPublished.selector, STORY, uint32(1), next));
        registry.publish(STORY, 1, keccak256("other"), CID);
    }

    /// Rotating back to an earlier key does not let it rewrite its old receipts.
    function test_Rotation_BackToOldKey_StillWriteOnce() public {
        _publish(STORY, 1, SHA, CID);
        uint64 t = uint64(block.timestamp);
        _rotate(next);
        vm.warp(block.timestamp + 1 days);
        _rotate(publisher);

        vm.prank(publisher);
        vm.expectRevert(
            abi.encodeWithSelector(AzaadAwaazRegistry.AlreadyPublished.selector, STORY, uint32(1), publisher)
        );
        registry.publish(STORY, 1, keccak256("rewrite"), CID);
        _assertReceipt(STORY, 1, publisher, SHA, t);
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
        _assertNoReceipt(STORY, 1, publisher);
    }

    function test_RevertWhen_UnknownSelector() public {
        (bool ok,) = address(registry).call(abi.encodeWithSignature("transferOwnership(address)", stranger));
        assertFalse(ok);
        assertEq(registry.owner(), owner);
    }

    function test_RevertWhen_OldInterfaceCalled() public {
        (bool ok,) = address(registry).call(abi.encodeWithSignature("latestVersion(bytes16)", STORY));
        assertFalse(ok);
        (ok,) = address(registry).call(abi.encodeWithSignature("receipt(bytes16,uint32)", STORY, uint32(1)));
        assertFalse(ok);
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

        vm.expectEmit(true, true, true, true, address(registry));
        emit Published(storyId, version, publisher, sha, cid, when);
        _publish(storyId, version, sha, cid);

        _assertReceipt(storyId, version, publisher, sha, when);
    }

    /// With no ordering rule, a second publish by the same key succeeds iff the version differs.
    function testFuzz_SecondPublish_SucceedsIffDifferentVersion(uint32 first, uint32 second) public {
        vm.assume(first != 0 && second != 0);
        _publish(STORY, first, SHA, CID);

        vm.prank(publisher);
        if (second == first) {
            vm.expectRevert(
                abi.encodeWithSelector(AzaadAwaazRegistry.AlreadyPublished.selector, STORY, first, publisher)
            );
        }
        registry.publish(STORY, second, keccak256("second"), CID);

        _assertReceipt(STORY, first, publisher, SHA, uint64(block.timestamp));
        if (second != first) _assertReceipt(STORY, second, publisher, keccak256("second"), uint64(block.timestamp));
    }

    /// After rotation, the new publisher can always write (storyId, version) whatever the old one wrote.
    function testFuzz_Rotation_NewPublisherNeverBlocked(uint32 squatted, uint32 version, bytes32 sha, address nextPub)
        public
    {
        vm.assume(squatted != 0 && version != 0 && squatted != version && sha != bytes32(0));
        vm.assume(nextPub != address(0) && nextPub != publisher);
        _publish(STORY, squatted, keccak256("squat"), CID);
        _publish(STORY, version, keccak256("squat2"), CID);
        _rotate(nextPub);

        vm.prank(nextPub);
        registry.publish(STORY, version, sha, CID);
        _assertReceipt(STORY, version, nextPub, sha, uint64(block.timestamp));
        _assertReceipt(STORY, version, publisher, keccak256("squat2"), uint64(block.timestamp));
    }

    /// Random sequences against a model: each version is accepted exactly once per publisher, in any order.
    function testFuzz_VersionSequenceMatchesModel(uint32[16] memory versions) public {
        for (uint256 i = 0; i < versions.length; i++) {
            // Bias towards small numbers so collisions actually happen.
            uint32 v = uint32(bound(versions[i], 0, 40));
            bytes32 sha = keccak256(abi.encode(i, v));
            (bytes32 existing, uint64 existingTs) = registry.receipt(STORY, v, publisher);
            vm.prank(publisher);
            if (v == 0) {
                vm.expectRevert(AzaadAwaazRegistry.InvalidVersion.selector);
                registry.publish(STORY, v, sha, CID);
            } else if (existingTs != 0) {
                vm.expectRevert(
                    abi.encodeWithSelector(AzaadAwaazRegistry.AlreadyPublished.selector, STORY, v, publisher)
                );
                registry.publish(STORY, v, sha, CID);
                _assertReceipt(STORY, v, publisher, existing, existingTs);
            } else {
                registry.publish(STORY, v, sha, CID);
                _assertReceipt(STORY, v, publisher, sha, uint64(block.timestamp));
            }
        }
    }

    function testFuzz_NonPublisherCannotPublish(address caller) public {
        vm.assume(caller != publisher);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(AzaadAwaazRegistry.NotPublisher.selector, caller));
        registry.publish(STORY, 1, SHA, CID);
    }

    function testFuzz_NonOwnerCannotSetPublisher(address caller, address nextPub) public {
        vm.assume(caller != owner);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(AzaadAwaazRegistry.NotOwner.selector, caller));
        registry.setPublisher(nextPub);
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
