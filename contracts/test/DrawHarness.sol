// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CourseRegistration} from "../CourseRegistration.sol";

/// @dev Benchmark only: fills a course's reveal pool directly so draw() can be measured
///      for thousands of applicants without sending thousands of transactions.
contract DrawHarness is CourseRegistration {
    function fillPool(uint256 courseId, uint256 count, uint256 offset) external {
        for (uint256 i = 0; i < count; i++) {
            address student = address(uint160(uint256(keccak256(abi.encode(offset + i)))));
            _pool[courseId].push(student);
            revealed[courseId][student] = true;
            seedAcc[courseId] ^= keccak256(abi.encode("secret", offset + i));
        }
    }
}
