# AKTS Course Registration on Monad

Fair university course selection. In Türkiye, course registration day means crashed university
servers, students who "know someone" and seats that vanish before the page loads. This project
moves registration onto Monad so the rules are public and identical for everyone.

### Why not first come, first served?

Putting "first come, first served" on a blockchain does not make it fair. Inside a block, the block
producer decides the order of transactions, so a higher priority fee or a bot still gets in first.
The winner is decided by network speed, hardware or money. A lottery on a university server has the
opposite problem: students cannot see how it was drawn, so they don't trust it.

This project removes the race and makes the lottery public: applications are collected over a fixed
window, and seats are drawn on-chain from randomness that every applicant contributes to.
Anyone can re-run the draw on their own computer and get the same result.

## How it works

1. **Setup (admin)**: the admin uploads the student list (anonymous wallet addresses), creates
   courses (code, title, AKTS, capacity) and sets the schedule: apply window, reveal window.
2. **Every student gets 30 AKTS**: a soulbound token. It cannot be transferred, sold or approved.
3. **Apply (commit)**: the browser generates a random secret and the student submits only its
   fingerprint, `keccak256(courseId, student, secret)`. Applying reserves the course's AKTS, so a
   student can apply to at most 30 AKTS worth of courses. Nobody hurries: the order does not matter.
4. **Reveal**: after the apply window, each student reveals their secret. The contract checks it
   against the fingerprint and XORs it into the course seed. An application that is not revealed is
   void and its AKTS are not refunded.
5. **Draw**: anyone can call `draw()`. Every revealed applicant gets a score
   `keccak256(seed, student)` and the `capacity` lowest scores win. The draw runs in batches, so
   thousands of applicants fit.
6. **Refund**: applicants who did not win claim their reserved AKTS back.
7. **Verify**: `pnpm verify:draw <contract> <courseId>` rebuilds the draw from public chain data and
   prints `MATCH` or `MISMATCH`. "There was favouritism" is answered with math.

The admin is locked out as soon as applications open: no new students, no capacity changes, no
schedule changes.

### Why the result cannot be steered

- **Nobody knows the seed in advance.** It depends on every revealed secret, and secrets are hidden
  until the apply window closes. One honest applicant is enough to make it unpredictable.
- **Transaction order does not matter.** The seed is an XOR (order-independent) and winners are
  chosen by score, not by position in a list, so a block producer who reorders reveals changes nothing.
- **Secrets cannot be copied.** The fingerprint includes the student's address, so revealing someone
  else's secret fails.

### Why Monad

- **Load spike**: thousands of students apply in the same minutes. Each application is a separate
  transaction, which on Ethereum is slow (12s blocks) and expensive.
- **Heavy computation**: the draw scores every applicant on-chain. `pnpm bench:draw` measures how many
  applicants fit in one transaction:

| applicants | seats | gas for one `draw()` call |
|---:|---:|---:|
| 1,000 | 40 | 8.5M |
| 5,000 | 40 | 23.0M |
| 5,000 | 500 | 86.6M |

  Cost grows mostly with seats (~138k gas per seat) and only a little with applicants (~3.6k gas
  each). Monad charges the gas **limit**, not the gas used, so measure first and batch with
  `maxSteps` instead of sending a huge limit.

## Known weaknesses (read before the pitch)

| Risk | What we do | Issue |
|---|---|---|
| **Last revealer can withhold** their secret after computing the outcome | Withholding voids their own application and burns the reserved AKTS. It still gives one bit of influence; VRF or threshold randomness would remove it. | #7 |
| **Lost secret** means no reveal | Secret is stored in the browser and downloaded as a backup file before applying | #10 |
| **Students have no MON** for gas | Out of scope: students use the faucet. A university relayer could pay gas but could also delay applications, so a direct path must always remain. | #11 |
| **Rosters are public** | Only anonymous wallet addresses on-chain, never names or student numbers. The university keeps the mapping off-chain. | #12 |
| **Public RPC rate limits** in stress tests | Use several RPC providers | #9 |
| **The university must accept the result** | Start with a low-stakes pilot: club events, lab time slots, dorm rooms | #13 |

## Quick start (local)

```bash
pnpm install
pnpm test                # 50 students apply for 10 seats, draw in batches, refunds
pnpm bench:draw          # gas for 100 to 5,000 applicants

pnpm chain               # terminal 1: local chain
pnpm deploy:local        # terminal 2: deploys + writes frontend/deployment.js
pnpm seed:local          # 10 students, 7 courses, applications open in 2 min (5 min apply, 5 min reveal)
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

### Load test (optional)

`scripts/load-test.js` deploys a fresh contract, creates N wallets, funds each for one apply and one
reveal, fires all applications at once, then reveals and draws. Spread student transactions over
several RPCs, since public RPCs are rate limited:

```bash
N=300 pnpm load:local                                          # against `pnpm chain`
N=5000 RPCS=https://rpc-a,https://rpc-b pnpm load:testnet      # costs roughly N x 0.0004 MON
```

### 5. Run the frontend and set up registration

```bash
pnpm web                # http://localhost:5173
```

1. Connect with the **admin wallet**. The frontend adds and switches to Monad Testnet for you.
2. **Add students**: paste wallet addresses, one per line. Large lists are sent in chunks of 200.
3. **Add courses**: code, title, AKTS, capacity.
4. **Set the schedule** (applications open, applications close, reveal closes). ⚠️ Once
   applications open, nothing can be changed, so double-check the students and courses first.
5. Students connect their wallets, **apply** (and keep the downloaded secret file), then **reveal**
   in the reveal window. Each student needs a little testnet MON for gas, so point them to the faucet.
6. After the reveal window anyone can click **Run draw**. Losers click **Claim refund**.
7. Click **Export CSV** to get the rosters, and share `pnpm verify:draw <contract> <courseId>`.

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
| `SetupLocked` in admin panel | Applications already opened, so deploy a fresh contract for a new term |

## Project layout

```
contracts/CourseRegistration.sol   # commit-reveal lottery + soulbound AKTS token
contracts/test/DrawHarness.sol     # benchmark-only helper that fills a large reveal pool
test/CourseRegistration.test.js    # hardhat tests
scripts/deploy.js                  # deploy + export ABI/address to frontend
scripts/seed-local.js              # demo data for local runs
scripts/verify-draw.js             # recompute a draw from chain data (MATCH / MISMATCH)
scripts/bench-draw.js              # draw gas benchmark
scripts/lib/draw.js                # off-chain draw logic shared by tests and verify script
frontend/                          # static dApp (ethers v6, no build step)
```

## Ideas for next steps

- Prerequisites (`CENG213` requires `CENG101`)
- Time-slot conflict checks between courses
- Class-year priority windows (e.g. seniors first)
- A second round for seats left empty and AKTS refunded after the draw
- VRF or threshold randomness to remove the last-revealer bit (#7)
