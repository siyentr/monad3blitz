/* global ethers */
const D = window.DEPLOYMENT;

const NETWORKS = {
  10143: {
    chainName: "Monad Testnet",
    rpcUrls: ["https://testnet-rpc.monad.xyz"],
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    blockExplorerUrls: ["https://testnet.monadexplorer.com"],
  },
  143: {
    chainName: "Monad",
    rpcUrls: ["https://rpc.monad.xyz"],
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  },
  31337: {
    chainName: "Hardhat Local",
    rpcUrls: ["http://127.0.0.1:8545"],
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  },
};

const ERRORS = {
  NotAdmin: "Only the admin can do that.",
  SetupLocked: "Registration has started, so setup is locked.",
  RegistrationClosed: "Registration is not open right now.",
  NotStudent: "This wallet is not on the student list.",
  AlreadyStudent: "One of these addresses is already a student.",
  InvalidCourse: "That course does not exist.",
  CourseFull: "Too late: the course is full.",
  AlreadyEnrolled: "You are already enrolled in this course.",
  NotEnrolled: "You are not enrolled in this course.",
  InsufficientAKTS: "Not enough AKTS left for this course.",
  InvalidWindow: "Invalid window: it must start in the future and end after it starts.",
  InvalidParams: "Invalid input.",
  Soulbound: "AKTS cannot be transferred.",
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Multicall3 (same address on most EVM chains). The public Monad RPC allows ~15 requests/sec and
// counts every call in a JSON-RPC batch, so a refresh is sent as one aggregated call instead.
const MULTICALL = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MULTICALL_ABI = [
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])",
];
const POLL_MS = 2000;

const state = {
  readContract: null,
  multicall: null, // null when the chain has no Multicall3 (e.g. local Hardhat)
  tab: "admin", // which page an admin who is also a student is looking at
  writeContract: null,
  account: null,
  admin: null,
  start: 0,
  end: 0,
  phase: 0,
  courses: [],
  myCourses: new Set(),
  balance: null,
  isStudent: false,
  pending: new Set(), // course ids with an in-flight tx
};

// ---------------------------------------------------------------- helpers

function notify(msg, kind = "ok") {
  const n = $("notice");
  n.textContent = msg;
  n.className = `notice ${kind}`;
  if (kind !== "pending") {
    clearTimeout(notify.t);
    notify.t = setTimeout(() => n.classList.add("hidden"), 6000);
  }
}

function decodeError(err) {
  const iface = state.readContract?.interface;
  if (err?.revert?.name) return ERRORS[err.revert.name] || err.revert.name;
  const data = err?.data || err?.info?.error?.data?.data || err?.info?.error?.data || err?.error?.data;
  if (iface && typeof data === "string" && data.startsWith("0x")) {
    try {
      const parsed = iface.parseError(data);
      if (parsed) return ERRORS[parsed.name] || parsed.name;
    } catch {}
  }
  if (err?.code === "ACTION_REJECTED") return "Transaction rejected in wallet.";
  return err?.shortMessage || err?.message || String(err);
}

async function send(label, fn) {
  try {
    notify(`${label}: confirm in your wallet…`, "pending");
    // Wallet popups often open behind the browser (Firefox) or wait for the extension to be opened
    const nudge = setTimeout(
      () => notify(`${label}: still waiting for your wallet. If no popup appeared, click the MetaMask icon in your toolbar.`, "pending"),
      8000
    );
    const tx = await fn().finally(() => clearTimeout(nudge));
    notify(`${label}: submitted, waiting for Monad…`, "pending");
    const t0 = performance.now();
    await tx.wait();
    notify(`${label}: confirmed in ${((performance.now() - t0) / 1000).toFixed(2)}s ✓`, "ok");
    await refresh();
    return true;
  } catch (e) {
    notify(`${label} failed: ${decodeError(e)}`, "err");
    return false;
  }
}

function fmtDuration(sec) {
  if (sec <= 0) return "0s";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return [d && `${d}d`, (d || h) && `${h}h`, (d || h || m) && `${m}m`, `${s}s`].filter(Boolean).join(" ");
}

function toLocalInput(date) {
  const off = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - off).toISOString().slice(0, 16);
}

// ---------------------------------------------------------------- wallet

// EIP-6963: discover injected wallets so MetaMask is used even when other wallet
// extensions (Phantom, Coinbase, Rabby, ...) are fighting over window.ethereum.
const wallets = [];
window.addEventListener("eip6963:announceProvider", (e) => wallets.push(e.detail));
window.dispatchEvent(new Event("eip6963:requestProvider"));

function getEthereum() {
  const mm = wallets.find((w) => w.info.rdns === "io.metamask");
  return (mm || wallets[0])?.provider || window.ethereum;
}

async function switchChain(eth) {
  const hex = "0x" + D.chainId.toString(16);
  if ((await eth.request({ method: "eth_chainId" })) === hex) return;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e) {
    const code = e.code ?? e.data?.originalError?.code;
    if (code === 4902 && NETWORKS[D.chainId]) {
      await eth.request({ method: "wallet_addEthereumChain", params: [{ chainId: hex, ...NETWORKS[D.chainId] }] });
    } else throw e;
  }
}

async function useAccount(eth) {
  const provider = new ethers.BrowserProvider(eth);
  const signer = await provider.getSigner();
  state.account = (await signer.getAddress()).toLowerCase();
  state.writeContract = new ethers.Contract(D.address, D.abi, signer);
  state.tab = "admin";
  $("accountAddr").textContent = `${state.account.slice(0, 6)}…${state.account.slice(-4)}`;
  $("deniedAddr").textContent = state.account;
  await refresh();
}

function disconnected() {
  state.account = null;
  state.writeContract = null;
  state.balance = null;
  state.isStudent = false;
  state.myCourses = new Set();
  $("connectBtn").textContent = "Connect wallet";
  render();
}

async function connect() {
  if (location.protocol === "file:") {
    return notify("Wallets can't connect to a file:// page. Run `pnpm web` and open http://localhost:5173", "err");
  }
  if (!D) return notify("No deployment found. Run `pnpm deploy:testnet` first.", "err");
  const eth = getEthereum();
  if (!eth) return notify("No wallet found. Install MetaMask (or another EVM wallet) and reload.", "err");

  const btn = $("connectBtn");
  btn.disabled = true;
  btn.textContent = "Connecting…";
  notify("Approve the connection in MetaMask. If no popup appears, click the MetaMask icon in your toolbar.", "pending");
  try {
    await eth.request({ method: "eth_requestAccounts" });
    notify(`Switch MetaMask to ${NETWORKS[D.chainId]?.chainName || "chain " + D.chainId}…`, "pending");
    await switchChain(eth);
    await useAccount(eth);
    notify("Wallet connected ✓", "ok");
  } catch (e) {
    console.error("connect failed", e);
    const code = e.code ?? e.error?.code;
    if (code === -32002) notify("MetaMask already has a request waiting. Click the MetaMask icon in your toolbar to approve it.", "err");
    else if (code === 4001 || e.code === "ACTION_REJECTED") notify("Connection rejected in MetaMask.", "err");
    else notify(`Could not connect: ${decodeError(e)}`, "err");
    if (!state.account) btn.textContent = "Connect wallet";
  } finally {
    btn.disabled = false;
  }
}

// Reconnect silently (no popup) if this site is already authorized in the wallet
async function autoConnect() {
  const eth = getEthereum();
  if (!eth || !D) return;
  try {
    const accounts = await eth.request({ method: "eth_accounts" });
    const chainId = await eth.request({ method: "eth_chainId" });
    if (accounts.length && Number(chainId) === D.chainId) await useAccount(eth);
  } catch (e) {
    console.error("autoConnect failed", e);
  }
}

function watchWallet() {
  const eth = getEthereum();
  if (!eth?.on) return;
  eth.on("accountsChanged", (accs) => (accs.length ? autoConnect() : disconnected()));
  eth.on("chainChanged", async (chainId) => {
    if (Number(chainId) === D.chainId) return autoConnect();
    if (state.account) {
      disconnected();
      notify("Wrong network in MetaMask. Click Connect wallet to switch back.", "err");
    }
  });
}

// ---------------------------------------------------------------- data

// Run several view calls on the registration contract, as [fnName, ...args], in one RPC request
async function readMany(calls) {
  const c = state.readContract;
  if (!state.multicall) return Promise.all(calls.map(([fn, ...args]) => c[fn](...args)));
  const iface = c.interface;
  const res = await state.multicall.aggregate3.staticCall(
    calls.map(([fn, ...args]) => ({ target: D.address, allowFailure: false, callData: iface.encodeFunctionData(fn, args) }))
  );
  return res.map(([, data], i) => {
    const out = iface.decodeFunctionResult(calls[i][0], data);
    return out.length === 1 ? out[0] : out;
  });
}

async function refresh() {
  const me = state.account;
  const accountCalls = me ? [["balanceOf", me], ["getStudentCourses", me], ["isStudent", me]] : [];
  const [admin, start, end, phase, courses, studentCount, ...acct] = await readMany([
    ["admin"],
    ["registrationStart"],
    ["registrationEnd"],
    ["phase"],
    ["getAllCourses"],
    ["studentCount"],
    ...accountCalls,
  ]);
  // The wallet changed while this refresh was in flight; its results belong to the old account
  if (me !== state.account) return;
  state.admin = admin.toLowerCase();
  state.start = Number(start);
  state.end = Number(end);
  state.phase = Number(phase);
  state.courses = courses.map((x, id) => ({
    id,
    code: x.code,
    title: x.title,
    akts: Number(x.akts),
    capacity: Number(x.capacity),
    enrolled: Number(x.enrolled),
  }));
  $("studentCount").textContent = studentCount.toString();

  if (me) {
    const [bal, mine, isStudent] = acct;
    state.balance = Number(bal);
    state.isStudent = isStudent;
    state.myCourses = new Set(mine.map(Number));
  }
  render();
}

// ---------------------------------------------------------------- render

// Which page to show: login, denied (not a student), student or admin
function currentView() {
  if (!state.account) return "login";
  const isAdmin = state.account === state.admin;
  if (isAdmin && (!state.isStudent || state.tab === "admin")) return "admin";
  return state.isStudent ? "student" : "denied";
}

function render() {
  const view = currentView();
  document.body.dataset.view = view;
  const both = state.account && state.account === state.admin && state.isStudent;
  $("tabs").classList.toggle("hidden", !both);
  document.querySelectorAll("#tabs .tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === view));

  const badge = $("phaseBadge");
  badge.textContent = ["Setup", "Open", "Closed"][state.phase];
  badge.className = `badge ${["setup", "open", "closed"][state.phase]}`;

  $("myAkts").textContent = state.account ? (state.isStudent ? `${state.balance} / 30` : "not a student") : "—";

  renderCourses();
  renderMine();

  $("adminLock").textContent = state.phase === 0 ? "setup is open" : "🔒 locked: registration has started";
  document.querySelectorAll("#adminCard form button").forEach((b) => (b.disabled = state.phase !== 0));
}

function renderCourses() {
  const list = $("courseList");
  if (!state.courses.length) {
    list.innerHTML = `<p class="empty">No courses yet.</p>`;
    return;
  }
  const canAct = currentView() === "student" && state.phase === 1;
  list.innerHTML = state.courses
    .map((c) => {
      const pct = Math.round((c.enrolled / c.capacity) * 100);
      const full = c.enrolled >= c.capacity;
      const mine = state.myCourses.has(c.id);
      const busy = state.pending.has(c.id);
      let btn;
      if (mine) {
        btn = `<button class="btn danger" data-drop="${c.id}" ${!canAct || busy ? "disabled" : ""}>${busy ? "…" : "Drop"}</button>`;
      } else {
        const noAkts = state.balance !== null && state.balance < c.akts;
        const dis = !canAct || full || noAkts || busy;
        const label = busy ? "…" : full ? "Full" : noAkts ? "No AKTS" : "Enroll";
        btn = `<button class="btn primary" data-enroll="${c.id}" ${dis ? "disabled" : ""}>${label}</button>`;
      }
      return `
        <div class="course ${mine ? "mine" : ""}">
          <span class="code">${esc(c.code)}</span>
          <span class="title">${esc(c.title)}</span>
          <span class="akts mono">${c.akts} AKTS</span>
          <div class="seats">
            <span class="mono">${c.enrolled} / ${c.capacity} seats</span>
            <div class="bar ${full ? "full" : pct >= 75 ? "warn" : ""}"><span style="width:${pct}%"></span></div>
          </div>
          <span class="action">${btn}</span>
        </div>`;
    })
    .join("");
}

function renderMine() {
  const box = $("myCourses");
  if (!state.account) {
    box.innerHTML = `<p class="empty">Connect your wallet to see your enrollments.</p>`;
    $("myTotal").textContent = "";
    return;
  }
  if (!state.isStudent) {
    box.innerHTML = `<p class="empty">This wallet is not on the student list.</p>`;
    $("myTotal").textContent = "";
    return;
  }
  const mine = state.courses.filter((c) => state.myCourses.has(c.id));
  const total = mine.reduce((a, c) => a + c.akts, 0);
  $("myTotal").textContent = `${total} AKTS used · ${state.balance} left`;
  box.innerHTML = mine.length
    ? `<ul>${mine.map((c) => `<li><b>${esc(c.code)}</b> ${esc(c.title)} <span class="hint">(${c.akts} AKTS)</span></li>`).join("")}</ul>`
    : `<p class="empty">No courses selected yet.</p>`;
}

function tick() {
  const now = Date.now() / 1000;
  const label = $("countdownLabel");
  const cd = $("countdown");
  if (!state.start) {
    label.textContent = "Window";
    cd.textContent = "not set";
  } else if (now < state.start) {
    label.textContent = "Opens in";
    cd.textContent = fmtDuration(state.start - now);
  } else if (now < state.end) {
    label.textContent = "Closes in";
    cd.textContent = fmtDuration(state.end - now);
  } else {
    label.textContent = "Closed";
    cd.textContent = new Date(state.end * 1000).toLocaleString();
  }
}

// ---------------------------------------------------------------- actions

async function withPending(id, fn) {
  state.pending.add(id);
  renderCourses();
  await fn();
  state.pending.delete(id);
  renderCourses();
}

$("courseList").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b || b.disabled) return;
  if (b.dataset.enroll !== undefined) {
    const id = Number(b.dataset.enroll);
    withPending(id, () => send(`Enroll ${state.courses[id].code}`, () => state.writeContract.enroll(id)));
  } else if (b.dataset.drop !== undefined) {
    const id = Number(b.dataset.drop);
    withPending(id, () => send(`Drop ${state.courses[id].code}`, () => state.writeContract.drop(id)));
  }
});

$("studentsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = $("studentsInput").value.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  const bad = raw.filter((a) => !ethers.isAddress(a));
  if (bad.length) return notify(`Invalid address: ${bad[0]}`, "err");
  const addrs = [...new Set(raw.map((a) => ethers.getAddress(a)))];
  if (!addrs.length) return;
  // Chunk to stay well within block gas limits
  for (let i = 0; i < addrs.length; i += 200) {
    const chunk = addrs.slice(i, i + 200);
    const ok = await send(`Add ${chunk.length} students`, () => state.writeContract.addStudents(chunk));
    if (!ok) return;
  }
  $("studentsInput").value = "";
});

$("courseForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const ok = await send(`Add ${$("cCode").value}`, () =>
    state.writeContract.addCourse($("cCode").value.trim(), $("cTitle").value.trim(), Number($("cAkts").value), Number($("cCap").value))
  );
  if (ok) {
    $("cCode").value = "";
    $("cTitle").value = "";
  }
});

$("windowForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const start = Math.floor(new Date($("wStart").value).getTime() / 1000);
  const end = Math.floor(new Date($("wEnd").value).getTime() / 1000);
  await send("Set window", () => state.writeContract.setRegistrationWindow(start, end));
});

$("exportBtn").addEventListener("click", async () => {
  const rows = [["course_code", "course_title", "akts", "student_address"]];
  for (const c of state.courses) {
    const roster = await state.readContract.getRoster(c.id);
    for (const a of roster) rows.push([c.code, c.title, c.akts, a]);
  }
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = "rosters.csv";
  a.click();
});

$("connectBtn").addEventListener("click", connect);

$("tabs").addEventListener("click", (e) => {
  const t = e.target.closest(".tab");
  if (!t) return;
  state.tab = t.dataset.tab;
  render();
});

async function logout() {
  // Drop the site's wallet permission too, otherwise autoConnect logs straight back in on reload
  try {
    await getEthereum()?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] });
  } catch {}
  disconnected();
}

$("logoutBtn").addEventListener("click", logout);

// Let MetaMask show its account picker again, then re-check the chosen wallet
$("switchBtn").addEventListener("click", async () => {
  const eth = getEthereum();
  try {
    await eth.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] });
    await useAccount(eth);
  } catch (e) {
    if (e.code !== 4001) notify(`Could not switch wallet: ${decodeError(e)}`, "err");
  }
});

// ---------------------------------------------------------------- boot

(async function boot() {
  if (!D) return;
  const rpc = NETWORKS[D.chainId]?.rpcUrls[0];
  const provider = new ethers.JsonRpcProvider(rpc, D.chainId, { staticNetwork: true });
  state.readContract = new ethers.Contract(D.address, D.abi, provider);
  try {
    if ((await provider.getCode(MULTICALL)) !== "0x") state.multicall = new ethers.Contract(MULTICALL, MULTICALL_ABI, provider);
  } catch {}
  $("contractInfo").textContent = `Contract ${D.address} · ${NETWORKS[D.chainId]?.chainName || D.network} (chain ${D.chainId})`;

  const now = new Date();
  $("wStart").value = toLocalInput(new Date(now.getTime() + 10 * 60000));
  $("wEnd").value = toLocalInput(new Date(now.getTime() + 70 * 60000));

  try {
    await refresh();
  } catch (e) {
    console.error(e);
    notify(`Could not read the contract: ${decodeError(e)}`, "err");
  }
  // give EIP-6963 wallets a moment to announce themselves
  setTimeout(() => {
    watchWallet();
    autoConnect();
  }, 300);
  setInterval(tick, 250);
  // Poll only while logged in, and never start a poll while the previous one is still running
  let polling = false;
  setInterval(async () => {
    if (polling || !state.account) return;
    polling = true;
    await refresh().catch(() => {});
    polling = false;
  }, POLL_MS);
})();
