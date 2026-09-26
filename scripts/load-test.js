// Load test: N fresh wallets apply to one course at the same time, reveal, then the draw runs.
// Usage: N=5000 RPCS=https://rpc1,https://rpc2 pnpm load:testnet
// Env:
//   N       number of students (default 200)
//   SEATS   course capacity (default 40)
//   RPCS    comma-separated RPC URLs used round-robin for student transactions (public RPCs are rate limited)
//   FUND    MON sent to each student wallet (default: enough for apply + reveal at the current gas price)
// The deployer account (PRIVATE_KEY) pays for everything and becomes admin of a fresh contract.
const hre = require("hardhat");
const { ethers } = hre;

const N = Number(process.env.N || 200);
const SEATS = Number(process.env.SEATS || 40);
// Monad charges the gas limit, so keep these tight. Measured: apply ~73k, reveal ~88k (first reveal ~122k)
const APPLY_GAS = 90_000n;
const REVEAL_GAS = 140_000n;
const DRAW_BATCH = Number(process.env.DRAW_BATCH || 1000);
const LOCAL = ["hardhat", "localhost"].includes(hre.network.name);

const coder = ethers.AbiCoder.defaultAbiCoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(ts) {
  if (LOCAL) {
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    if (now < ts) await ethers.provider.send("evm_setNextBlockTimestamp", [ts]);
    await ethers.provider.send("evm_mine", []);
    return;
  }
  while ((await ethers.provider.getBlock("latest")).timestamp < ts) await sleep(1000);
}

// Send one tx per wallet at once, round-robin over RPCs; report success rate, latency and blocks used
async function burst(label, wallets, makeTx) {
  const t0 = performance.now();
  const results = await Promise.all(
    wallets.map(async (w, i) => {
      const start = performance.now();
      try {
        const tx = await makeTx(w, i);
        const r = await tx.wait();
        return { ok: r.status === 1, block: r.blockNumber, ms: performance.now() - start };
      } catch (e) {
        return { ok: false, err: e.shortMessage || e.message, ms: performance.now() - start };
      }
    })
  );
  const ok = results.filter((r) => r.ok);
  const blocks = new Set(ok.map((r) => r.block));
  const ms = ok.map((r) => r.ms).sort((a, b) => a - b);
  const pct = (p) => (ms.length ? (ms[Math.min(ms.length - 1, Math.floor(ms.length * p))] / 1000).toFixed(2) : "-");
  console.log(
    `${label}: ${ok.length}/${wallets.length} ok in ${((performance.now() - t0) / 1000).toFixed(1)}s, ` +
      `${blocks.size} blocks, latency p50 ${pct(0.5)}s p95 ${pct(0.95)}s`
  );
  const errors = results.filter((r) => !r.ok).map((r) => r.err);
  if (errors.length) console.log(`  first errors: ${[...new Set(errors)].slice(0, 3).join(" | ")}`);
  return results;
}

async function main() {
  const [admin] = await ethers.getSigners();
  if (!admin) throw new Error("No deployer account. Set PRIVATE_KEY (see README).");
  const rpcs = (process.env.RPCS || "").split(",").filter(Boolean);
  const providers = rpcs.length ? rpcs.map((u) => new ethers.JsonRpcProvider(u)) : [ethers.provider];
  console.log(`Load test on ${hre.network.name}: ${N} students, ${SEATS} seats, ${providers.length} RPC(s)`);

  const wallets = Array.from({ length: N }, (_, i) =>
    ethers.Wallet.createRandom().connect(providers[i % providers.length])
  );
  const secrets = wallets.map(() => ethers.hexlify(ethers.randomBytes(32)));

  const reg = await ethers.deployContract("CourseRegistration");
  await reg.waitForDeployment();
  console.log(`Contract ${await reg.getAddress()}`);
  for (let i = 0; i < N; i += 200) {
    await (await reg.addStudents(wallets.slice(i, i + 200).map((w) => w.address))).wait();
  }
  await (await reg.addCourse("LOAD", "Load test course", 5, SEATS)).wait();

  // Fund every wallet for exactly one apply and one reveal
  const fee = await ethers.provider.getFeeData();
  const perWallet = process.env.FUND
    ? ethers.parseEther(process.env.FUND)
    : ((APPLY_GAS + REVEAL_GAS) * (fee.maxFeePerGas ?? fee.gasPrice) * 3n) / 2n;
  console.log(`Funding ${N} wallets with ${ethers.formatEther(perWallet)} each...`);
  let nonce = await ethers.provider.getTransactionCount(admin.address, "pending");
  const funding = [];
  for (const w of wallets) funding.push(await admin.sendTransaction({ to: w.address, value: perWallet, nonce: nonce++ }));
  await Promise.all(funding.map((t) => t.wait()));

  // Short windows: the burst happens right after applications open
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  const applyStart = now + 20;
  // Locally every automined tx is its own block and moves time by 1s, so windows must be longer
  const window = LOCAL ? 3600 : 120;
  const applyEnd = applyStart + Number(process.env.APPLY_SECONDS || window);
  const revealEnd = applyEnd + Number(process.env.REVEAL_SECONDS || window);
  await (await reg.setSchedule(applyStart, applyEnd, revealEnd)).wait();
  const address = await reg.getAddress();
  const as = (w) => new ethers.Contract(address, reg.interface, w);

  await waitUntil(applyStart);
  await burst("apply", wallets, (w, i) => {
    const c = ethers.keccak256(coder.encode(["uint256", "address", "bytes32"], [0, w.address, secrets[i]]));
    return as(w).applyFor(0, c, { gasLimit: APPLY_GAS });
  });

  await waitUntil(applyEnd);
  await burst("reveal", wallets, (w, i) => as(w).reveal(0, secrets[i], { gasLimit: REVEAL_GAS }));

  await waitUntil(revealEnd);
  let calls = 0;
  let gas = 0n;
  while (!(await reg.drawn(0))) {
    const r = await (await reg.draw(0, DRAW_BATCH)).wait();
    calls++;
    gas += r.gasUsed;
  }
  console.log(`draw: ${calls} call(s), ${gas.toLocaleString("en-US")} gas total`);
  console.log(`Verify: pnpm verify:draw ${address} 0 <rpcUrl>`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
