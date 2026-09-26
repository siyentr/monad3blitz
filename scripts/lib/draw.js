// Off-chain recomputation of the on-chain draw. Must mirror CourseRegistration.draw().
const { ethers } = require("ethers");

const coder = ethers.AbiCoder.defaultAbiCoder();

function drawSeed(contractAddress, courseId, secrets) {
  const acc = secrets.map(BigInt).reduce((a, b) => a ^ b, 0n);
  return ethers.keccak256(
    coder.encode(["bytes32", "uint256", "address"], [ethers.toBeHex(acc, 32), courseId, contractAddress])
  );
}

function score(seed, student) {
  return BigInt(ethers.keccak256(coder.encode(["bytes32", "address"], [seed, student])));
}

// The `capacity` lowest scores win
function expectedWinners(contractAddress, courseId, secrets, pool, capacity) {
  const seed = drawSeed(contractAddress, courseId, secrets);
  return pool
    .map((student) => ({ student, score: score(seed, student) }))
    .sort((a, b) => (a.score < b.score ? -1 : 1))
    .slice(0, capacity)
    .map((e) => e.student);
}

module.exports = { drawSeed, score, expectedWinners };
