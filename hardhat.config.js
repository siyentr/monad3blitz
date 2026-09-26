require("@nomicfoundation/hardhat-toolbox");
const { vars } = require("hardhat/config");

// Deployer key: `pnpm exec hardhat vars set PRIVATE_KEY` (stored outside the repo) or PRIVATE_KEY env var
const key = process.env.PRIVATE_KEY || (vars.has("PRIVATE_KEY") ? vars.get("PRIVATE_KEY") : "");
const accounts = key ? [key] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  networks: {
    hardhat: { accounts: { count: 60 } },
    monadTestnet: {
      url: process.env.MONAD_TESTNET_RPC || "https://testnet-rpc.monad.xyz",
      chainId: 10143,
      accounts,
    },
    monadMainnet: {
      url: process.env.MONAD_RPC || "https://rpc.monad.xyz",
      chainId: 143,
      accounts,
    },
  },
  // Contract verification on the Monad explorer (via Sourcify)
  sourcify: {
    enabled: true,
    apiUrl: "https://sourcify-api-monad.blockvision.org",
    browserUrl: "https://testnet.monadexplorer.com",
  },
  etherscan: { enabled: false },
};
