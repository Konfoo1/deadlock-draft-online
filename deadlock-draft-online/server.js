const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

// ═══════════════════════════════════════════════════════════
//  HEROES
// ═══════════════════════════════════════════════════════════
const HEROES = [
  "Abrams","Apollo","Bebop","Billy","Calico","Celeste","Drifter","Doorman","Dynamo",
  "Graves","Grey Talon","Haze","Holliday","Infernus",
  "Ivy","Kelvin","Lady Geist","Lash","McGinnis","Mina",
  "Mirage","Mo & Krill","Paradox","Pocket","Rem","Seven",
  "Shiv","Sinclair","Silver","Venator","Vindicta","Viscous",
  "Vyper","Warden","Wraith","Yamato",
].sort();

// ═══════════════════════════════════════════════════════════
//  LOBBY STORAGE
// ═══════════════════════════════════════════════════════════
const lobbies = new Map();

function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return lobbies.has(code) ? genCode() : code;
}

// ═══════════════════════════════════════════════════════════
//  BAN COUNT FORMULA
//  Always leaves 2 remaining → Phase 3 pick 1 of 2
//  6 heroes → 4 bans, 5 → 3, 4 → 2, 3 → 1, ≤2 → 0 (skip)
// ═══════════════════════════════════════════════════════════
function banCount(poolSize) {
  return Math.max(0, poolSize - 2);
}

// ═══════════════════════════════════════════════════════════
//  STATE FOR CLIENT
//  Each captain only sees their own secret picks until reveal
// ═══════════════════════════════════════════════════════════
function stateFor(lobby, sid) {
  const myTeam = lobby.captains[0]?.id === sid ? 0 : lobby.captains[1]?.id === sid ? 1 : -1;
  const oppTeam = myTeam === 0 ? 1 : 0;

  const s = {
    code: lobby.code,
    phase: lobby.phase,
    timerDuration: lobby.timerDuration,
    timerEnd: lobby.timerEnd,
    teamNames: lobby.teamNames,
    myTeam,
    isHost: sid === lobby.hostId,
    captains: lobby.captains.map((c) => c ? { name: c.name, id: c.id } : null),
    bans: [...lobby.bans],
    heroes: HEROES,
  };

  // Phase 1: see own picks only
  if (lobby.phase === "phase1") {
    s.myPicks = lobby.picks[myTeam] || [];
    s.myLocked = lobby.locked[myTeam];
    s.oppLocked = lobby.locked[oppTeam];
  }

  // Phase 1 reveal onward: see everything
  if (["phase1_reveal","phase2","phase2_reveal","phase3","complete"].includes(lobby.phase)) {
    s.myPool = [...(lobby.pools[myTeam] || [])];
    s.oppPool = [...(lobby.pools[oppTeam] || [])];
    s.overlaps = lobby.overlaps || [];
    s.allPicks = [[...(lobby.origPicks[0] || [])], [...(lobby.origPicks[1] || [])]];
  }

  // Phase 2: ban target + own selections
  if (lobby.phase === "phase2") {
    s.banTarget = banCount(lobby.pools[oppTeam]?.length || 0);
    s.myBans = lobby.phase2Bans[myTeam] || [];
    s.myLocked = lobby.locked[myTeam];
    s.oppLocked = lobby.locked[oppTeam];
  }

  // Phase 2 reveal
  if (lobby.phase === "phase2_reveal" || lobby.phase === "phase3" || lobby.phase === "complete") {
    s.phase2Banned = lobby.phase2Banned || [[], []];
  }

  // Phase 3: pick from own remaining pool
  if (lobby.phase === "phase3") {
    s.myChoice = lobby.phase3Choice[myTeam];
    s.myLocked = lobby.locked[myTeam];
    s.oppLocked = lobby.locked[oppTeam];
    s.skipPhase3 = (lobby.pools[myTeam]?.length || 0) <= 1;
  }

  // Complete
  if (lobby.phase === "complete") {
    s.champions = lobby.champions || [null, null];
  }

  return s;
}

function broadcast(lobby) {
  for (const cap of lobby.captains) {
    if (cap) io.to(cap.id).emit("state", stateFor(lobby, cap.id));
  }
}

// ═══════════════════════════════════════════════════════════
//  TIMER
// ═══════════════════════════════════════════════════════════
function startTimer(lobby, onExpire) {
  clearTimer(lobby);
  lobby.timerEnd = Date.now() + lobby.timerDuration * 1000;
  lobby.timerRef = setTimeout(() => {
    lobby.timerRef = null;
    lobby.timerEnd = null;
    onExpire();
  }, lobby.timerDuration * 1000);
}

function clearTimer(lobby) {
  if (lobby.timerRef) { clearTimeout(lobby.timerRef); lobby.timerRef = null; }
  lobby.timerEnd = null;
}

// ═══════════════════════════════════════════════════════════
//  PHASE TRANSITIONS
// ═══════════════════════════════════════════════════════════

function startPhase1(lobby) {
  lobby.phase = "phase1";
  lobby.picks = [[], []];
  lobby.pools = [[], []];
  lobby.origPicks = [[], []];
  lobby.bans = new Set();
  lobby.overlaps = [];
  lobby.phase2Bans = [[], []];
  lobby.phase2Banned = [[], []];
  lobby.phase3Choice = [null, null];
  lobby.champions = [null, null];
  lobby.locked = [false, false];
  startTimer(lobby, () => finishPhase1(lobby));
  broadcast(lobby);
}

function finishPhase1(lobby) {
  clearTimer(lobby);

  // Auto-random-fill for any captain who didn't pick 6
  for (let t = 0; t < 2; t++) {
    const have = new Set(lobby.picks[t]);
    const allPicked = new Set([...lobby.picks[0], ...lobby.picks[1]]);
    while (have.size < 6) {
      const avail = HEROES.filter((h) => !have.has(h) && !allPicked.has(h));
      if (!avail.length) break;
      const pick = avail[Math.floor(Math.random() * avail.length)];
      have.add(pick);
      allPicked.add(pick);
    }
    lobby.picks[t] = [...have];
    lobby.origPicks[t] = [...lobby.picks[t]];
  }

  // Find overlaps → banned
  const set0 = new Set(lobby.picks[0]);
  lobby.overlaps = lobby.picks[1].filter((h) => set0.has(h));
  for (const h of lobby.overlaps) lobby.bans.add(h);

  // Build pools
  for (let t = 0; t < 2; t++) {
    lobby.pools[t] = lobby.picks[t].filter((h) => !lobby.bans.has(h));
  }

  lobby.locked = [false, false];
  lobby.phase = "phase1_reveal";
  broadcast(lobby);
}

function startPhase2(lobby) {
  // Check if Phase 2 is needed (both pools > 2)
  const skip0 = lobby.pools[0].length <= 2;
  const skip1 = lobby.pools[1].length <= 2;

  if (skip0 && skip1) {
    // Skip directly to Phase 3
    lobby.phase2Banned = [[], []];
    startPhase3(lobby);
    return;
  }

  lobby.phase = "phase2";
  lobby.phase2Bans = [[], []];
  lobby.locked = [false, false];

  // Auto-lock captains whose opponent pool is ≤ 2 (no banning needed)
  if (banCount(lobby.pools[1].length) === 0) lobby.locked[0] = true;
  if (banCount(lobby.pools[0].length) === 0) lobby.locked[1] = true;

  startTimer(lobby, () => finishPhase2(lobby));
  broadcast(lobby);
}

function finishPhase2(lobby) {
  clearTimer(lobby);

  // Auto-fill bans for captains who didn't lock in
  for (let t = 0; t < 2; t++) {
    const oppT = 1 - t;
    const need = banCount(lobby.pools[oppT].length);
    if (lobby.phase2Bans[t].length < need) {
      const pool = lobby.pools[oppT].filter((h) => !lobby.phase2Bans[t].includes(h));
      const shuffled = pool.sort(() => Math.random() - 0.5);
      while (lobby.phase2Bans[t].length < need && shuffled.length) {
        lobby.phase2Bans[t].push(shuffled.pop());
      }
    }
  }

  // Apply bans: captain T's bans remove from opponent (1-T)'s pool
  for (let t = 0; t < 2; t++) {
    const oppT = 1 - t;
    lobby.phase2Banned[t] = [...lobby.phase2Bans[t]];
    for (const h of lobby.phase2Bans[t]) {
      lobby.pools[oppT] = lobby.pools[oppT].filter((x) => x !== h);
      lobby.bans.add(h);
    }
  }

  lobby.locked = [false, false];
  lobby.phase = "phase2_reveal";
  broadcast(lobby);
}

function startPhase3(lobby) {
  lobby.phase = "phase3";
  lobby.phase3Choice = [null, null];
  lobby.locked = [false, false];

  // Auto-assign if a pool has exactly 1 hero (forced)
  for (let t = 0; t < 2; t++) {
    if (lobby.pools[t].length <= 1) {
      lobby.phase3Choice[t] = lobby.pools[t][0] || null;
      lobby.locked[t] = true;
    }
  }

  // If both are forced, skip straight to complete
  if (lobby.locked[0] && lobby.locked[1]) {
    lobby.champions = [...lobby.phase3Choice];
    lobby.phase = "complete";
    broadcast(lobby);
    return;
  }

  startTimer(lobby, () => finishPhase3(lobby));
  broadcast(lobby);
}

function finishPhase3(lobby) {
  clearTimer(lobby);

  // Auto-random-pick for captains who didn't choose
  for (let t = 0; t < 2; t++) {
    if (!lobby.phase3Choice[t] && lobby.pools[t].length > 0) {
      lobby.phase3Choice[t] = lobby.pools[t][Math.floor(Math.random() * lobby.pools[t].length)];
    }
  }

  lobby.champions = [...lobby.phase3Choice];
  lobby.phase = "complete";
  broadcast(lobby);
}

function checkBothLocked(lobby) {
  if (lobby.locked[0] && lobby.locked[1]) {
    if (lobby.phase === "phase1") finishPhase1(lobby);
    else if (lobby.phase === "phase2") finishPhase2(lobby);
    else if (lobby.phase === "phase3") finishPhase3(lobby);
  }
}

// ═══════════════════════════════════════════════════════════
//  SOCKET HANDLERS
// ═══════════════════════════════════════════════════════════
io.on("connection", (socket) => {
  let myLobby = null;

  socket.on("createLobby", ({ name, timerDuration }) => {
    const code = genCode();
    const lobby = {
      code,
      hostId: socket.id,
      timerDuration: timerDuration || 60,
      phase: "waiting",
      teamNames: ["Team Amber", "Team Jade"],
      captains: [{ id: socket.id, name }, null],
      picks: [[], []], pools: [[], []], origPicks: [[], []],
      bans: new Set(), overlaps: [],
      phase2Bans: [[], []], phase2Banned: [[], []],
      phase3Choice: [null, null],
      champions: [null, null],
      locked: [false, false],
      timerRef: null, timerEnd: null,
    };
    lobbies.set(code, lobby);
    myLobby = code;
    socket.join(code);
    socket.emit("lobbyCreated", { code });
    broadcast(lobby);
  });

  socket.on("joinLobby", ({ code, name }) => {
    const c = code.toUpperCase();
    const lobby = lobbies.get(c);
    if (!lobby) return socket.emit("err", "Lobby not found.");
    if (lobby.phase !== "waiting") return socket.emit("err", "Draft already in progress.");
    if (lobby.captains[0]?.id === socket.id || lobby.captains[1]?.id === socket.id) {
      // Already in lobby
      broadcast(lobby);
      return;
    }
    if (lobby.captains[1]) return socket.emit("err", "Lobby is full (2 captains max).");

    lobby.captains[1] = { id: socket.id, name };
    myLobby = c;
    socket.join(c);
    socket.emit("joined", { code: c });
    broadcast(lobby);
  });

  socket.on("switchTeam", () => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby || lobby.phase !== "waiting") return;
    // Swap captains
    [lobby.captains[0], lobby.captains[1]] = [lobby.captains[1], lobby.captains[0]];
    if (lobby.captains[0]) lobby.hostId = lobby.captains[0].id;
    broadcast(lobby);
  });

  socket.on("updateTimer", ({ duration }) => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby || socket.id !== lobby.hostId || lobby.phase !== "waiting") return;
    lobby.timerDuration = Math.min(300, Math.max(10, duration));
    broadcast(lobby);
  });

  socket.on("startDraft", () => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby || socket.id !== lobby.hostId) return;
    if (!lobby.captains[0] || !lobby.captains[1]) {
      return socket.emit("err", "Need 2 captains to start.");
    }
    startPhase1(lobby);
  });

  // Phase 1: captain picks heroes (array of up to 6)
  socket.on("lockPicks", ({ heroes }) => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby || lobby.phase !== "phase1") return;
    const t = lobby.captains[0]?.id === socket.id ? 0 : lobby.captains[1]?.id === socket.id ? 1 : -1;
    if (t === -1 || lobby.locked[t]) return;

    // Validate: max 6, no duplicates, all valid heroes
    const valid = [...new Set(heroes)].filter((h) => HEROES.includes(h)).slice(0, 6);
    lobby.picks[t] = valid;
    lobby.locked[t] = true;
    broadcast(lobby);
    checkBothLocked(lobby);
  });

  // Phase 2: captain locks ban selections
  socket.on("lockBans", ({ heroes }) => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby || lobby.phase !== "phase2") return;
    const t = lobby.captains[0]?.id === socket.id ? 0 : lobby.captains[1]?.id === socket.id ? 1 : -1;
    if (t === -1 || lobby.locked[t]) return;

    const oppT = 1 - t;
    const need = banCount(lobby.pools[oppT].length);
    const valid = [...new Set(heroes)].filter((h) => lobby.pools[oppT].includes(h)).slice(0, need);
    if (valid.length !== need) return; // must ban exactly the right count

    lobby.phase2Bans[t] = valid;
    lobby.locked[t] = true;
    broadcast(lobby);
    checkBothLocked(lobby);
  });

  // Phase 3: captain picks final hero
  socket.on("lockFinal", ({ hero }) => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby || lobby.phase !== "phase3") return;
    const t = lobby.captains[0]?.id === socket.id ? 0 : lobby.captains[1]?.id === socket.id ? 1 : -1;
    if (t === -1 || lobby.locked[t]) return;
    if (!lobby.pools[t].includes(hero)) return;

    lobby.phase3Choice[t] = hero;
    lobby.locked[t] = true;
    broadcast(lobby);
    checkBothLocked(lobby);
  });

  socket.on("advancePhase", () => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby || socket.id !== lobby.hostId) return;
    if (lobby.phase === "phase1_reveal") startPhase2(lobby);
    else if (lobby.phase === "phase2_reveal") startPhase3(lobby);
  });

  socket.on("resetDraft", () => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby || socket.id !== lobby.hostId) return;
    clearTimer(lobby);
    lobby.phase = "waiting";
    broadcast(lobby);
  });

  socket.on("disconnect", () => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby) return;
    if (lobby.phase === "waiting") {
      for (let t = 0; t < 2; t++) {
        if (lobby.captains[t]?.id === socket.id) lobby.captains[t] = null;
      }
      if (!lobby.captains[0] && !lobby.captains[1]) {
        clearTimer(lobby); lobbies.delete(myLobby); return;
      }
      if (socket.id === lobby.hostId) {
        const other = lobby.captains[0] || lobby.captains[1];
        if (other) lobby.hostId = other.id;
      }
      broadcast(lobby);
    }
    // During draft: keep slot (can reconnect)
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Deadlock Draft server on port ${PORT}`));
