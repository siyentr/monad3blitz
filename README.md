# AKTS Course Registration on Monad

Fair university course selection. In Türkiye, course registration day means crashed university
servers, students who "know someone" and seats that vanish before the page loads. This project
moves registration onto Monad so the rules are public and identical for everyone.

## How it works

1. **Admin setup phase**: the admin uploads the student list (wallet addresses), creates courses
   (code, title, AKTS, capacity) and sets the registration window.
2. **Every student gets 30 AKTS**: a soulbound token. It cannot be transferred, sold or approved.
3. **Registration opens**: students enroll first come, first served. Enrolling spends the course's
   AKTS; dropping refunds them and frees the seat for the next student.
4. **Admin is locked out**: once the window opens, the admin can't add students, change
   capacities or move the window. No backdoors, no favourites.
5. **Registration closes**: the admin exports the final rosters as CSV.

### Why Monad

Registration day is a rush: thousands of students hit "enroll" in the same second. Monad's
high throughput and ~1s blocks process that rush on-chain. Every transaction is ordered and
checked against the same contract rules, and students see the seat counts update live.

## Rules enforced on-chain

| Rule | Error |
|---|---|
| Only listed students can enroll | `NotStudent` |
| Only during the window | `RegistrationClosed` |
| Course capacity | `CourseFull` |
| Max 30 AKTS per student | `InsufficientAKTS` |
| No double enrollment | `AlreadyEnrolled` |
| Admin can't change anything after start | `SetupLocked` |
| AKTS can't be transferred | `Soulbound` |

## Quick start (local)

```bash
pnpm install
pnpm test                # 18 tests, including a 50-student rush on a 10-seat course

pnpm chain               # terminal 1: local chain
pnpm deploy:local        # terminal 2: deploys + writes frontend/deployment.js
pnpm seed:local          # 10 students, 7 courses, window opens in 2 min
pnpm web                 # http://localhost:5173
```

In MetaMask, add the network `http://127.0.0.1:8545` (chain id 31337). Import account #0 (admin)
and accounts #1–#10 (students) using the private keys printed by `pnpm chain`.

## Deploy to Monad testnet

### 1. Create a deployer wallet and get testnet MON

Use a **fresh wallet just for deploying**. Never use a wallet that holds real funds. The deployer
becomes the contract **admin**.

- In MetaMask, create a new account and export its private key
  (Account details → Show private key).
- Get testnet MON from the faucet: https://faucet.monad.xyz. Deployment plus setup costs well
  under 1 MON.

### 2. Store the private key (outside the repo)

```bash
pnpm exec hardhat vars set PRIVATE_KEY
# paste the key when prompted (0x...)
```

Hardhat keeps this in your user config directory (`pnpm exec hardhat vars path`), so it never ends
up in git or your shell history. Alternatively: `PRIVATE_KEY=0x... pnpm deploy:testnet`.

### 3. Deploy

```bash
pnpm test               # make sure everything passes first
pnpm deploy:testnet
```

Output:

```
Deploying CourseRegistration to monadTestnet (chainId 10143) from 0xYourAdmin...
CourseRegistration deployed at 0xContractAddress...
Wrote frontend/deployment.js
```

`frontend/deployment.js` now points the frontend at the testnet contract.

### 4. (Optional) Verify the source code on the explorer

```bash
pnpm verify:testnet 0xContractAddress
```

Then open `https://testnet.monadexplorer.com/address/0xContractAddress` to see the verified code.
Anyone can check that the rules really are fair.

### 5. Run the frontend and set up registration

```bash
pnpm web                # http://localhost:5173
```

1. Connect with the **admin wallet**. The frontend adds and switches to Monad Testnet for you.
2. **Add students**: paste wallet addresses, one per line. Large lists are sent in chunks of 200.
3. **Add courses**: code, title, AKTS, capacity.
4. **Set the registration window.** ⚠️ After the start time, nothing can be changed, so double-check
   the students and courses first.
5. Students connect their wallets and enroll when the window opens. Each student needs a little
   testnet MON for gas, so point them to the faucet.
6. After it closes, click **Export CSV** to get the rosters.

### 6. Share it with others (optional)

`frontend/` is a plain static site, so any static host works (Vercel, Netlify, GitHub Pages).
`frontend/deployment.js` is gitignored by default. To host from git, remove it from `.gitignore`
and commit it after deploying. It only contains the public contract address and ABI.

### Troubleshooting

| Problem | Fix |
|---|---|
| `insufficient funds` | Get more MON from the faucet for the deployer wallet |
| `No deployer account` | `PRIVATE_KEY` not set, see step 2 |
| RPC timeouts | Use another RPC: `MONAD_TESTNET_RPC=https://... pnpm deploy:testnet` |
| Frontend shows old contract | Hard-refresh the page (deployment.js may be cached) |
| `SetupLocked` in admin panel | The window already started, so deploy a fresh contract for a new term |

## Project layout

```
contracts/CourseRegistration.sol   # registration logic + soulbound AKTS token
test/CourseRegistration.test.js    # hardhat tests
scripts/deploy.js                  # deploy + export ABI/address to frontend
scripts/seed-local.js              # demo data for local runs
frontend/                          # static dApp (ethers v6, no build step)
```

## Ideas for next steps

- Prerequisites (`CENG213` requires `CENG101`)
- Time-slot conflict checks between courses
- Class-year priority windows (e.g. seniors first)
- Waitlists that auto-enroll when someone drops
