const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) {
    throw new Error("No deployer account. Run `pnpm exec hardhat vars set PRIVATE_KEY` or set the PRIVATE_KEY env var.");
  }
  const { chainId } = await hre.ethers.provider.getNetwork();
  console.log(`Deploying CourseRegistration to ${hre.network.name} (chainId ${chainId}) from ${deployer.address}`);

  const reg = await hre.ethers.deployContract("CourseRegistration");
  await reg.waitForDeployment();
  const address = await reg.getAddress();
  console.log(`CourseRegistration deployed at ${address}`);

  // Hand the address + ABI to the frontend
  const artifact = await hre.artifacts.readArtifact("CourseRegistration");
  const out = path.join(__dirname, "..", "frontend", "deployment.js");
  const deployment = { address, chainId: Number(chainId), network: hre.network.name, abi: artifact.abi };
  fs.writeFileSync(out, `window.DEPLOYMENT = ${JSON.stringify(deployment, null, 2)};\n`);
  fs.writeFileSync(out + "on", JSON.stringify(deployment, null, 2));
  console.log(`Wrote ${path.relative(process.cwd(), out)}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
