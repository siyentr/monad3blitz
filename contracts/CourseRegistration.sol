// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title CourseRegistration
/// @notice Fair, first-come-first-served university course selection on Monad.
///         Every registered student receives 30 AKTS (soulbound, non-transferable credits).
///         Enrolling in a course spends its AKTS; dropping refunds them.
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
    }

    address public admin;
    uint64 public registrationStart;
    uint64 public registrationEnd;

    Course[] private _courses;
    mapping(address => bool) public isStudent;
    uint256 public studentCount;

    // courseId => roster, plus 1-based index for O(1) removal (0 = not enrolled)
    mapping(uint256 => address[]) private _roster;
    mapping(uint256 => mapping(address => uint256)) private _rosterIndex;

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
        _courses.push(Course({code: code, title: title, akts: akts, capacity: capacity, enrolled: 0}));
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
        c.enrolled += 1;

        _roster[courseId].push(msg.sender);
        _rosterIndex[courseId][msg.sender] = _roster[courseId].length;

        emit Transfer(msg.sender, address(0), c.akts);
        emit Enrolled(courseId, msg.sender, c.enrolled);
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

    /// @return 0 = setup, 1 = open, 2 = closed
    function phase() external view returns (uint8) {
        if (registrationStart == 0 || block.timestamp < registrationStart) return 0;
        if (block.timestamp < registrationEnd) return 1;
        return 2;
    }
}
