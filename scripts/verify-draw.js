// Independently re-run a course draw from public chain data and compare it with the on-chain roster.
// Usage: node scripts/verify-draw.js <contractAddress> <courseId> [rpcUrl]
const { ethers } = require("ethers");
const { drawSeed, expectedWinners } = require("./lib/draw");

const ABI = [
  "event Revealed(uint256 indexed courseId, address indexed student, bytes32 secret)",
  "function applyEnd() view returns (uint64)",
  "function revealEnd() view returns (uint64)",
  "function drawn(uint256) view returns (bool)",
  "function getCourse(uint256) view returns (tuple(string code, string title, uint8 akts, uint32 capacity, uint32 enrolled, uint32 applicants))",
  "function getRoster(uint256) view returns (address[])",
];
const LOG_CHUNK = Number(process.env.LOG_CHUNK || 100);

// First block with timestamp >= ts
async function blockAt(provider, ts, lo, hi) {
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await provider.getBlock(mid)).timestamp < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

async function main() {
  const [address, courseArg, rpc = process.env.RPC_URL || "https://testnet-rpc.monad.xyz"] = process.argv.slice(2);
  if (!address || courseArg === undefined) {
    console.error("Usage: node scripts/verify-draw.js <contractAddress> <courseId> [rpcUrl]");
    process.exit(2);
  }
  const courseId = BigInt(courseArg);
  const provider = new ethers.JsonRpcProvider(rpc);
  const reg = new ethers.Contract(address, ABI, provider);

  if (!(await reg.drawn(courseId))) throw new Error("Draw has not finished for this course yet");

  // Reveals can only happen in [applyEnd, revealEnd), so only that block range is scanned
  const latest = await provider.getBlockNumber();
  const from = await blockAt(provider, Number(await reg.applyEnd()), 0, latest);
  const to = (await blockAt(provider, Number(await reg.revealEnd()), from, latest)) - 1;

  const reveals = [];
  for (let b = from; b <= to; b += LOG_CHUNK) {
    const logs = await reg.queryFilter(reg.filters.Revealed(courseId), b, Math.min(b + LOG_CHUNK - 1, to));
    for (const l of logs) reveals.push({ student: l.args.student, secret: l.args.secret });
  }

  const course = await reg.getCourse(courseId);
  const secrets = reveals.map((r) => r.secret);
  const winners = expectedWinners(address, courseId, secrets, reveals.map((r) => r.student), Number(course.capacity));
  const roster = await reg.getRoster(courseId);

  console.log(`${course.code}: ${reveals.length} revealed applicants, ${course.capacity} seats`);
  console.log(`Seed: ${drawSeed(address, courseId, secrets)}`);
  const same = winners.length === roster.length && [...winners].sort().join() === [...roster].sort().join();
  console.log(same ? "MATCH: the on-chain roster is exactly the recomputed draw" : "MISMATCH");
  process.exitCode = same ? 0 : 1;
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
