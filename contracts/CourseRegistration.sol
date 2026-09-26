// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title CourseRegistration
/// @notice Fair, first-come-first-served university course selection on Monad.
///         Every registered student receives 30 AKTS (soulbound, non-transferable credits).
///         Enrolling in a course spends its AKTS; dropping refunds them.
///         A full course has a first-come-first-served waitlist: joining it reserves the course's
///         AKTS, and when an enrolled student drops, the first student in line takes the seat.
///         The admin prepares students, courses and the registration window, but once the
///         window opens the admin can no longer change anything — nobody gets special treatment.
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
        uint32 waitlisted;
    }

    address public admin;
    uint64 public registrationStart;
    uint64 public registrationEnd;

    Course[] private _courses;
    mapping(address => bool) public isStudent;
    uint256 public studentCount;

    // Student list for the admin panel, plus 1-based index for O(1) removal
    address[] private _students;
    mapping(address => uint256) private _studentIndex;

    // courseId => roster, plus 1-based index for O(1) removal (0 = not enrolled)
    mapping(uint256 => address[]) private _roster;
    mapping(uint256 => mapping(address => uint256)) private _rosterIndex;

    // courseId => waitlist as a doubly linked list, so anyone can leave the line in O(1)
    mapping(uint256 => address) private _wlHead;
    mapping(uint256 => address) private _wlTail;
    mapping(uint256 => mapping(address => address)) private _wlNext;
    mapping(uint256 => mapping(address => address)) private _wlPrev;
    mapping(uint256 => mapping(address => bool)) private _onWaitlist;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------
    event Transfer(address indexed from, address indexed to, uint256 value);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    event StudentAdded(address indexed student);
    event StudentRemoved(address indexed student);
    event CourseAdded(uint256 indexed courseId, string code, string title, uint8 akts, uint32 capacity);
    event CourseUpdated(uint256 indexed courseId, uint8 akts, uint32 capacity);
    event RegistrationWindowSet(uint64 start, uint64 end);
    event Enrolled(uint256 indexed courseId, address indexed student, uint32 seatsTaken);
    event Dropped(uint256 indexed courseId, address indexed student, uint32 seatsTaken);
    event WaitlistJoined(uint256 indexed courseId, address indexed student, uint32 position);
    event WaitlistLeft(uint256 indexed courseId, address indexed student);
    event PromotedFromWaitlist(uint256 indexed courseId, address indexed student);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------
    error NotAdmin();
    error SetupLocked();
    error RegistrationClosed();
    error NotStudent();
    error AlreadyStudent(address student);
    error InvalidCourse();
    error CourseFull();
    error AlreadyEnrolled();
    error NotEnrolled();
    error CourseNotFull();
    error AlreadyWaitlisted();
    error NotWaitlisted();
    error InsufficientAKTS(uint256 have, uint256 need);
    error InvalidWindow();
    error InvalidParams();
    error Soulbound();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    /// @dev Setup is allowed only until the registration window opens.
    modifier setupPhase() {
        if (registrationStart != 0 && block.timestamp >= registrationStart) revert SetupLocked();
        _;
    }

    modifier registrationOpen() {
        if (registrationStart == 0 || block.timestamp < registrationStart || block.timestamp >= registrationEnd) {
            revert RegistrationClosed();
        }
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
            _students.push(s);
            _studentIndex[s] = _students.length;
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

        // swap-and-pop removal from the student list
        uint256 idx = _studentIndex[student];
        address last = _students[_students.length - 1];
        _students[idx - 1] = last;
        _studentIndex[last] = idx;
        _students.pop();
        delete _studentIndex[student];
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
        _courses.push(Course({code: code, title: title, akts: akts, capacity: capacity, enrolled: 0, waitlisted: 0}));
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

    /// @notice Set the registration window. Once `start` passes, all admin setup functions are locked.
    function setRegistrationWindow(uint64 start, uint64 end) external onlyAdmin setupPhase {
        if (start < block.timestamp || end <= start) revert InvalidWindow();
        registrationStart = start;
        registrationEnd = end;
        emit RegistrationWindowSet(start, end);
    }

    // =====================================================================
    // Students
    // =====================================================================

    function enroll(uint256 courseId) external registrationOpen validCourse(courseId) {
        if (!isStudent[msg.sender]) revert NotStudent();
        if (_rosterIndex[courseId][msg.sender] != 0) revert AlreadyEnrolled();

        Course storage c = _courses[courseId];
        if (c.enrolled >= c.capacity) revert CourseFull();

        uint256 bal = balanceOf[msg.sender];
        if (bal < c.akts) revert InsufficientAKTS(bal, c.akts);

        balanceOf[msg.sender] = bal - c.akts;
        totalSupply -= c.akts;
        emit Transfer(msg.sender, address(0), c.akts);
        _seat(courseId, msg.sender);
    }

    function drop(uint256 courseId) external registrationOpen validCourse(courseId) {
        uint256 idx = _rosterIndex[courseId][msg.sender];
        if (idx == 0) revert NotEnrolled();

        // swap-and-pop removal from roster
        address[] storage roster = _roster[courseId];
        address last = roster[roster.length - 1];
        roster[idx - 1] = last;
        _rosterIndex[courseId][last] = idx;
        roster.pop();
        delete _rosterIndex[courseId][msg.sender];

        Course storage c = _courses[courseId];
        c.enrolled -= 1;
        balanceOf[msg.sender] += c.akts;
        totalSupply += c.akts;

        emit Transfer(address(0), msg.sender, c.akts);
        emit Dropped(courseId, msg.sender, c.enrolled);

        // The freed seat goes to the first student in line; their AKTS were reserved when they joined
        address next = _wlHead[courseId];
        if (next != address(0)) {
            _unlink(courseId, next);
            _seat(courseId, next);
            emit PromotedFromWaitlist(courseId, next);
        }
    }

    /// @notice Get in line for a full course. The course's AKTS are reserved now, so the seat can be
    ///         handed over automatically when someone drops.
    function joinWaitlist(uint256 courseId) external registrationOpen validCourse(courseId) {
        if (!isStudent[msg.sender]) revert NotStudent();
        if (_rosterIndex[courseId][msg.sender] != 0) revert AlreadyEnrolled();
        if (_onWaitlist[courseId][msg.sender]) revert AlreadyWaitlisted();

        Course storage c = _courses[courseId];
        // A waitlist only exists while the course is full; drops refill seats from it immediately
        if (c.enrolled < c.capacity) revert CourseNotFull();

        uint256 bal = balanceOf[msg.sender];
        if (bal < c.akts) revert InsufficientAKTS(bal, c.akts);
        balanceOf[msg.sender] = bal - c.akts;
        totalSupply -= c.akts;

        address tail = _wlTail[courseId];
        if (tail == address(0)) _wlHead[courseId] = msg.sender;
        else _wlNext[courseId][tail] = msg.sender;
        _wlPrev[courseId][msg.sender] = tail;
        _wlTail[courseId] = msg.sender;
        _onWaitlist[courseId][msg.sender] = true;
        c.waitlisted += 1;

        emit Transfer(msg.sender, address(0), c.akts);
        emit WaitlistJoined(courseId, msg.sender, c.waitlisted);
    }

    /// @notice Leave a waitlist and get the reserved AKTS back.
    function leaveWaitlist(uint256 courseId) external registrationOpen validCourse(courseId) {
        if (!_onWaitlist[courseId][msg.sender]) revert NotWaitlisted();
        _unlink(courseId, msg.sender);

        uint8 akts = _courses[courseId].akts;
        balanceOf[msg.sender] += akts;
        totalSupply += akts;

        emit Transfer(address(0), msg.sender, akts);
        emit WaitlistLeft(courseId, msg.sender);
    }

    /// @dev Add a student to the roster. AKTS must already be paid.
    function _seat(uint256 courseId, address student) private {
        Course storage c = _courses[courseId];
        c.enrolled += 1;
        _roster[courseId].push(student);
        _rosterIndex[courseId][student] = _roster[courseId].length;
        emit Enrolled(courseId, student, c.enrolled);
    }

    function _unlink(uint256 courseId, address student) private {
        address prev = _wlPrev[courseId][student];
        address next = _wlNext[courseId][student];
        if (prev == address(0)) _wlHead[courseId] = next;
        else _wlNext[courseId][prev] = next;
        if (next == address(0)) _wlTail[courseId] = prev;
        else _wlPrev[courseId][next] = prev;
        delete _wlPrev[courseId][student];
        delete _wlNext[courseId][student];
        delete _onWaitlist[courseId][student];
        _courses[courseId].waitlisted -= 1;
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

    function getStudents() external view returns (address[] memory) {
        return _students;
    }

    function getRoster(uint256 courseId) external view validCourse(courseId) returns (address[] memory) {
        return _roster[courseId];
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

    /// @notice Students waiting for the course, first in line first.
    function getWaitlist(uint256 courseId) external view validCourse(courseId) returns (address[] memory list) {
        list = new address[](_courses[courseId].waitlisted);
        address cur = _wlHead[courseId];
        for (uint256 i = 0; cur != address(0); i++) {
            list[i] = cur;
            cur = _wlNext[courseId][cur];
        }
    }

    /// @return 1-based place in line, or 0 if the student is not waiting for the course.
    function waitlistPosition(uint256 courseId, address student) public view returns (uint256) {
        if (!_onWaitlist[courseId][student]) return 0;
        uint256 pos = 1;
        for (address cur = _wlHead[courseId]; cur != student; cur = _wlNext[courseId][cur]) pos++;
        return pos;
    }

    /// @notice Courses the student is waiting for, with their place in each line.
    function getStudentWaitlists(address student)
        external
        view
        returns (uint256[] memory ids, uint256[] memory positions)
    {
        uint256 n;
        for (uint256 i = 0; i < _courses.length; i++) {
            if (_onWaitlist[i][student]) n++;
        }
        ids = new uint256[](n);
        positions = new uint256[](n);
        uint256 j;
        for (uint256 i = 0; i < _courses.length; i++) {
            if (_onWaitlist[i][student]) {
                ids[j] = i;
                positions[j++] = waitlistPosition(i, student);
            }
        }
    }

    /// @return 0 = setup, 1 = open, 2 = closed
    function phase() external view returns (uint8) {
        if (registrationStart == 0 || block.timestamp < registrationStart) return 0;
        if (block.timestamp < registrationEnd) return 1;
        return 2;
    }
}
