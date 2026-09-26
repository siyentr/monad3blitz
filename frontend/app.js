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
  SetupLocked: "Applications have opened, so setup is locked.",
  WrongPhase: "That is not possible in the current phase.",
  NotStudent: "This wallet is not on the student list.",
  AlreadyStudent: "One of these addresses is already a student.",
  InvalidCourse: "That course does not exist.",
  AlreadyApplied: "You already applied to this course.",
  NotApplied: "You did not apply to this course.",
  AlreadyRevealed: "You already revealed for this course.",
  WrongSecret: "This secret does not match your application.",
  AlreadyDrawn: "The draw for this course is already finished.",
  NotDrawn: "The draw for this course has not finished yet.",
  NotRefundable: "Nothing to refund for this course.",
  InsufficientAKTS: "Not enough AKTS left for this course.",
  InvalidWindow: "Invalid schedule: apply must start in the future, then apply end, then reveal end.",
  InvalidParams: "Invalid input.",
  Soulbound: "AKTS cannot be transferred.",
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const state = {
  readContract: null,
  writeContract: null,
  account: null,
  admin: null,
  applyStart: 0,
  applyEnd: 0,
  revealEnd: 0,
  phase: 0,
  courses: [],
  myCourses: new Set(),
  my: {}, // courseId -> { applied, revealed, refunded }
  balance: null,
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
  const iface = state.readContract.interface;
  if (err?.revert?.name) return ERRORS[err.revert.name] || err.revert.name;
  const data = err?.data || err?.info?.error?.data?.data || err?.info?.error?.data || err?.error?.data;
  if (typeof data === "string" && data.startsWith("0x")) {
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
    const tx = await fn();
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

// ---------------------------------------------------------------- secrets
// The secret never leaves the browser until reveal. If it is lost, the application cannot be revealed,
// so it is stored locally and also offered as a backup file before the apply transaction is sent.

const DRAW_BATCH = 200; // applicants processed per draw() call, see `pnpm bench:draw`

const secretKey = (courseId) => `akts-secret:${D.chainId}:${D.address}:${state.account}:${courseId}`;

function loadSecret(courseId) {
  try {
    return localStorage.getItem(secretKey(courseId));
  } catch {
    return null;
  }
}

function saveSecret(courseId, secret) {
  try {
    localStorage.setItem(secretKey(courseId), secret);
  } catch {}
  const backup = { contract: D.address, chainId: D.chainId, student: state.account, courseId, secret };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }));
  a.download = `akts-secret-${state.courses[courseId].code}.json`;
  a.click();
}

function commitmentOf(courseId, student, secret) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "address", "bytes32"], [courseId, student, secret])
  );
}

// ---------------------------------------------------------------- wallet

async function switchChain() {
  const hex = "0x" + D.chainId.toString(16);
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e) {
    if (e.code === 4902 && NETWORKS[D.chainId]) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId: hex, ...NETWORKS[D.chainId] }],
      });
    } else throw e;
  }
}

async function connect() {
  if (!window.ethereum) return notify("No wallet found. Install MetaMask or another EVM wallet.", "err");
  try {
    await window.ethereum.request({ method: "eth_requestAccounts" });
    await switchChain();
    const provider = new ethers.BrowserProvider(window.ethereum);
    const signer = await provider.getSigner();
    state.account = (await signer.getAddress()).toLowerCase();
    state.writeContract = new ethers.Contract(D.address, D.abi, signer);
    $("connectBtn").textContent = `${state.account.slice(0, 6)}…${state.account.slice(-4)}`;
    await refresh();
  } catch (e) {
    notify(decodeError(e), "err");
  }
}

// ---------------------------------------------------------------- data

async function refresh() {
  const c = state.readContract;
  const [admin, applyStart, applyEnd, revealEnd, phase, courses, studentCount] = await Promise.all([
    c.admin(),
    c.applyStart(),
    c.applyEnd(),
    c.revealEnd(),
    c.phase(),
    c.getAllCourses(),
    c.studentCount(),
  ]);
  const drawn = await Promise.all(courses.map((_, id) => c.drawn(id)));
  state.admin = admin.toLowerCase();
  state.applyStart = Number(applyStart);
  state.applyEnd = Number(applyEnd);
  state.revealEnd = Number(revealEnd);
  state.phase = Number(phase);
  state.courses = courses.map((x, id) => ({
    id,
    code: x.code,
    title: x.title,
    akts: Number(x.akts),
    capacity: Number(x.capacity),
    enrolled: Number(x.enrolled),
    applicants: Number(x.applicants),
    drawn: drawn[id],
  }));
  $("studentCount").textContent = studentCount.toString();

  if (state.account) {
    const [bal, mine, isStudent] = await Promise.all([
      c.balanceOf(state.account),
      c.getStudentCourses(state.account),
      c.isStudent(state.account),
    ]);
    state.balance = Number(bal);
    state.isStudent = isStudent;
    state.myCourses = new Set(mine.map(Number));
    const me = state.account;
    const rows = await Promise.all(
      state.courses.map((x) => Promise.all([c.commitments(x.id, me), c.revealed(x.id, me), c.refunded(x.id, me)]))
    );
    state.my = Object.fromEntries(
      rows.map(([commitment, revealed, refunded], id) => [id, { applied: commitment !== ethers.ZeroHash, revealed, refunded }])
    );
  }
  render();
}

// ---------------------------------------------------------------- render

function render() {
  const badge = $("phaseBadge");
  badge.textContent = ["Setup", "Apply", "Reveal", "Draw"][state.phase];
  badge.className = `badge ${["setup", "open", "open", "closed"][state.phase]}`;

  $("myAkts").textContent = state.account ? (state.isStudent ? `${state.balance} / 30` : "not a student") : "—";

  renderCourses();
  renderMine();

  const isAdmin = state.account && state.account === state.admin;
  $("adminCard").classList.toggle("hidden", !isAdmin);
  $("adminLock").textContent = state.phase === 0 ? "setup is open" : "🔒 locked: applications have opened";
  document.querySelectorAll("#adminCard form button").forEach((b) => (b.disabled = state.phase !== 0));
}

// Button for one course, depending on the phase and what this wallet has done so far
function courseAction(c) {
  const my = state.my[c.id] || {};
  const busy = state.pending.has(c.id);
  const student = state.account && state.isStudent;
  const btn = (kind, action, label, dis = false) =>
    `<button class="btn ${kind}" data-action="${action}" data-id="${c.id}" ${dis || busy ? "disabled" : ""}>${busy ? "…" : label}</button>`;
  const done = (label) => `<span class="hint">${label}</span>`;

  if (state.phase === 1) {
    if (!student) return "";
    if (my.applied) return done("Applied ✓");
    const noAkts = state.balance !== null && state.balance < c.akts;
    return btn("primary", "apply", noAkts ? "No AKTS" : "Apply", noAkts);
  }
  if (state.phase === 2) {
    if (!my.applied) return "";
    return my.revealed ? done("Revealed ✓") : btn("primary", "reveal", "Reveal");
  }
  if (state.phase === 3) {
    if (!c.drawn) return state.account ? btn("", "draw", "Run draw") : done("Waiting for draw");
    if (state.myCourses.has(c.id)) return done("Seat won ✓");
    if (my.revealed && !my.refunded) return btn("", "refund", "Claim refund");
    if (my.applied && !my.revealed) return done("Not revealed");
    if (my.refunded) return done("Refunded");
  }
  return "";
}

function renderCourses() {
  const list = $("courseList");
  if (!state.courses.length) {
    list.innerHTML = `<p class="empty">No courses yet.</p>`;
    return;
  }
  list.innerHTML = state.courses
    .map((c) => {
      const mine = state.myCourses.has(c.id);
      // Before the draw show demand, after it show seats taken
      const count = c.drawn ? c.enrolled : c.applicants;
      const pct = Math.min(100, Math.round((count / c.capacity) * 100));
      const label = c.drawn ? `${c.enrolled} / ${c.capacity} seats` : `${c.applicants} applied · ${c.capacity} seats`;
      return `
        <div class="course ${mine ? "mine" : ""}">
          <span class="code">${esc(c.code)}</span>
          <span class="title">${esc(c.title)}</span>
          <span class="akts mono">${c.akts} AKTS</span>
          <div class="seats">
            <span class="mono">${label}</span>
            <div class="bar ${count >= c.capacity ? "full" : pct >= 75 ? "warn" : ""}"><span style="width:${pct}%"></span></div>
          </div>
          <span class="action">${courseAction(c)}</span>
        </div>`;
    })
    .join("");
}

function renderMine() {
  const box = $("myCourses");
  if (!state.account) return;
  if (!state.isStudent) {
    box.innerHTML = `<p class="empty">This wallet is not on the student list.</p>`;
    $("myTotal").textContent = "";
    return;
  }
  const mine = state.courses.filter((c) => state.myCourses.has(c.id));
  const total = mine.reduce((a, c) => a + c.akts, 0);
  $("myTotal").textContent = `${total} AKTS in won seats · ${state.balance} free`;
  box.innerHTML = mine.length
    ? `<ul>${mine.map((c) => `<li><b>${esc(c.code)}</b> ${esc(c.title)} <span class="hint">(${c.akts} AKTS)</span></li>`).join("")}</ul>`
    : `<p class="empty">Seats you win appear here after the draw.</p>`;
}

function tick() {
  const now = Date.now() / 1000;
  const label = $("countdownLabel");
  const cd = $("countdown");
  const steps = [
    [state.applyStart, "Applications open in"],
    [state.applyEnd, "Applications close in"],
    [state.revealEnd, "Reveal closes in"],
  ];
  const next = steps.find(([t]) => now < t);
  if (!state.applyStart) {
    label.textContent = "Schedule";
    cd.textContent = "not set";
  } else if (next) {
    label.textContent = next[1];
    cd.textContent = fmtDuration(next[0] - now);
  } else {
    label.textContent = "Draw open since";
    cd.textContent = new Date(state.revealEnd * 1000).toLocaleString();
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

async function apply(id) {
  const secret = ethers.hexlify(crypto.getRandomValues(new Uint8Array(32)));
  saveSecret(id, secret);
  const ok = confirm(
    "Your secret was downloaded as a backup file. Keep it: without it you cannot reveal and you lose the seat and the AKTS.\n\nSend the application?"
  );
  if (!ok) return;
  await send(`Apply ${state.courses[id].code}`, () =>
    state.writeContract.applyFor(id, commitmentOf(id, state.account, secret))
  );
}

async function reveal(id) {
  let secret = loadSecret(id);
  if (!secret) {
    secret = prompt("No secret found in this browser. Paste the \"secret\" value from your backup file:")?.trim();
    if (!secret) return;
  }
  if (!ethers.isHexString(secret, 32)) return notify("That is not a valid secret (0x + 64 hex characters).", "err");
  await send(`Reveal ${state.courses[id].code}`, () => state.writeContract.reveal(id, secret));
}

async function runDraw(id) {
  while (!(await state.readContract.drawn(id))) {
    const ok = await send(`Draw ${state.courses[id].code}`, () => state.writeContract.draw(id, DRAW_BATCH));
    if (!ok) return;
  }
}

$("courseList").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b || b.disabled) return;
  const id = Number(b.dataset.id);
  const actions = {
    apply: () => apply(id),
    reveal: () => reveal(id),
    draw: () => runDraw(id),
    refund: () => send(`Refund ${state.courses[id].code}`, () => state.writeContract.claimRefund(id)),
  };
  withPending(id, actions[b.dataset.action]);
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
  const ts = (id) => Math.floor(new Date($(id).value).getTime() / 1000);
  await send("Set schedule", () => state.writeContract.setSchedule(ts("wStart"), ts("wApplyEnd"), ts("wRevealEnd")));
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

if (window.ethereum) {
  window.ethereum.on?.("accountsChanged", () => state.account && connect());
  window.ethereum.on?.("chainChanged", () => location.reload());
}

// ---------------------------------------------------------------- boot

(async function boot() {
  if (!D) return;
  const rpc = NETWORKS[D.chainId]?.rpcUrls[0];
  state.readContract = new ethers.Contract(D.address, D.abi, new ethers.JsonRpcProvider(rpc, D.chainId, { staticNetwork: true }));
  $("contractInfo").textContent = `Contract ${D.address} · ${NETWORKS[D.chainId]?.chainName || D.network} (chain ${D.chainId})`;

  const now = new Date();
  $("wStart").value = toLocalInput(new Date(now.getTime() + 10 * 60000));
  $("wApplyEnd").value = toLocalInput(new Date(now.getTime() + 15 * 60000));
  $("wRevealEnd").value = toLocalInput(new Date(now.getTime() + 20 * 60000));

  try {
    await refresh();
  } catch (e) {
    notify(`Could not read the contract: ${decodeError(e)}`, "err");
  }
  setInterval(tick, 250);
  setInterval(() => refresh().catch(() => {}), 1000);
})();
