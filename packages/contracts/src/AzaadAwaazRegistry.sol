// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title AzaadAwaazRegistry
/// @notice Append-only, on-chain receipts for published AzaadAwaaz story manifests (SPEC §9).
/// @dev Deliberately minimal and immutable: no upgradeability, no funds, no deletion. The owner is fixed forever and
///      may only rotate the publisher key. A receipt, once written, can never be removed or changed.
contract AzaadAwaazRegistry {
    /// @notice A stored receipt for one (storyId, version) pair.
    struct Receipt {
        bytes32 manifestSha256;
        uint64 timestamp;
    }

    /// @notice Maximum length, in bytes, of a manifest CID string.
    uint256 public constant MAX_CID_LENGTH = 128;

    /// @notice The owner (an offline EVM key). Fixed at deployment; cannot be transferred.
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    address public immutable owner;

    /// @notice The only address allowed to call {publish}.
    address public publisher;

    mapping(bytes16 storyId => uint32 version) private _latestVersion;
    mapping(bytes16 storyId => mapping(uint32 version => Receipt receipt)) private _receipts;

    /// @notice Emitted once per receipt. `timestamp` is the block timestamp at which it was recorded.
    event Published(
        bytes16 indexed storyId, uint32 version, bytes32 manifestSha256, string manifestCid, uint64 timestamp
    );

    /// @notice Emitted when the publisher changes (including at deployment, with `oldPublisher == address(0)`).
    event PublisherChanged(address indexed oldPublisher, address indexed newPublisher);

    error NotOwner(address caller);
    error NotPublisher(address caller);
    error ZeroAddress();
    error InvalidStoryId();
    error InvalidVersion();
    error AlreadyPublished(bytes16 storyId, uint32 version);
    error VersionNotIncreasing(bytes16 storyId, uint32 latest, uint32 given);
    error EmptyManifestHash();
    error EmptyManifestCid();
    error ManifestCidTooLong(uint256 length);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    modifier onlyPublisher() {
        if (msg.sender != publisher) revert NotPublisher(msg.sender);
        _;
    }

    /// @param owner_ The fixed owner, allowed to rotate the publisher.
    /// @param publisher_ The initial publisher.
    constructor(address owner_, address publisher_) {
        if (owner_ == address(0) || publisher_ == address(0)) revert ZeroAddress();
        owner = owner_;
        publisher = publisher_;
        emit PublisherChanged(address(0), publisher_);
    }

    /// @notice Replace the publisher. Only the owner may call this.
    /// @param next The new publisher address (non-zero).
    function setPublisher(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        address old = publisher;
        publisher = next;
        emit PublisherChanged(old, next);
    }

    /// @notice Record a receipt for a published story manifest.
    /// @param storyId The 16-byte story id (non-zero).
    /// @param version The manifest version; at least 1 and strictly greater than the latest recorded version.
    /// @param manifestSha256 SHA-256 of the canonical manifest bytes (non-zero).
    /// @param manifestCid The manifest's IPFS CID (1 to 128 bytes).
    function publish(bytes16 storyId, uint32 version, bytes32 manifestSha256, string calldata manifestCid)
        external
        onlyPublisher
    {
        if (storyId == bytes16(0)) revert InvalidStoryId();
        if (version == 0) revert InvalidVersion();
        if (_receipts[storyId][version].timestamp != 0) revert AlreadyPublished(storyId, version);
        uint32 latest = _latestVersion[storyId];
        if (version <= latest) revert VersionNotIncreasing(storyId, latest, version);
        if (manifestSha256 == bytes32(0)) revert EmptyManifestHash();
        uint256 cidLength = bytes(manifestCid).length;
        if (cidLength == 0) revert EmptyManifestCid();
        if (cidLength > MAX_CID_LENGTH) revert ManifestCidTooLong(cidLength);

        uint64 timestamp = uint64(block.timestamp);
        _latestVersion[storyId] = version;
        _receipts[storyId][version] = Receipt({manifestSha256: manifestSha256, timestamp: timestamp});

        emit Published(storyId, version, manifestSha256, manifestCid, timestamp);
    }

    /// @notice Read the receipt for a (storyId, version) pair. Returns zeros if none exists.
    function receipt(bytes16 storyId, uint32 version)
        external
        view
        returns (bytes32 manifestSha256, uint64 timestamp)
    {
        Receipt storage r = _receipts[storyId][version];
        return (r.manifestSha256, r.timestamp);
    }

    /// @notice The latest published version for a story, or 0 if none.
    function latestVersion(bytes16 storyId) external view returns (uint32) {
        return _latestVersion[storyId];
    }
}
