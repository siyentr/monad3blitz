// Gas benchmark for draw(): how many applicants fit in one transaction?
// Usage: pnpm bench:draw   (runs on the in-process hardhat network)
// Env: GAS_BUDGET (default 30000000) = the per-transaction gas you are willing to pay for
const hre = require("hardhat");
const { ethers } = hre;

const SIZES = [100, 500, 1000, 5000];
const CAPACITIES = [40, 500];
const GAS_BUDGET = BigInt(process.env.GAS_BUDGET || 30_000_000);

async function setupCourse(applicants, capacity) {
  const reg = await ethers.deployContract("DrawHarness");
  await reg.addCourse("BENCH", "Benchmark", 5, capacity);
  const t = (await ethers.provider.getBlock("latest")).timestamp;
  await reg.setSchedule(t + 10, t + 20, t + 30);
  for (let i = 0; i < applicants; i += 500) await reg.fillPool(0, Math.min(500, applicants - i), i, { gasLimit: 100_000_000 });
  await ethers.provider.send("evm_setNextBlockTimestamp", [t + 30]);
  return reg;
}

async function main() {
  const rows = [];
  for (const capacity of CAPACITIES) {
    for (const n of SIZES) {
      if (capacity > n) continue;
      const reg = await setupCourse(n, capacity);
      const receipt = await (await reg.draw(0, n + capacity, { gasLimit: 1_000_000_000 })).wait();
      if (!(await reg.drawn(0))) throw new Error("draw did not finish in one call");
      rows.push({ applicants: n, seats: capacity, gas: receipt.gasUsed, perApplicant: receipt.gasUsed / BigInt(n) });
    }
  }

  console.log("\ndraw() in a single transaction");
  console.table(
    rows.map((r) => ({
      applicants: r.applicants,
      seats: r.seats,
      "gas used": r.gas.toLocaleString("en-US"),
      "gas / applicant": r.perApplicant.toLocaleString("en-US"),
    }))
  );
  // Cost grows mostly with seats (storage writes per winner), much less with applicants
  const gasOf = (n, k) => rows.find((r) => r.applicants === n && r.seats === k).gas;
  const perApplicant = (gasOf(5000, 40) - gasOf(1000, 40)) / 4000n;
  const perSeat = (gasOf(5000, 500) - gasOf(5000, 40)) / 460n;
  console.log(`Marginal cost: ~${perApplicant.toLocaleString("en-US")} gas per applicant, ~${perSeat.toLocaleString("en-US")} gas per seat.`);
  console.log(
    `With a ${GAS_BUDGET.toLocaleString("en-US")} gas budget, split the draw into batches with maxSteps so that ` +
      "each call stays under the budget (a step is one applicant scored or one winner seated)."
  );
  console.log("Monad charges the gas limit, not gas used: set gasLimit close to the measured value.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
