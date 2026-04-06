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
//  LOBBIES
// ═══════════════════════════════════════════════════════════
const lobbies = new Map();

function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return lobbies.has(code) ? genCode() : code;
}

function banCount(poolSize) { return Math.max(0, poolSize - 2); }

// ═══════════════════════════════════════════════════════════
//  FIND PLAYER IN LOBBY
// ═══════════════════════════════════════════════════════════
function findPerson(lobby, sid) {
  // Check captains
  for (let t = 0; t < 2; t++) {
    if (lobby.captains[t]?.id === sid) return { role: "captain", team: t };
  }
  // Check spectators
  for (let t = 0; t < 2; t++) {
    const idx = lobby.spectators[t].findIndex(s => s.id === sid);
    if (idx !== -1) return { role: "spectator", team: t, idx };
  }
  // Check unassigned
  const ui = lobby.unassigned.findIndex(s => s.id === sid);
  if (ui !== -1) return { role: "unassigned", idx: ui };
  return null;
}

// ═══════════════════════════════════════════════════════════
//  CLIENT STATE (filtered per role)
// ═══════════════════════════════════════════════════════════
function stateFor(lobby, sid) {
  const me = findPerson(lobby, sid);
  const role = me?.role || "unknown";
  const myTeam = (role === "captain" || role === "spectator") ? me.team : -1;
  const oppTeam = myTeam === 0 ? 1 : 0;

  const s = {
    code: lobby.code,
    phase: lobby.phase,
    timerDuration: lobby.timerDuration,
    timerEnd: lobby.timerEnd,
    teamNames: lobby.teamNames,
    myTeam,
    role,
    isHost: sid === lobby.hostId,
    captains: lobby.captains.map(c => c ? { name: c.name, id: c.id } : null),
    spectators: lobby.spectators.map(t => t.map(s => ({ name: s.name, id: s.id }))),
    unassigned: lobby.unassigned.map(u => ({ name: u.name, id: u.id })),
    bans: [...lobby.bans],
    heroes: HEROES,
    // Spectator preferences: aggregate for the captain to see
    specPrefs: lobby.specPrefs,
  };

  // Phase-specific
  if (lobby.phase === "phase1") {
    if (role === "captain") {
      s.myPicks = lobby.picks[myTeam] || [];
      s.myLocked = lobby.locked[myTeam];
      s.oppLocked = lobby.locked[oppTeam];
    } else {
      // Spectators see their team captain's picks in real-time
      s.myPicks = myTeam >= 0 ? (lobby.picks[myTeam] || []) : [];
      s.myLocked = myTeam >= 0 ? lobby.locked[myTeam] : false;
      s.oppLocked = myTeam >= 0 ? lobby.locked[oppTeam] : false;
    }
  }

  if (["phase1_reveal","phase2","phase2_reveal","phase3","complete"].includes(lobby.phase)) {
    if (myTeam >= 0) {
      s.myPool = [...(lobby.pools[myTeam] || [])];
      s.oppPool = [...(lobby.pools[oppTeam] || [])];
    } else {
      s.myPool = []; s.oppPool = [];
    }
    s.overlaps = lobby.overlaps || [];
    s.allPicks = [[...(lobby.origPicks[0] || [])], [...(lobby.origPicks[1] || [])]];
  }

  if (lobby.phase === "phase2") {
    if (role === "captain" && myTeam >= 0) {
      s.banTarget = banCount(lobby.pools[oppTeam]?.length || 0);
      s.myBans = lobby.phase2Bans[myTeam] || [];
      s.myLocked = lobby.locked[myTeam];
      s.oppLocked = lobby.locked[oppTeam];
    }
  }

  if (["phase2_reveal","phase3","complete"].includes(lobby.phase)) {
    s.phase2Banned = lobby.phase2Banned || [[], []];
  }

  if (lobby.phase === "phase3") {
    if (role === "captain" && myTeam >= 0) {
      s.myChoice = lobby.phase3Choice[myTeam];
      s.myLocked = lobby.locked[myTeam];
      s.oppLocked = lobby.locked[oppTeam];
      s.skipPhase3 = (lobby.pools[myTeam]?.length || 0) <= 1;
    }
  }

  if (lobby.phase === "complete") {
    s.champions = lobby.champions || [null, null];
  }

  return s;
}

function broadcast(lobby) {
  const everyone = [
    ...lobby.captains.filter(Boolean),
    ...lobby.spectators[0],
    ...lobby.spectators[1],
    ...lobby.unassigned,
  ];
  for (const p of everyone) {
    io.to(p.id).emit("state", stateFor(lobby, p.id));
  }
}

// ═══════════════════════════════════════════════════════════
//  TIMER
// ═══════════════════════════════════════════════════════════
function startTimer(lobby, onExpire) {
  clearTimer(lobby);
  lobby.timerEnd = Date.now() + lobby.timerDuration * 1000;
  lobby.timerRef = setTimeout(() => {
    lobby.timerRef = null; lobby.timerEnd = null; onExpire();
  }, lobby.timerDuration * 1000);
}
function clearTimer(lobby) {
  if (lobby.timerRef) { clearTimeout(lobby.timerRef); lobby.timerRef = null; }
  lobby.timerEnd = null;
}

// ═══════════════════════════════════════════════════════════
//  PHASE LOGIC
// ═══════════════════════════════════════════════════════════
function startPhase1(lobby) {
  lobby.phase = "phase1";
  lobby.picks = [[], []]; lobby.pools = [[], []]; lobby.origPicks = [[], []];
  lobby.bans = new Set(); lobby.overlaps = [];
  lobby.phase2Bans = [[], []]; lobby.phase2Banned = [[], []];
  lobby.phase3Choice = [null, null]; lobby.champions = [null, null];
  lobby.locked = [false, false];
  lobby.specPrefs = [{}, {}]; // { heroName: count }
  startTimer(lobby, () => finishPhase1(lobby));
  broadcast(lobby);
}

function finishPhase1(lobby) {
  clearTimer(lobby);
  for (let t = 0; t < 2; t++) {
    const have = new Set(lobby.picks[t]);
    const allPicked = new Set([...lobby.picks[0], ...lobby.picks[1]]);
    while (have.size < 6) {
      const avail = HEROES.filter(h => !have.has(h) && !allPicked.has(h));
      if (!avail.length) break;
      const pick = avail[Math.floor(Math.random() * avail.length)];
      have.add(pick); allPicked.add(pick);
    }
    lobby.picks[t] = [...have]; lobby.origPicks[t] = [...lobby.picks[t]];
  }
  const set0 = new Set(lobby.picks[0]);
  lobby.overlaps = lobby.picks[1].filter(h => set0.has(h));
  for (const h of lobby.overlaps) lobby.bans.add(h);
  for (let t = 0; t < 2; t++) lobby.pools[t] = lobby.picks[t].filter(h => !lobby.bans.has(h));
  lobby.locked = [false, false];
  lobby.phase = "phase1_reveal";
  broadcast(lobby);
}

function startPhase2(lobby) {
  if (lobby.pools[0].length <= 2 && lobby.pools[1].length <= 2) {
    lobby.phase2Banned = [[], []]; startPhase3(lobby); return;
  }
  lobby.phase = "phase2"; lobby.phase2Bans = [[], []]; lobby.locked = [false, false];
  lobby.specPrefs = [{}, {}];
  if (banCount(lobby.pools[1].length) === 0) lobby.locked[0] = true;
  if (banCount(lobby.pools[0].length) === 0) lobby.locked[1] = true;
  startTimer(lobby, () => finishPhase2(lobby));
  broadcast(lobby);
}

function finishPhase2(lobby) {
  clearTimer(lobby);
  for (let t = 0; t < 2; t++) {
    const oppT = 1 - t;
    const need = banCount(lobby.pools[oppT].length);
    if (lobby.phase2Bans[t].length < need) {
      const pool = lobby.pools[oppT].filter(h => !lobby.phase2Bans[t].includes(h));
      const shuffled = pool.sort(() => Math.random() - 0.5);
      while (lobby.phase2Bans[t].length < need && shuffled.length) lobby.phase2Bans[t].push(shuffled.pop());
    }
  }
  for (let t = 0; t < 2; t++) {
    const oppT = 1 - t;
    lobby.phase2Banned[t] = [...lobby.phase2Bans[t]];
    for (const h of lobby.phase2Bans[t]) {
      lobby.pools[oppT] = lobby.pools[oppT].filter(x => x !== h);
      lobby.bans.add(h);
    }
  }
  lobby.locked = [false, false];
  lobby.phase = "phase2_reveal";
  broadcast(lobby);
}

function startPhase3(lobby) {
  lobby.phase = "phase3"; lobby.phase3Choice = [null, null]; lobby.locked = [false, false];
  lobby.specPrefs = [{}, {}];
  for (let t = 0; t < 2; t++) {
    if (lobby.pools[t].length <= 1) {
      lobby.phase3Choice[t] = lobby.pools[t][0] || null; lobby.locked[t] = true;
    }
  }
  if (lobby.locked[0] && lobby.locked[1]) {
    lobby.champions = [...lobby.phase3Choice]; lobby.phase = "complete";
    broadcast(lobby); return;
  }
  startTimer(lobby, () => finishPhase3(lobby));
  broadcast(lobby);
}

function finishPhase3(lobby) {
  clearTimer(lobby);
  for (let t = 0; t < 2; t++) {
    if (!lobby.phase3Choice[t] && lobby.pools[t].length > 0)
      lobby.phase3Choice[t] = lobby.pools[t][Math.floor(Math.random() * lobby.pools[t].length)];
  }
  lobby.champions = [...lobby.phase3Choice]; lobby.phase = "complete";
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
      code, hostId: socket.id,
      timerDuration: timerDuration || 60,
      phase: "waiting",
      teamNames: ["Team 1", "Team 2"],
      captains: [{ id: socket.id, name }, null], // host is captain 1
      spectators: [[], []], // [team0 specs, team1 specs]
      unassigned: [], // people who joined but haven't picked a team
      picks: [[], []], pools: [[], []], origPicks: [[], []],
      bans: new Set(), overlaps: [],
      phase2Bans: [[], []], phase2Banned: [[], []],
      phase3Choice: [null, null], champions: [null, null],
      locked: [false, false],
      specPrefs: [{}, {}],
      timerRef: null, timerEnd: null,
    };
    lobbies.set(code, lobby);
    myLobby = code;
    socket.join(code);
    socket.emit("lobbyCreated", { code });
    broadcast(lobby);
  });

  // Join as captain (via captain link)
  socket.on("joinAsCaptain", ({ code, name }) => {
    const c = code.toUpperCase();
    const lobby = lobbies.get(c);
    if (!lobby) return socket.emit("err", "Lobby not found.");
    if (lobby.phase !== "waiting") return socket.emit("err", "Draft already in progress.");
    // Check if already in lobby
    if (findPerson(lobby, socket.id)) { broadcast(lobby); return; }
    // Fill empty captain slot
    if (!lobby.captains[1]) {
      lobby.captains[1] = { id: socket.id, name };
    } else if (!lobby.captains[0]) {
      lobby.captains[0] = { id: socket.id, name };
      lobby.hostId = socket.id;
    } else {
      return socket.emit("err", "Both captain slots are filled.");
    }
    myLobby = c; socket.join(c);
    socket.emit("joined", { code: c, role: "captain" });
    broadcast(lobby);
  });

  // Join as spectator (via spectator link)
  socket.on("joinAsSpectator", ({ code, name }) => {
    const c = code.toUpperCase();
    const lobby = lobbies.get(c);
    if (!lobby) return socket.emit("err", "Lobby not found.");
    if (findPerson(lobby, socket.id)) { broadcast(lobby); return; }
    // Start unassigned
    lobby.unassigned.push({ id: socket.id, name });
    myLobby = c; socket.join(c);
    socket.emit("joined", { code: c, role: "unassigned" });
    broadcast(lobby);
  });

  // Spectator/unassigned picks a team
  socket.on("joinTeam", ({ team }) => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby) return;
    const me = findPerson(lobby, socket.id);
    if (!me) return;
    const t = team === 0 ? 0 : 1;
    let playerName = "Player";

    if (me.role === "unassigned") {
      playerName = lobby.unassigned[me.idx]?.name || "Player";
      lobby.unassigned.splice(me.idx, 1);
    } else if (me.role === "spectator") {
      playerName = lobby.spectators[me.team][me.idx]?.name || "Player";
      lobby.spectators[me.team].splice(me.idx, 1);
    } else return;

    lobby.spectators[t].push({ id: socket.id, name: playerName });
    broadcast(lobby);
  });

  socket.on("updateTimer", ({ duration }) => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby || socket.id !== lobby.hostId || lobby.phase !== "waiting") return;
    lobby.timerDuration = Math.min(300, Math.max(10, Math.round(duration / 10) * 10));
    broadcast(lobby);
  });

  socket.on("startDraft", () => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby || socket.id !== lobby.hostId) return;
    if (!lobby.captains[0] || !lobby.captains[1]) return socket.emit("err", "Need 2 captains.");
    startPhase1(lobby);
  });

  socket.on("lockPicks", ({ heroes }) => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby || lobby.phase !== "phase1") return;
    const t = lobby.captains[0]?.id === socket.id ? 0 : lobby.captains[1]?.id === socket.id ? 1 : -1;
    if (t === -1 || lobby.locked[t]) return;
    lobby.picks[t] = [...new Set(heroes)].filter(h => HEROES.includes(h)).slice(0, 6);
    lobby.locked[t] = true;
    broadcast(lobby); checkBothLocked(lobby);
  });

  socket.on("lockBans", ({ heroes }) => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby || lobby.phase !== "phase2") return;
    const t = lobby.captains[0]?.id === socket.id ? 0 : lobby.captains[1]?.id === socket.id ? 1 : -1;
    if (t === -1 || lobby.locked[t]) return;
    const oppT = 1 - t;
    const need = banCount(lobby.pools[oppT].length);
    const valid = [...new Set(heroes)].filter(h => lobby.pools[oppT].includes(h)).slice(0, need);
    if (valid.length !== need) return;
    lobby.phase2Bans[t] = valid;
    lobby.locked[t] = true;
    broadcast(lobby); checkBothLocked(lobby);
  });

  socket.on("lockFinal", ({ hero }) => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby || lobby.phase !== "phase3") return;
    const t = lobby.captains[0]?.id === socket.id ? 0 : lobby.captains[1]?.id === socket.id ? 1 : -1;
    if (t === -1 || lobby.locked[t]) return;
    if (!lobby.pools[t].includes(hero)) return;
    lobby.phase3Choice[t] = hero; lobby.locked[t] = true;
    broadcast(lobby); checkBothLocked(lobby);
  });

  // Spectator hero preference
  socket.on("specPref", ({ hero, on }) => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby) return;
    const me = findPerson(lobby, socket.id);
    if (!me || me.role !== "spectator" || me.team < 0) return;
    const prefs = lobby.specPrefs[me.team];
    if (on) prefs[hero] = (prefs[hero] || 0) + 1;
    else prefs[hero] = Math.max(0, (prefs[hero] || 0) - 1);
    broadcast(lobby);
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
    clearTimer(lobby); lobby.phase = "waiting";
    broadcast(lobby);
  });

  socket.on("disconnect", () => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby) return;
    if (lobby.phase === "waiting") {
      // Remove from wherever they are
      for (let t = 0; t < 2; t++) {
        if (lobby.captains[t]?.id === socket.id) lobby.captains[t] = null;
        lobby.spectators[t] = lobby.spectators[t].filter(s => s.id !== socket.id);
      }
      lobby.unassigned = lobby.unassigned.filter(u => u.id !== socket.id);
      const all = [...lobby.captains.filter(Boolean), ...lobby.spectators[0], ...lobby.spectators[1], ...lobby.unassigned];
      if (all.length === 0) { clearTimer(lobby); lobbies.delete(myLobby); return; }
      if (socket.id === lobby.hostId) {
        const nh = lobby.captains[0] || lobby.captains[1] || all[0];
        if (nh) lobby.hostId = nh.id;
      }
      broadcast(lobby);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Deadlock Draft server on port ${PORT}`));
