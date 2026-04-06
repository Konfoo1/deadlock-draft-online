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
//  STANDARD DRAFT TURN ORDER — Snake draft, 2 bans + 12 picks = 14 turns
// ═══════════════════════════════════════════════════════════
const STD_TURNS = [
  // Ban Phase
  {type:"ban",team:0},{type:"ban",team:1},
  // Pick Phase — snake order
  {type:"pick",team:0},{type:"pick",team:1},{type:"pick",team:1},{type:"pick",team:0},
  {type:"pick",team:0},{type:"pick",team:1},{type:"pick",team:1},{type:"pick",team:0},
  {type:"pick",team:0},{type:"pick",team:1},{type:"pick",team:1},{type:"pick",team:0},
];

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
  for (let t = 0; t < 2; t++) {
    if (lobby.captains[t]?.id === sid) return { role: "captain", team: t };
  }
  for (let t = 0; t < 2; t++) {
    const idx = lobby.spectators[t].findIndex(s => s.id === sid);
    if (idx !== -1) return { role: "spectator", team: t, idx };
  }
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
    mode: lobby.mode,
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
    ready: [...lobby.ready],
    heroes: HEROES,
    specPrefs: lobby.specPrefs,
  };

  // ── PHASE DRAFT (Clone Wars) ──
  if (lobby.mode === "phase") {
    s.bans = [...lobby.bans];

    if (lobby.phase === "phase1") {
      if (role === "captain") {
        s.myPicks = lobby.picks[myTeam] || [];
        s.myLocked = lobby.locked[myTeam];
        s.oppLocked = lobby.locked[oppTeam];
      } else if (myTeam >= 0) {
        s.myPicks = lobby.picks[myTeam] || [];
        s.myLocked = lobby.locked[myTeam];
        s.oppLocked = lobby.locked[oppTeam];
      } else {
        s.myPicks = [];
        s.myLocked = false; s.oppLocked = false;
        s.locked0 = lobby.locked[0]; s.locked1 = lobby.locked[1];
      }
    }

    if (["phase1_reveal","phase2","phase2_reveal","phase3","complete"].includes(lobby.phase)) {
      if (myTeam >= 0) {
        s.myPool = [...(lobby.pools[myTeam] || [])];
        s.oppPool = [...(lobby.pools[oppTeam] || [])];
      } else {
        s.pool0 = [...(lobby.pools[0] || [])];
        s.pool1 = [...(lobby.pools[1] || [])];
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
      if (role === "unassigned") {
        s.pool0 = [...(lobby.pools[0] || [])];
        s.pool1 = [...(lobby.pools[1] || [])];
      }
    }
  }

  // ── STANDARD DRAFT ──
  if (lobby.mode === "standard" && lobby.std) {
    const st = lobby.std;
    s.std = {
      step: st.step,
      turns: STD_TURNS,
      bans: [[...st.bans[0]], [...st.bans[1]]],
      picks: [[...st.picks[0]], [...st.picks[1]]],
      totalSteps: STD_TURNS.length,
    };
    if (st.step < STD_TURNS.length) {
      s.std.activeTurn = STD_TURNS[st.step];
    }
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
//  PHASE DRAFT LOGIC (Clone Wars)
// ═══════════════════════════════════════════════════════════
function startPhase1(lobby) {
  lobby.phase = "phase1";
  lobby.picks = [[], []]; lobby.pools = [[], []]; lobby.origPicks = [[], []];
  lobby.bans = new Set(); lobby.overlaps = [];
  lobby.phase2Bans = [[], []]; lobby.phase2Banned = [[], []];
  lobby.phase3Choice = [null, null]; lobby.champions = [null, null];
  lobby.locked = [false, false];
  lobby.specPrefs = [{}, {}];
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
//  STANDARD DRAFT LOGIC
// ═══════════════════════════════════════════════════════════
function stdAllUsed(lobby) {
  const st = lobby.std;
  return new Set([...st.bans[0], ...st.bans[1], ...st.picks[0], ...st.picks[1]]);
}

function startStdDraft(lobby) {
  lobby.phase = "std_drafting";
  lobby.std = {
    step: 0,
    bans: [[], []],
    picks: [[], []],
  };
  lobby.specPrefs = [{}, {}];
  startTimer(lobby, () => stdAutoAction(lobby));
  broadcast(lobby);
}

function stdAutoAction(lobby) {
  clearTimer(lobby);
  const st = lobby.std;
  if (st.step >= STD_TURNS.length) return;
  const turn = STD_TURNS[st.step];
  const used = stdAllUsed(lobby);
  const avail = HEROES.filter(h => !used.has(h));
  if (avail.length === 0) { stdFinish(lobby); return; }
  const hero = avail[Math.floor(Math.random() * avail.length)];
  if (turn.type === "ban") st.bans[turn.team].push(hero);
  else st.picks[turn.team].push(hero);
  stdAdvance(lobby);
}

function stdAdvance(lobby) {
  const st = lobby.std;
  st.step++;
  if (st.step >= STD_TURNS.length) {
    stdFinish(lobby); return;
  }
  lobby.specPrefs = [{}, {}];
  startTimer(lobby, () => stdAutoAction(lobby));
  broadcast(lobby);
}

function stdFinish(lobby) {
  clearTimer(lobby);
  lobby.phase = "complete";
  lobby.champions = [null, null]; // standard draft doesn't have a single champion
  broadcast(lobby);
}

// ═══════════════════════════════════════════════════════════
//  SOCKET HANDLERS
// ═══════════════════════════════════════════════════════════
io.on("connection", (socket) => {
  let myLobby = null;

  socket.on("createLobby", ({ name, timerDuration, mode }) => {
    const code = genCode();
    const lobby = {
      code, hostId: socket.id,
      mode: mode || "phase", // "phase" or "standard"
      timerDuration: timerDuration || 60,
      phase: "waiting",
      teamNames: ["Hidden King", "Archmother"],
      captains: [null, null],
      ready: [false, false],
      spectators: [[], []],
      unassigned: [{ id: socket.id, name }],
      // Phase draft fields
      picks: [[], []], pools: [[], []], origPicks: [[], []],
      bans: new Set(), overlaps: [],
      phase2Bans: [[], []], phase2Banned: [[], []],
      phase3Choice: [null, null], champions: [null, null],
      locked: [false, false],
      specPrefs: [{}, {}],
      timerRef: null, timerEnd: null,
      // Standard draft fields (initialized on start)
      std: null,
    };
    lobbies.set(code, lobby);
    myLobby = code;
    socket.join(code);
    socket.emit("lobbyCreated", { code });
    broadcast(lobby);
  });

  socket.on("joinAsCaptain", ({ code, name, team }) => {
    const c = code.toUpperCase();
    const lobby = lobbies.get(c);
    if (!lobby) return socket.emit("err", "Lobby not found.");
    if (lobby.phase !== "waiting") return socket.emit("err", "Draft already in progress.");
    if (findPerson(lobby, socket.id)) { broadcast(lobby); return; }
    // If team preference provided, try that slot first
    if (team === 0 || team === 1) {
      if (!lobby.captains[team]) {
        lobby.captains[team] = { id: socket.id, name };
      } else if (!lobby.captains[1 - team]) {
        lobby.captains[1 - team] = { id: socket.id, name };
      } else {
        return socket.emit("err", "Both captain slots are filled.");
      }
    } else {
      // No preference — fill first available
      if (!lobby.captains[1]) {
        lobby.captains[1] = { id: socket.id, name };
      } else if (!lobby.captains[0]) {
        lobby.captains[0] = { id: socket.id, name };
      } else {
        return socket.emit("err", "Both captain slots are filled.");
      }
    }
    myLobby = c; socket.join(c);
    socket.emit("joined", { code: c, role: "captain" });
    broadcast(lobby);
  });

  socket.on("joinAsSpectator", ({ code, name }) => {
    const c = code.toUpperCase();
    const lobby = lobbies.get(c);
    if (!lobby) return socket.emit("err", "Lobby not found.");
    if (findPerson(lobby, socket.id)) { broadcast(lobby); return; }
    lobby.unassigned.push({ id: socket.id, name });
    myLobby = c; socket.join(c);
    socket.emit("joined", { code: c, role: "unassigned" });
    broadcast(lobby);
  });

  socket.on("joinTeam", ({ team }) => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby || lobby.phase !== "waiting") return;
    const me = findPerson(lobby, socket.id);
    if (!me) return;
    let playerName = "Player";
    if (me.role === "unassigned") {
      playerName = lobby.unassigned[me.idx]?.name || "Player";
      lobby.unassigned.splice(me.idx, 1);
    } else if (me.role === "spectator") {
      playerName = lobby.spectators[me.team][me.idx]?.name || "Player";
      lobby.spectators[me.team].splice(me.idx, 1);
    } else if (me.role === "captain") {
      playerName = lobby.captains[me.team]?.name || "Player";
      lobby.captains[me.team] = null;
      lobby.ready[me.team] = false;
    } else return;
    if (team === -1) {
      lobby.unassigned.push({ id: socket.id, name: playerName });
    } else {
      const t = team === 0 ? 0 : 1;
      lobby.spectators[t].push({ id: socket.id, name: playerName });
    }
    broadcast(lobby);
  });

  socket.on("hostToggleCaptain", ({ team }) => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby || lobby.phase !== "waiting" || socket.id !== lobby.hostId) return;
    const me = findPerson(lobby, socket.id);
    if (!me) return;
    const t = team === 0 ? 0 : 1;
    if (me.role === "captain" && me.team === t) {
      const playerName = lobby.captains[t]?.name || "Host";
      lobby.captains[t] = null; lobby.ready[t] = false;
      lobby.unassigned.push({ id: socket.id, name: playerName });
      broadcast(lobby); return;
    }
    let playerName = "Host";
    if (me.role === "unassigned") { playerName = lobby.unassigned[me.idx]?.name || "Host"; lobby.unassigned.splice(me.idx, 1); }
    else if (me.role === "spectator") { playerName = lobby.spectators[me.team][me.idx]?.name || "Host"; lobby.spectators[me.team].splice(me.idx, 1); }
    else if (me.role === "captain") { playerName = lobby.captains[me.team]?.name || "Host"; lobby.captains[me.team] = null; lobby.ready[me.team] = false; }
    if (lobby.captains[t]) {
      lobby.unassigned.push({ id: socket.id, name: playerName });
      socket.emit("err", "That captain slot is already taken.");
      broadcast(lobby); return;
    }
    lobby.captains[t] = { id: socket.id, name: playerName };
    lobby.ready[t] = false;
    broadcast(lobby);
  });

  socket.on("promoteToCaptain", ({ playerId, team }) => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby || lobby.phase !== "waiting" || socket.id !== lobby.hostId) return;
    const t = team === 0 ? 0 : 1;
    if (lobby.captains[t]) return socket.emit("err", "Captain slot already filled.");
    const target = findPerson(lobby, playerId);
    if (!target) return;
    let name = "Player";
    if (target.role === "unassigned") { name = lobby.unassigned[target.idx]?.name || "Player"; lobby.unassigned.splice(target.idx, 1); }
    else if (target.role === "spectator") { name = lobby.spectators[target.team][target.idx]?.name || "Player"; lobby.spectators[target.team].splice(target.idx, 1); }
    else return;
    lobby.captains[t] = { id: playerId, name };
    lobby.ready[t] = false;
    broadcast(lobby);
  });

  socket.on("toggleReady", () => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby || lobby.phase !== "waiting") return;
    const t = lobby.captains[0]?.id === socket.id ? 0 : lobby.captains[1]?.id === socket.id ? 1 : -1;
    if (t === -1) return;
    lobby.ready[t] = !lobby.ready[t];
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
    if (!lobby.ready[0] || !lobby.ready[1]) return socket.emit("err", "Both captains must be ready.");
    if (lobby.mode === "standard") startStdDraft(lobby);
    else startPhase1(lobby);
  });

  // ── Phase Draft Actions ──
  socket.on("lockPicks", ({ heroes }) => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby || lobby.mode !== "phase" || lobby.phase !== "phase1") return;
    const t = lobby.captains[0]?.id === socket.id ? 0 : lobby.captains[1]?.id === socket.id ? 1 : -1;
    if (t === -1 || lobby.locked[t]) return;
    lobby.picks[t] = [...new Set(heroes)].filter(h => HEROES.includes(h)).slice(0, 6);
    lobby.locked[t] = true;
    broadcast(lobby); checkBothLocked(lobby);
  });

  socket.on("lockBans", ({ heroes }) => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby || lobby.mode !== "phase" || lobby.phase !== "phase2") return;
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
    if (!lobby || lobby.mode !== "phase" || lobby.phase !== "phase3") return;
    const t = lobby.captains[0]?.id === socket.id ? 0 : lobby.captains[1]?.id === socket.id ? 1 : -1;
    if (t === -1 || lobby.locked[t]) return;
    if (!lobby.pools[t].includes(hero)) return;
    lobby.phase3Choice[t] = hero; lobby.locked[t] = true;
    broadcast(lobby); checkBothLocked(lobby);
  });

  // ── Standard Draft Action ──
  socket.on("stdAction", ({ hero }) => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby || lobby.mode !== "standard" || lobby.phase !== "std_drafting" || !lobby.std) return;
    const st = lobby.std;
    if (st.step >= STD_TURNS.length) return;
    const turn = STD_TURNS[st.step];
    const t = lobby.captains[0]?.id === socket.id ? 0 : lobby.captains[1]?.id === socket.id ? 1 : -1;
    if (t !== turn.team) return; // not your turn
    const used = stdAllUsed(lobby);
    if (used.has(hero) || !HEROES.includes(hero)) return;
    clearTimer(lobby);
    if (turn.type === "ban") st.bans[turn.team].push(hero);
    else st.picks[turn.team].push(hero);
    stdAdvance(lobby);
  });

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
    lobby.ready = [false, false]; lobby.std = null;
    broadcast(lobby);
  });

  socket.on("disconnect", () => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby) return;
    if (lobby.phase === "waiting") {
      for (let t = 0; t < 2; t++) {
        if (lobby.captains[t]?.id === socket.id) { lobby.captains[t] = null; lobby.ready[t] = false; }
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
