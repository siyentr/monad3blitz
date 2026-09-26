// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title CourseRegistration
/// @notice Fair university course selection on Monad by commit-reveal lottery.
///         First come, first served is unfair even on-chain: the block producer orders transactions,
///         so fees, bots and network speed decide who gets a seat. Here there is no race:
///         students apply with a hashed secret, reveal it later, and seats are drawn from a seed
///         that depends on every revealed secret.
///         Every registered student receives 30 AKTS (soulbound, non-transferable credits).
///         Applying to a course reserves its AKTS.
///         The admin prepares students, courses and the schedule, but once applications open
///         the admin can no longer change anything — nobody gets special treatment.
contract CourseRegistration {
    // ---------------------------------------------------------------------
    // AKTS token metadata (ERC20-compatible reads, transfers disabled)
    // ---------------------------------------------------------------------
    string public constant name = "AKTS Credit";
    string public constant symbol = "AKTS";
    uint8 public constant decimals = 0;
    uint256 public constant AKTS_PER_STUDENT = 30;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    // ---------------------------------------------------------------------
    // Registration state
    // ---------------------------------------------------------------------
    struct Course {
        string code;
        string title;
        uint8 akts;
        uint32 capacity;
        uint32 enrolled;
        uint32 applicants;
    }

    address public admin;
    uint64 public applyStart;
    uint64 public applyEnd;
    uint64 public revealEnd;

    Course[] private _courses;
    mapping(address => bool) public isStudent;
    uint256 public studentCount;

    // courseId => roster, plus 1-based index (0 = not enrolled)
    mapping(uint256 => address[]) private _roster;
    mapping(uint256 => mapping(address => uint256)) private _rosterIndex;

    // courseId => student => keccak256(abi.encode(courseId, student, secret))
    mapping(uint256 => mapping(address => bytes32)) public commitments;
    mapping(uint256 => mapping(address => bool)) public revealed;

    // courseId => XOR of revealed secrets (order-independent) and the revealed applicants
    mapping(uint256 => bytes32) public seedAcc;
    mapping(uint256 => address[]) internal _pool;

    // Draw state. Each applicant's score is keccak256(seed, student); the `capacity` lowest scores win.
    // A max-heap of the best scores so far lets the draw run in batches over thousands of applicants.
    struct Entry {
        bytes32 score;
        address student;
    }

    mapping(uint256 => Entry[]) private _heap;
    mapping(uint256 => uint256) public drawCursor;
    mapping(uint256 => bool) public drawn;
    mapping(uint256 => mapping(address => bool)) public refunded;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------
    event Transfer(address indexed from, address indexed to, uint256 value);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    event StudentAdded(address indexed student);
    event StudentRemoved(address indexed student);
    event CourseAdded(uint256 indexed courseId, string code, string title, uint8 akts, uint32 capacity);
    event CourseUpdated(uint256 indexed courseId, uint8 akts, uint32 capacity);
    event ScheduleSet(uint64 applyStart, uint64 applyEnd, uint64 revealEnd);
    event Applied(uint256 indexed courseId, address indexed student, bytes32 commitment);
    event Revealed(uint256 indexed courseId, address indexed student, bytes32 secret);
    event DrawFinished(uint256 indexed courseId, bytes32 seed, uint32 winners);
    event Refunded(uint256 indexed courseId, address indexed student, uint256 akts);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------
    error NotAdmin();
    error SetupLocked();
    error WrongPhase();
    error NotStudent();
    error AlreadyStudent(address student);
    error InvalidCourse();
    error AlreadyApplied();
    error NotApplied();
    error AlreadyRevealed();
    error WrongSecret();
    error AlreadyDrawn();
    error NotDrawn();
    error NotRefundable();
    error InsufficientAKTS(uint256 have, uint256 need);
    error InvalidWindow();
    error InvalidParams();
    error Soulbound();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    /// @dev Setup is allowed only until applications open.
    modifier setupPhase() {
        if (applyStart != 0 && block.timestamp >= applyStart) revert SetupLocked();
        _;
    }

    modifier applyOpen() {
        if (applyStart == 0 || block.timestamp < applyStart || block.timestamp >= applyEnd) revert WrongPhase();
        _;
    }

    modifier revealOpen() {
        if (applyStart == 0 || block.timestamp < applyEnd || block.timestamp >= revealEnd) revert WrongPhase();
        _;
    }

    modifier drawOpen() {
        if (applyStart == 0 || block.timestamp < revealEnd) revert WrongPhase();
        _;
    }

    modifier validCourse(uint256 courseId) {
        if (courseId >= _courses.length) revert InvalidCourse();
        _;
    }

    constructor() {
        admin = msg.sender;
        emit AdminTransferred(address(0), msg.sender);
    }

    // =====================================================================
    // Admin (setup phase only)
    // =====================================================================

    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert InvalidParams();
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }

    /// @notice Register students and mint each of them 30 AKTS.
    function addStudents(address[] calldata students) external onlyAdmin setupPhase {
        for (uint256 i = 0; i < students.length; i++) {
            address s = students[i];
            if (s == address(0)) revert InvalidParams();
            if (isStudent[s]) revert AlreadyStudent(s);
            isStudent[s] = true;
            balanceOf[s] = AKTS_PER_STUDENT;
            totalSupply += AKTS_PER_STUDENT;
            emit StudentAdded(s);
            emit Transfer(address(0), s, AKTS_PER_STUDENT);
        }
        studentCount += students.length;
    }

    /// @notice Remove a student (e.g. added by mistake). Only possible before registration opens,
    ///         so the student cannot hold any enrollments yet.
    function removeStudent(address student) external onlyAdmin setupPhase {
        if (!isStudent[student]) revert NotStudent();
        uint256 bal = balanceOf[student];
        isStudent[student] = false;
        balanceOf[student] = 0;
        totalSupply -= bal;
        studentCount -= 1;
        emit Transfer(student, address(0), bal);
        emit StudentRemoved(student);
    }

    function addCourse(string calldata code, string calldata title, uint8 akts, uint32 capacity)
        external
        onlyAdmin
        setupPhase
        returns (uint256 courseId)
    {
        if (akts == 0 || akts > AKTS_PER_STUDENT || capacity == 0 || bytes(code).length == 0) revert InvalidParams();
        courseId = _courses.length;
        _courses.push(Course({code: code, title: title, akts: akts, capacity: capacity, enrolled: 0, applicants: 0}));
        emit CourseAdded(courseId, code, title, akts, capacity);
    }

    function updateCourse(uint256 courseId, uint8 akts, uint32 capacity)
        external
        onlyAdmin
        setupPhase
        validCourse(courseId)
    {
        if (akts == 0 || akts > AKTS_PER_STUDENT || capacity == 0) revert InvalidParams();
        Course storage c = _courses[courseId];
        c.akts = akts;
        c.capacity = capacity;
        emit CourseUpdated(courseId, akts, capacity);
    }

    /// @notice Set the schedule: apply in [applyStart, applyEnd), reveal in [applyEnd, revealEnd),
    ///         draw after revealEnd. Once `applyStart_` passes, all admin setup functions are locked.
    function setSchedule(uint64 applyStart_, uint64 applyEnd_, uint64 revealEnd_) external onlyAdmin setupPhase {
        if (applyStart_ < block.timestamp || applyEnd_ <= applyStart_ || revealEnd_ <= applyEnd_) revert InvalidWindow();
        applyStart = applyStart_;
        applyEnd = applyEnd_;
        revealEnd = revealEnd_;
        emit ScheduleSet(applyStart_, applyEnd_, revealEnd_);
    }

    // =====================================================================
    // Students
    // =====================================================================

    /// @notice Apply to a course with `commitment = keccak256(abi.encode(courseId, msg.sender, secret))`.
    ///         Keep `secret` safe: it must be revealed later or the application is void.
    ///         Reserves the course's AKTS.
    function applyFor(uint256 courseId, bytes32 commitment) external applyOpen validCourse(courseId) {
        if (!isStudent[msg.sender]) revert NotStudent();
        if (commitment == bytes32(0)) revert InvalidParams();
        if (commitments[courseId][msg.sender] != bytes32(0)) revert AlreadyApplied();

        Course storage c = _courses[courseId];
        uint256 bal = balanceOf[msg.sender];
        if (bal < c.akts) revert InsufficientAKTS(bal, c.akts);

        balanceOf[msg.sender] = bal - c.akts;
        totalSupply -= c.akts;
        c.applicants += 1;
        commitments[courseId][msg.sender] = commitment;

        emit Transfer(msg.sender, address(0), c.akts);
        emit Applied(courseId, msg.sender, commitment);
    }

    /// @notice Reveal the secret behind an application. Only revealed applicants enter the draw;
    ///         an unrevealed application is void and its AKTS are not refunded.
    function reveal(uint256 courseId, bytes32 secret) external revealOpen validCourse(courseId) {
        bytes32 commitment = commitments[courseId][msg.sender];
        if (commitment == bytes32(0)) revert NotApplied();
        if (revealed[courseId][msg.sender]) revert AlreadyRevealed();
        if (keccak256(abi.encode(courseId, msg.sender, secret)) != commitment) revert WrongSecret();

        revealed[courseId][msg.sender] = true;
        seedAcc[courseId] ^= secret;
        _pool[courseId].push(msg.sender);

        emit Revealed(courseId, msg.sender, secret);
    }

    // =====================================================================
    // Draw (anyone can call it, so the admin cannot stall it)
    // =====================================================================

    /// @notice Final random seed of a course. Fixed once the reveal window closes.
    function drawSeed(uint256 courseId) public view returns (bytes32) {
        return keccak256(abi.encode(seedAcc[courseId], courseId, address(this)));
    }

    /// @notice Run the draw for up to `maxSteps` applicants. Call repeatedly until `drawn(courseId)`.
    ///         The winners are the same for any batch size and any reveal order.
    function draw(uint256 courseId, uint256 maxSteps) external drawOpen validCourse(courseId) {
        if (drawn[courseId]) revert AlreadyDrawn();
        if (maxSteps == 0) revert InvalidParams();

        Course storage c = _courses[courseId];
        address[] storage pool = _pool[courseId];
        Entry[] storage heap = _heap[courseId];
        bytes32 seed = drawSeed(courseId);
        uint256 n = pool.length;
        uint256 cursor = drawCursor[courseId];
        uint256 steps;

        // Pass 1: keep the `capacity` lowest scores in the heap
        for (; cursor < n && steps < maxSteps; steps++) {
            address student = pool[cursor++];
            bytes32 score = keccak256(abi.encode(seed, student));
            if (heap.length < c.capacity) {
                heap.push(Entry(score, student));
                _siftUp(heap, heap.length - 1);
            } else if (score < heap[0].score) {
                heap[0] = Entry(score, student);
                _siftDown(heap, 0);
            }
        }
        drawCursor[courseId] = cursor;

        // Pass 2: seat the winners
        address[] storage roster = _roster[courseId];
        while (cursor == n && roster.length < heap.length && steps < maxSteps) {
            address winner = heap[roster.length].student;
            roster.push(winner);
            _rosterIndex[courseId][winner] = roster.length;
            steps++;
        }

        if (cursor == n && roster.length == heap.length) {
            drawn[courseId] = true;
            c.enrolled = uint32(roster.length);
            emit DrawFinished(courseId, seed, c.enrolled);
        }
    }

    /// @notice Get the reserved AKTS back after losing the draw. Unrevealed applications are not refunded.
    function claimRefund(uint256 courseId) external validCourse(courseId) {
        if (!drawn[courseId]) revert NotDrawn();
        if (!revealed[courseId][msg.sender] || isEnrolled(courseId, msg.sender) || refunded[courseId][msg.sender]) {
            revert NotRefundable();
        }
        refunded[courseId][msg.sender] = true;
        uint256 akts = _courses[courseId].akts;
        balanceOf[msg.sender] += akts;
        totalSupply += akts;
        emit Transfer(address(0), msg.sender, akts);
        emit Refunded(courseId, msg.sender, akts);
    }

    function _siftUp(Entry[] storage heap, uint256 i) private {
        Entry memory e = heap[i];
        while (i > 0) {
            uint256 parent = (i - 1) / 2;
            if (heap[parent].score >= e.score) break;
            heap[i] = heap[parent];
            i = parent;
        }
        heap[i] = e;
    }

    function _siftDown(Entry[] storage heap, uint256 i) private {
        uint256 len = heap.length;
        Entry memory e = heap[i];
        while (true) {
            uint256 child = 2 * i + 1;
            if (child >= len) break;
            if (child + 1 < len && heap[child + 1].score > heap[child].score) child++;
            if (heap[child].score <= e.score) break;
            heap[i] = heap[child];
            i = child;
        }
        heap[i] = e;
    }

    // =====================================================================
    // AKTS is soulbound: transfers and approvals are disabled
    // =====================================================================

    function transfer(address, uint256) external pure returns (bool) {
        revert Soulbound();
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        revert Soulbound();
    }

    function approve(address, uint256) external pure returns (bool) {
        revert Soulbound();
    }

    function allowance(address, address) external pure returns (uint256) {
        return 0;
    }

    // =====================================================================
    // Views
    // =====================================================================

    function courseCount() external view returns (uint256) {
        return _courses.length;
    }

    function getCourse(uint256 courseId) external view validCourse(courseId) returns (Course memory) {
        return _courses[courseId];
    }

    function getAllCourses() external view returns (Course[] memory) {
        return _courses;
    }

    function getRoster(uint256 courseId) external view validCourse(courseId) returns (address[] memory) {
        return _roster[courseId];
    }

    /// @notice Applicants who revealed, in reveal order (order does not affect the draw).
    function getPool(uint256 courseId) external view validCourse(courseId) returns (address[] memory) {
        return _pool[courseId];
    }

    function isEnrolled(uint256 courseId, address student) public view returns (bool) {
        return _rosterIndex[courseId][student] != 0;
    }

    /// @notice Course ids the student is enrolled in.
    function getStudentCourses(address student) external view returns (uint256[] memory ids) {
        uint256 n;
        for (uint256 i = 0; i < _courses.length; i++) {
            if (_rosterIndex[i][student] != 0) n++;
        }
        ids = new uint256[](n);
        uint256 j;
        for (uint256 i = 0; i < _courses.length; i++) {
            if (_rosterIndex[i][student] != 0) ids[j++] = i;
        }
    }

    /// @return 0 = setup, 1 = apply, 2 = reveal, 3 = draw
    function phase() external view returns (uint8) {
        if (applyStart == 0 || block.timestamp < applyStart) return 0;
        if (block.timestamp < applyEnd) return 1;
        if (block.timestamp < revealEnd) return 2;
        return 3;
    }
}
