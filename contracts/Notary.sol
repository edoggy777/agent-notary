// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Agent Notary (fully on-chain)
/// @notice Proves that a piece of data existed at a point in time. Send the SHA-256 hash of
///         your work with the fee; the hash, block time and your address are recorded forever.
///         Only the hash is stored, never the data. Verifying is free.
/// @dev No server is involved: the fee, the stamp and the record all live in this contract.
contract Notary {
    struct Stamp {
        uint64 timestamp; // block time of the first stamp (0 = never stamped)
        uint64 blockNumber;
        address requester; // the wallet that paid and sent the stamp
    }

    mapping(bytes32 => Stamp) private _stamps;
    uint256 public totalStamps;
    uint256 public fee; // wei per new hash
    address public owner;

    event Stamped(bytes32 indexed hash, address indexed requester, uint64 timestamp, string memo);
    event FeeChanged(uint256 oldFee, uint256 newFee);
    event Withdrawn(address indexed to, uint256 amount);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error AlreadyStamped(bytes32 hash, uint64 timestamp);
    error FeeTooLow(uint256 sent, uint256 required);
    error NothingNew();
    error NotOwner();
    error EmptyHash();
    error MemoTooLong();
    error TransferFailed();

    uint256 private _locked = 1;
    modifier nonReentrant() {
        require(_locked == 1, "reentrant");
        _locked = 2;
        _;
        _locked = 1;
    }
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(uint256 initialFee) {
        owner = msg.sender;
        fee = initialFee;
        emit OwnershipTransferred(address(0), msg.sender);
        emit FeeChanged(0, initialFee);
    }

    // ------------------------------------------------------------------ stamping

    /// @notice Stamp one hash. Send at least `fee` wei; any extra is refunded.
    ///         Reverts (so you keep your money) if the hash is already stamped.
    function stamp(bytes32 hash, string calldata memo) external payable nonReentrant {
        if (msg.value < fee) revert FeeTooLow(msg.value, fee);
        Stamp memory existing = _stamps[hash];
        if (existing.timestamp != 0) revert AlreadyStamped(hash, existing.timestamp);
        _record(hash, memo);
        _refund(msg.value - fee);
    }

    /// @notice Stamp many hashes in one transaction. You pay `fee` only for hashes that are new;
    ///         already-stamped ones are skipped, and any extra payment is refunded.
    /// @return added how many hashes were newly stamped
    function stampBatch(bytes32[] calldata hashes, string calldata memo) external payable nonReentrant returns (uint256 added) {
        for (uint256 i = 0; i < hashes.length; i++) {
            if (_stamps[hashes[i]].timestamp == 0) {
                _record(hashes[i], memo);
                added++;
            }
        }
        if (added == 0) revert NothingNew();
        uint256 required = fee * added;
        if (msg.value < required) revert FeeTooLow(msg.value, required);
        _refund(msg.value - required);
    }

    // ------------------------------------------------------------------ reading (free)

    /// @notice When was this hash first stamped, and by whom? timestamp == 0 means never.
    function verify(bytes32 hash) external view returns (Stamp memory) {
        return _stamps[hash];
    }

    /// @notice How much to send to stamp `count` new hashes.
    function price(uint256 count) external view returns (uint256) {
        return fee * count;
    }

    /// @notice Plain-language instructions, readable by any agent straight from the chain.
    function about() external pure returns (string memory) {
        return
            "Agent Notary. Proves data existed at a point in time. "
            "1) Hash your data with SHA-256 (32 bytes). "
            "2) Call verify(hash) to check it is not stamped yet (free). "
            "3) Call stamp(hash, memo) sending fee() wei; extra is refunded, duplicates revert so you keep your money. "
            "stampBatch(hashes, memo) charges only for new hashes. "
            "Anyone can later call verify(hash) to see the time, block and requester. Only the hash is stored.";
    }

    // ------------------------------------------------------------------ owner

    function setFee(uint256 newFee) external onlyOwner {
        emit FeeChanged(fee, newFee);
        fee = newFee;
    }

    /// @notice Send collected fees to `to`.
    function withdraw(address payable to) external onlyOwner nonReentrant {
        uint256 amount = address(this).balance;
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(to, amount);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero owner");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ------------------------------------------------------------------ internal

    function _record(bytes32 hash, string calldata memo) internal {
        if (hash == bytes32(0)) revert EmptyHash();
        if (bytes(memo).length > 280) revert MemoTooLong();
        _stamps[hash] = Stamp(uint64(block.timestamp), uint64(block.number), msg.sender);
        totalStamps++;
        emit Stamped(hash, msg.sender, uint64(block.timestamp), memo);
    }

    function _refund(uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
