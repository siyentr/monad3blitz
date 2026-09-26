// Local demo: registers hardhat accounts #1-#10 as students, adds sample courses,
// and opens registration 2 minutes from now for 1 hour.
const hre = require("hardhat");

const COURSES = [
  ["CENG101", "Introduction to Programming", 6, 3],
  ["MATH101", "Calculus I", 7, 5],
  ["PHYS101", "Physics I", 6, 5],
  ["CENG213", "Data Structures", 7, 2],
  ["ENG101", "Academic English", 4, 8],
  ["HIST101", "Atatürk's Principles and History of Revolution", 2, 10],
  ["CENG499", "Blockchain Systems (Elective)", 5, 2],
];

async function main() {
  const { address } = require("../frontend/deployment.json");
  const reg = await hre.ethers.getContractAt("CourseRegistration", address);
  const signers = await hre.ethers.getSigners();
  const students = signers.slice(1, 11).map((s) => s.address);

  await (await reg.addStudents(students)).wait();
  for (const c of COURSES) await (await reg.addCourse(...c)).wait();

  const now = (await hre.ethers.provider.getBlock("latest")).timestamp;
  const start = now + 120;
  await (await reg.setRegistrationWindow(start, start + 3600)).wait();

  console.log(`Seeded ${students.length} students, ${COURSES.length} courses.`);
  console.log(`Registration opens at ${new Date(start * 1000).toLocaleString()}`);
  console.log("Student accounts (import into MetaMask from `pnpm exec hardhat node` output): #1 - #10");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
