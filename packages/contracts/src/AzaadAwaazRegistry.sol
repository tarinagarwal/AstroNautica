// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title AzaadAwaazRegistry
/// @notice Append-only, on-chain receipts for published AzaadAwaaz story manifests (SPEC §9).
/// @dev Deliberately minimal and immutable: no upgradeability, no funds, no deletion. The owner is fixed forever and
///      may only rotate the publisher key. A receipt, once written, can never be removed or changed.
///
///      Receipts are keyed by (storyId, version, publisher address). Each publisher key writes its own receipt for a
///      given (storyId, version), at most once. There is no ordering between versions. This means a compromised
///      publisher key cannot block corrections (for example by publishing version 2^32-1) or squat a version so the
///      real publisher's receipt can never be written: after the owner rotates the key with {setPublisher}, the new
///      publisher writes its own receipts under its own address.
///
///      Trust rule for clients: a receipt `receipt(storyId, version, by)` is trusted only if `by` was the publisher
///      address on the owner-signed publisher list at the receipt's block timestamp. Receipts from any other address
///      exist on chain but must be ignored. The contract guarantees that a key cannot write after it is rotated out;
///      it cannot know when a key was compromised, which is what the owner-signed list records.
contract AzaadAwaazRegistry {
    /// @notice A stored receipt for one (storyId, version, publisher) triple.
    struct Receipt {
        bytes32 manifestSha256;
        uint64 timestamp;
    }

    /// @notice Maximum length, in bytes, of a manifest CID string.
    uint256 public constant MAX_CID_LENGTH = 128;

    /// @notice The owner (an offline EVM key). Fixed at deployment; cannot be transferred.
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    address public immutable owner;

    /// @notice The only address currently allowed to call {publish}.
    address public publisher;

    mapping(bytes16 storyId => mapping(uint32 version => mapping(address by => Receipt receipt))) private _receipts;

    /// @notice Emitted once per receipt. `publisher` is the address that wrote it; `timestamp` is the block timestamp
    ///         at which it was recorded.
    event Published(
        bytes16 indexed storyId,
        uint32 indexed version,
        address indexed publisher,
        bytes32 manifestSha256,
        string manifestCid,
        uint64 timestamp
    );

    /// @notice Emitted when the publisher changes (including at deployment, with `oldPublisher == address(0)`).
    event PublisherChanged(address indexed oldPublisher, address indexed newPublisher);

    error NotOwner(address caller);
    error NotPublisher(address caller);
    error ZeroAddress();
    error InvalidStoryId();
    error InvalidVersion();
    error AlreadyPublished(bytes16 storyId, uint32 version, address publisher);
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

    /// @notice Replace the publisher. Only the owner may call this. Receipts already written by the old publisher
    ///         stay readable under its address; the new publisher may write its own receipt for any
    ///         (storyId, version), including ones the old publisher already wrote.
    /// @param next The new publisher address (non-zero).
    function setPublisher(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        address old = publisher;
        publisher = next;
        emit PublisherChanged(old, next);
    }

    /// @notice Record the caller's receipt for a published story manifest.
    /// @dev Each (storyId, version, msg.sender) triple can be written once. Versions need not be increasing.
    /// @param storyId The 16-byte story id (non-zero).
    /// @param version The manifest version (at least 1).
    /// @param manifestSha256 SHA-256 of the canonical manifest bytes (non-zero).
    /// @param manifestCid The manifest's IPFS CID (1 to 128 bytes).
    function publish(bytes16 storyId, uint32 version, bytes32 manifestSha256, string calldata manifestCid)
        external
        onlyPublisher
    {
        if (storyId == bytes16(0)) revert InvalidStoryId();
        if (version == 0) revert InvalidVersion();
        if (manifestSha256 == bytes32(0)) revert EmptyManifestHash();
        uint256 cidLength = bytes(manifestCid).length;
        if (cidLength == 0) revert EmptyManifestCid();
        if (cidLength > MAX_CID_LENGTH) revert ManifestCidTooLong(cidLength);

        Receipt storage r = _receipts[storyId][version][msg.sender];
        // manifestSha256 is never zero for a stored receipt, so it doubles as the existence flag.
        if (r.manifestSha256 != bytes32(0)) revert AlreadyPublished(storyId, version, msg.sender);

        uint64 timestamp = uint64(block.timestamp);
        r.manifestSha256 = manifestSha256;
        r.timestamp = timestamp;

        emit Published(storyId, version, msg.sender, manifestSha256, manifestCid, timestamp);
    }

    /// @notice Read the receipt that `by` wrote for (storyId, version). Returns zeros if none exists.
    /// @dev Trust it only if `by` was the owner-approved publisher at `timestamp` (see the contract notes).
    function receipt(bytes16 storyId, uint32 version, address by)
        external
        view
        returns (bytes32 manifestSha256, uint64 timestamp)
    {
        Receipt storage r = _receipts[storyId][version][by];
        return (r.manifestSha256, r.timestamp);
    }
}
