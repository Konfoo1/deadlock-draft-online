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
  "Mirage","Mo & Krill","Paige","Paradox","Pocket","Rem","Seven",
  "Shiv","Sinclair","Silver","Venator","Victor","Vindicta","Viscous",
  "Vyper","Warden","Wraith","Yamato",
].sort();

// ═══════════════════════════════════════════════════════════
//  STANDARD DRAFT TURN ORDER — Snake draft, 4 bans + 12 picks = 16 turns
// ═══════════════════════════════════════════════════════════
const STD_TURNS = [
  // Ban Phase 1
  {type:"ban",team:0},{type:"ban",team:1},
  // Pick Phase 1 — snake order (2 rounds)
  {type:"pick",team:0},{type:"pick",team:1},{type:"pick",team:1},{type:"pick",team:0},
  {type:"pick",team:0},{type:"pick",team:1},{type:"pick",team:1},{type:"pick",team:0},
  // Ban Phase 2
  {type:"ban",team:0},{type:"ban",team:1},
  // Pick Phase 2 — snake order (1 round)
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

  // For duel mode, use actual captain names instead of "Player 1" / "Player 2"
  let teamNames = lobby.teamNames;
  if (lobby.mode === "duel") {
    teamNames = [
      lobby.captains[0]?.name || "Player 1",
      lobby.captains[1]?.name || "Player 2",
    ];
  }

  const s = {
    code: lobby.code,
    mode: lobby.mode,
    phase: lobby.phase,
    timerDuration: lobby.timerDuration,
    timerEnd: lobby.timerEnd,
    teamNames,
    myTeam,
    role,
    isHost: sid === lobby.hostId,
    captains: lobby.captains.map(c => c ? { name: c.name, id: c.id } : null),
    spectators: lobby.spectators.map(t => t.map(s => ({ name: s.name, id: s.id }))),
    unassigned: lobby.unassigned.map(u => ({ name: u.name, id: u.id })),
    ready: [...lobby.ready],
    heroes: HEROES.filter(h => !lobby.globalBans.includes(h)),
    allHeroes: HEROES,
    globalBans: lobby.globalBans,
    duelPoolSize: lobby.duelPoolSize,
    specPrefs: lobby.specPrefs,
  };

  // ── PHASE DRAFT (Clone Wars) + DUEL MODE (same phases, different rules) ──
  if (lobby.mode === "phase" || lobby.mode === "duel") {
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
  const isDuel = lobby.mode === "duel";
  const poolSize = isDuel ? lobby.duelPoolSize : 6;
  const availableHeroes = HEROES.filter(h => !lobby.globalBans.includes(h));

  for (let t = 0; t < 2; t++) {
    const have = new Set(lobby.picks[t]);
    // For duel mode, allow overlaps — don't exclude opponent's picks from random fill
    const allPicked = isDuel ? new Set(lobby.picks[t]) : new Set([...lobby.picks[0], ...lobby.picks[1]]);
    while (have.size < poolSize) {
      const avail = availableHeroes.filter(h => !have.has(h) && (isDuel || !allPicked.has(h)));
      if (!avail.length) break;
      const pick = avail[Math.floor(Math.random() * avail.length)];
      have.add(pick); if (!isDuel) allPicked.add(pick);
    }
    lobby.picks[t] = [...have]; lobby.origPicks[t] = [...lobby.picks[t]];
  }

  if (isDuel) {
    // Duel mode: overlaps are noted but NOT banned
    const set0 = new Set(lobby.picks[0]);
    lobby.overlaps = lobby.picks[1].filter(h => set0.has(h));
    // No bans from overlaps — pools = full picks
    for (let t = 0; t < 2; t++) lobby.pools[t] = [...lobby.picks[t]];
  } else {
    // Clone Wars: overlaps get banned
    const set0 = new Set(lobby.picks[0]);
    lobby.overlaps = lobby.picks[1].filter(h => set0.has(h));
    for (const h of lobby.overlaps) lobby.bans.add(h);
    for (let t = 0; t < 2; t++) lobby.pools[t] = lobby.picks[t].filter(h => !lobby.bans.has(h));
  }

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
  const availableHeroes = HEROES.filter(h => !lobby.globalBans.includes(h));
  for (let t = 0; t < 2; t++) {
    const oppT = 1 - t;
    const need = banCount(lobby.pools[oppT].length);
    if (lobby.phase2Bans[t].length < need) {
      const pool = lobby.pools[oppT].filter(h => !lobby.phase2Bans[t].includes(h) && availableHeroes.includes(h));
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
  const availableHeroes = new Set(HEROES.filter(h => !lobby.globalBans.includes(h)));
  for (let t = 0; t < 2; t++) {
    if (!lobby.phase3Choice[t] && lobby.pools[t].length > 0) {
      const validPool = lobby.pools[t].filter(h => availableHeroes.has(h));
      lobby.phase3Choice[t] = validPool.length > 0
        ? validPool[Math.floor(Math.random() * validPool.length)]
        : lobby.pools[t][Math.floor(Math.random() * lobby.pools[t].length)];
    }
  }
  lobby.champions = [...lobby.phase3Choice]; lobby.phase = "complete";
  broadcast(lobby);
  if (lobby.tourneyMatch) onTourneyDraftComplete(lobby);
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
  if (lobby.tourneyMatch) onTourneyDraftComplete(lobby);
}

// ═══════════════════════════════════════════════════════════
//  TOURNAMENTS
// ═══════════════════════════════════════════════════════════
const tournaments = new Map();

function genTourneyCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "T";
  for (let i = 0; i < 3; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return tournaments.has(code) ? genTourneyCode() : code;
}

function findTourneyPlayer(tourney, sid) {
  return tourney.players.find(p => p.id === sid) || null;
}

function tourneyStateFor(tourney, sid) {
  const me = findTourneyPlayer(tourney, sid);
  return {
    code: tourney.code,
    type: "tournament",
    name: tourney.name,
    format: tourney.format,
    draftMode: tourney.draftMode,
    bestOf: tourney.bestOf,
    maxPlayers: tourney.maxPlayers,
    globalBans: tourney.globalBans,
    timerDuration: tourney.timerDuration,
    duelPoolSize: tourney.duelPoolSize,
    phase: tourney.phase, // "lobby" or later "bracket"
    isHost: sid === tourney.hostId,
    hostPlaying: tourney.hostPlaying,
    players: tourney.players.map(p => ({ id: p.id, name: p.name, isPlayer: p.isPlayer !== false })),
    chat: tourney.chat.slice(-50), // last 50 messages
    coinStreaks: tourney.coinStreaks, // { id: bestStreak }
    myName: me?.name || null,
    allHeroes: HEROES,
  };
}

function broadcastTourney(tourney) {
  for (const p of tourney.players) {
    io.to(p.id).emit("tourneyState", tourneyStateFor(tourney, p.id));
  }
}

function broadcastTourneyBracket(tourney) {
  for (const p of tourney.players) {
    io.to(p.id).emit("tourneyState", tourneyBracketStateFor(tourney, p.id));
  }
}

function resolveMatch(tourney, match, winnerName) {
  const loserName = match.slots[0] === winnerName ? match.slots[1] : match.slots[0];
  match.winner = winnerName;
  match.loser = loserName;
  match.status = "complete";

  // Mark the latest round's winner (for per-round hero display)
  if (match.rounds && match.rounds.length > 0) {
    const lastRound = match.rounds[match.rounds.length - 1];
    if (!lastRound.winner) lastRound.winner = winnerName;
  }

  // If loser was already in losers bracket, they're eliminated
  if (match.bracket === "losers" || match.bracket === "grand_final") {
    if (loserName && !tourney.eliminated.includes(loserName)) {
      tourney.eliminated.push(loserName);
    }
  }

  // Check if all active matches in this wave are complete
  const activeMatches = tourney.bracket.matches.filter(m =>
    m.status !== "complete" && m.status !== "pending"
  );

  if (activeMatches.length === 0) {
    // All matches in wave done — start reveal sequence
    const justCompleted = tourney.bracket.matches.filter(m =>
      m.status === "complete" && m.winner && !tourney._revealed?.has(m.id)
    );
    // Track which matches have been revealed
    if (!tourney._revealed) tourney._revealed = new Set();
    const newlyCompleted = justCompleted.filter(m => !tourney._revealed.has(m.id));

    if (newlyCompleted.length > 0) {
      tourney.revealQueue = newlyCompleted.map(m => m.id);
      tourney.revealIndex = 0;
      tourney.phase = "reveal";
      for (const m of newlyCompleted) tourney._revealed.add(m.id);
    } else {
      // Nothing new to reveal, advance
      propagateBracket(tourney);
      activateWave(tourney);
      if (isTourneyComplete(tourney)) tourney.phase = "complete";
    }
  }
}

// Hook: called when a tournament-linked draft completes
function onTourneyDraftComplete(lobby) {
  const tm = lobby.tourneyMatch;
  if (!tm) return;
  const tourney = tournaments.get(tm.tourneyCode);
  if (!tourney) return;
  const match = tourney.bracket.matches.find(m => m.id === tm.matchId);
  if (!match) return;

  // Record round result (hero picks for this draft)
  if (!match.rounds) match.rounds = [];
  match.rounds.push({
    heroes: [lobby.champions[0] || null, lobby.champions[1] || null],
    winner: null, // filled in when vote/dispute resolves
  });

  // Move match to voting phase
  match.status = "voting";
  match.votes = [null, null];

  // Notify players
  for (const p of tourney.players) {
    if (p.name === match.slots[0] || p.name === match.slots[1]) {
      io.to(p.id).emit("tourneyDraftComplete", {
        matchId: match.id,
        slots: match.slots,
      });
    }
  }

  broadcastTourneyBracket(tourney);
}

// ═══════════════════════════════════════════════════════════
//  DOUBLE ELIMINATION BRACKET
// ═══════════════════════════════════════════════════════════
function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

function generateDoubleElimBracket(playerNames) {
  const n = playerNames.length;
  const size = nextPow2(n); // pad to power of 2
  const wRounds = Math.log2(size); // number of winners bracket rounds
  const lRounds = 2 * (wRounds - 1); // losers bracket rounds

  // Shuffle players
  const shuffled = [...playerNames].sort(() => Math.random() - 0.5);
  // Pad with BYE
  while (shuffled.length < size) shuffled.push(null);

  const matches = [];
  let matchId = 0;

  // ── Winners Bracket ──
  // Round 1 matches
  const wbRounds = [];
  const r1 = [];
  for (let i = 0; i < size / 2; i++) {
    const m = {
      id: matchId++,
      bracket: "winners",
      round: 0,
      slots: [shuffled[i * 2], shuffled[i * 2 + 1]], // player names or null (BYE)
      winner: null,
      loser: null,
      status: "pending", // pending | ready_check | drafting | voting | dispute | complete
      readyState: [false, false],
      votes: [null, null], // who each player voted as winner
      draftCode: null,
      score: [0, 0],
      rounds: [], // per-round results: [{heroes:[h0,h1], winner:name}, ...]
    };
    // Auto-resolve BYE matches
    if (m.slots[0] === null && m.slots[1] === null) {
      m.status = "complete"; m.winner = null; m.loser = null;
    } else if (m.slots[1] === null) {
      m.status = "complete"; m.winner = m.slots[0]; m.loser = null;
    } else if (m.slots[0] === null) {
      m.status = "complete"; m.winner = m.slots[1]; m.loser = null;
    }
    matches.push(m);
    r1.push(m.id);
  }
  wbRounds.push(r1);

  // Subsequent WB rounds
  for (let r = 1; r < wRounds; r++) {
    const prevRound = wbRounds[r - 1];
    const thisRound = [];
    for (let i = 0; i < prevRound.length; i += 2) {
      const m = {
        id: matchId++,
        bracket: "winners",
        round: r,
        slots: [null, null],
        feeders: [prevRound[i], prevRound[i + 1]], // match IDs that feed into this
        winner: null, loser: null,
        status: "pending",
        readyState: [false, false],
        votes: [null, null],
        draftCode: null,
        score: [0, 0],
      };
      matches.push(m);
      thisRound.push(m.id);
    }
    wbRounds.push(thisRound);
  }

  // ── Losers Bracket ──
  const lbRounds = [];
  for (let lr = 0; lr < lRounds; lr++) {
    const isDropDown = lr % 2 === 0; // even rounds receive losers from WB
    const thisRound = [];
    if (lr === 0) {
      // First LB round: losers from WB round 1 face each other
      const wbLosers = wbRounds[0]; // match IDs from WB R1
      for (let i = 0; i < wbLosers.length; i += 2) {
        const m = {
          id: matchId++,
          bracket: "losers",
          round: lr,
          slots: [null, null],
          feedersLoser: [wbLosers[i], wbLosers[i + 1]], // losers from these WB matches
          winner: null, loser: null,
          status: "pending",
          readyState: [false, false],
          votes: [null, null],
          draftCode: null,
          score: [0, 0],
        };
        matches.push(m);
        thisRound.push(m.id);
      }
    } else if (isDropDown) {
      // Drop-down round: losers from WB feed in against LB survivors
      const wbRound = Math.floor(lr / 2) + 1; // which WB round's losers drop
      const wbRoundMatches = wbRounds[wbRound] || [];
      const prevLbRound = lbRounds[lr - 1];
      const count = Math.max(wbRoundMatches.length, (prevLbRound || []).length);
      for (let i = 0; i < count; i++) {
        const m = {
          id: matchId++,
          bracket: "losers",
          round: lr,
          slots: [null, null],
          feederWinner: prevLbRound ? prevLbRound[i] : null, // LB survivor (slot 0)
          feederLoser: wbRoundMatches[i] !== undefined ? wbRoundMatches[i] : null, // WB loser drops in (slot 1)
          winner: null, loser: null,
          status: "pending",
          readyState: [false, false],
          votes: [null, null],
          draftCode: null,
          score: [0, 0],
        };
        matches.push(m);
        thisRound.push(m.id);
      }
    } else {
      // Reduction round: LB survivors face each other
      const prevLbRound = lbRounds[lr - 1];
      for (let i = 0; i < prevLbRound.length; i += 2) {
        const m = {
          id: matchId++,
          bracket: "losers",
          round: lr,
          slots: [null, null],
          feeders: [prevLbRound[i], prevLbRound[i + 1]],
          winner: null, loser: null,
          status: "pending",
          readyState: [false, false],
          votes: [null, null],
          draftCode: null,
          score: [0, 0],
        };
        matches.push(m);
        thisRound.push(m.id);
      }
    }
    lbRounds.push(thisRound);
  }

  // ── Grand Final ──
  const wbFinalId = wbRounds[wbRounds.length - 1][0];
  const lbFinalId = lbRounds.length > 0 ? lbRounds[lbRounds.length - 1][0] : null;
  const grandFinal = {
    id: matchId++,
    bracket: "grand_final",
    round: 0,
    slots: [null, null],
    feederWB: wbFinalId,
    feederLB: lbFinalId,
    winner: null, loser: null,
    status: "pending",
    readyState: [false, false],
    votes: [null, null],
    draftCode: null,
    score: [0, 0],
  };
  matches.push(grandFinal);

  return {
    matches,
    wbRounds,
    lbRounds,
    grandFinalId: grandFinal.id,
    totalRounds: wRounds + lRounds + 1,
  };
}

// Propagate winners/losers through bracket after a match completes
function propagateBracket(tourney) {
  const matches = tourney.bracket.matches;
  const byId = {};
  for (const m of matches) byId[m.id] = m;

  for (const m of matches) {
    if (m.status === "complete" || m.slots[0] !== null || m.slots[1] !== null) continue; // skip

    // Winners bracket: fed by previous winners
    if (m.feeders) {
      const f0 = byId[m.feeders[0]];
      const f1 = byId[m.feeders[1]];
      if (f0 && f0.status === "complete" && f0.winner) m.slots[0] = f0.winner;
      if (f1 && f1.status === "complete" && f1.winner) m.slots[1] = f1.winner;
    }

    // Losers bracket first round: fed by losers from WB
    if (m.feedersLoser) {
      const f0 = byId[m.feedersLoser[0]];
      const f1 = byId[m.feedersLoser[1]];
      if (f0 && f0.status === "complete" && f0.loser) m.slots[0] = f0.loser;
      if (f1 && f1.status === "complete" && f1.loser) m.slots[1] = f1.loser;
    }

    // Losers bracket drop-down: LB winner + WB loser
    if (m.feederWinner !== undefined && m.feederWinner !== null) {
      const fw = byId[m.feederWinner];
      if (fw && fw.status === "complete" && fw.winner) m.slots[0] = fw.winner;
    }
    if (m.feederLoser !== undefined && m.feederLoser !== null && !m.feedersLoser) {
      const fl = byId[m.feederLoser];
      if (fl && fl.status === "complete" && fl.loser) m.slots[1] = fl.loser;
    }

    // Grand final: WB winner + LB winner
    if (m.feederWB !== undefined) {
      const fw = byId[m.feederWB];
      if (fw && fw.status === "complete" && fw.winner) m.slots[0] = fw.winner;
    }
    if (m.feederLB !== undefined) {
      const fl = byId[m.feederLB];
      if (fl && fl.status === "complete" && fl.winner) m.slots[1] = fl.winner;
    }

    // Auto-resolve if one slot is filled and the other is a BYE (null feeder)
    // A BYE only applies to WB R1, which is handled at generation time
  }
}

// Get all matches in the current active wave (both slots filled, not yet started)
function getActiveWaveMatches(tourney) {
  return tourney.bracket.matches.filter(m =>
    m.slots[0] !== null && m.slots[1] !== null && m.status === "pending"
  );
}

// Start the ready check for all pending-and-ready matches
function activateWave(tourney) {
  propagateBracket(tourney);
  const wave = getActiveWaveMatches(tourney);
  for (const m of wave) {
    m.status = "ready_check";
    m.readyState = [false, false];
  }
  return wave;
}

// Check if the tournament is complete
function isTourneyComplete(tourney) {
  const gf = tourney.bracket.matches.find(m => m.id === tourney.bracket.grandFinalId);
  return gf && gf.status === "complete";
}

// Find which match a player name is in (current active match)
function findPlayerMatch(tourney, playerName) {
  return tourney.bracket.matches.find(m =>
    (m.slots[0] === playerName || m.slots[1] === playerName) &&
    m.status !== "complete" && m.status !== "pending"
  );
}

// Find player slot index in a match (0 or 1)
function playerSlotInMatch(match, playerName) {
  if (match.slots[0] === playerName) return 0;
  if (match.slots[1] === playerName) return 1;
  return -1;
}

// Get completed matches for reveal sequence
function getCompletedWaveMatches(tourney) {
  if (!tourney.revealQueue) return [];
  return tourney.revealQueue;
}

// Extended tourneyStateFor with bracket data
function tourneyBracketStateFor(tourney, sid) {
  const base = tourneyStateFor(tourney, sid);
  const me = findTourneyPlayer(tourney, sid);
  const myName = me?.name || null;

  // Find my current match
  let myMatch = null;
  if (myName && tourney.bracket) {
    myMatch = findPlayerMatch(tourney, myName);
  }

  base.bracket = tourney.bracket ? {
    matches: tourney.bracket.matches.map(m => ({
      id: m.id,
      bracket: m.bracket,
      round: m.round,
      slots: m.slots,
      winner: m.winner,
      loser: m.loser,
      status: m.status,
      readyState: m.readyState,
      votes: m.votes,
      score: m.score,
      rounds: m.rounds || [],
    })),
    wbRounds: tourney.bracket.wbRounds,
    lbRounds: tourney.bracket.lbRounds,
    grandFinalId: tourney.bracket.grandFinalId,
  } : null;

  base.myMatch = myMatch ? {
    id: myMatch.id,
    slot: playerSlotInMatch(myMatch, myName),
  } : null;

  base.revealQueue = tourney.revealQueue || [];
  base.revealIndex = tourney.revealIndex || 0;
  base.tourneyPhase = tourney.phase; // "lobby", "bracket", "reveal", "complete"
  base.eliminated = tourney.eliminated || [];

  return base;
}

// ═══════════════════════════════════════════════════════════
//  SOCKET HANDLERS
// ═══════════════════════════════════════════════════════════
io.on("connection", (socket) => {
  let myLobby = null;
  let myTourney = null;

  socket.on("createLobby", ({ name, timerDuration, mode }) => {
    const code = genCode();
    const isDuel = mode === "duel";
    const lobby = {
      code, hostId: socket.id,
      mode: mode || "phase", // "phase", "standard", or "duel"
      timerDuration: timerDuration || 60,
      phase: "waiting",
      teamNames: isDuel ? [name || "Player 1", "Player 2"] : ["Hidden King", "Archmother"],
      captains: isDuel ? [{ id: socket.id, name }, null] : [null, null],
      ready: [false, false],
      spectators: [[], []],
      unassigned: isDuel ? [] : [{ id: socket.id, name }],
      // Phase draft fields (shared by phase + duel)
      picks: [[], []], pools: [[], []], origPicks: [[], []],
      bans: new Set(), overlaps: [],
      phase2Bans: [[], []], phase2Banned: [[], []],
      phase3Choice: [null, null], champions: [null, null],
      locked: [false, false],
      specPrefs: [{}, {}],
      timerRef: null, timerEnd: null,
      // Standard draft fields (initialized on start)
      std: null,
      // Duel mode fields
      duelPoolSize: 3, // configurable by host (2-6)
      globalBans: [], // heroes banned from entire event by host
    };
    lobbies.set(code, lobby);
    myLobby = code;
    socket.join(code);
    socket.emit("lobbyCreated", { code });
    broadcast(lobby);
  });

  socket.on("queryLobby", ({ code }) => {
    const c = code.toUpperCase();
    const lobby = lobbies.get(c);
    if (!lobby) return socket.emit("lobbyInfo", { error: "Lobby not found." });
    socket.emit("lobbyInfo", {
      code: c,
      mode: lobby.mode,
      teamNames: lobby.mode === "duel"
        ? [lobby.captains[0]?.name || "Player 1", lobby.captains[1]?.name || "Player 2"]
        : lobby.teamNames,
      captains: [lobby.captains[0] ? true : false, lobby.captains[1] ? true : false],
    });
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
    // In duel mode, auto-assign as captain if a slot is open
    if (lobby.mode === "duel" && lobby.phase === "waiting") {
      if (!lobby.captains[1]) {
        lobby.captains[1] = { id: socket.id, name };
        myLobby = c; socket.join(c);
        socket.emit("joined", { code: c, role: "captain" });
        broadcast(lobby); return;
      } else if (!lobby.captains[0]) {
        lobby.captains[0] = { id: socket.id, name };
        myLobby = c; socket.join(c);
        socket.emit("joined", { code: c, role: "captain" });
        broadcast(lobby); return;
      }
    }
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

  socket.on("updatePoolSize", ({ size }) => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby || socket.id !== lobby.hostId || lobby.phase !== "waiting" || lobby.mode !== "duel") return;
    lobby.duelPoolSize = Math.min(6, Math.max(2, Math.round(size)));
    broadcast(lobby);
  });

  socket.on("updateGlobalBans", ({ heroes }) => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby || socket.id !== lobby.hostId || lobby.phase !== "waiting") return;
    // Validate heroes — only allow real hero names
    lobby.globalBans = [...new Set(heroes)].filter(h => HEROES.includes(h));
    broadcast(lobby);
  });

  socket.on("startDraft", () => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby || socket.id !== lobby.hostId) return;
    if (!lobby.captains[0] || !lobby.captains[1]) return socket.emit("err", "Need 2 captains.");
    if (!lobby.ready[0] || !lobby.ready[1]) return socket.emit("err", "Both captains must be ready.");
    if (lobby.mode === "standard") startStdDraft(lobby);
    else startPhase1(lobby); // works for both "phase" and "duel"
  });

  // ── Phase Draft Actions ──
  socket.on("lockPicks", ({ heroes }) => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby || (lobby.mode !== "phase" && lobby.mode !== "duel") || lobby.phase !== "phase1") return;
    const t = lobby.captains[0]?.id === socket.id ? 0 : lobby.captains[1]?.id === socket.id ? 1 : -1;
    if (t === -1 || lobby.locked[t]) return;
    const maxPicks = lobby.mode === "duel" ? lobby.duelPoolSize : 6;
    const availableHeroes = HEROES.filter(h => !lobby.globalBans.includes(h));
    lobby.picks[t] = [...new Set(heroes)].filter(h => availableHeroes.includes(h)).slice(0, maxPicks);
    lobby.locked[t] = true;
    broadcast(lobby); checkBothLocked(lobby);
  });

  socket.on("lockBans", ({ heroes }) => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby || (lobby.mode !== "phase" && lobby.mode !== "duel") || lobby.phase !== "phase2") return;
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
    if (!lobby || (lobby.mode !== "phase" && lobby.mode !== "duel") || lobby.phase !== "phase3") return;
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
    if (!lobby) return;
    // In duel mode, either captain can advance (no spectators to manage)
    const isDuel = lobby.mode === "duel";
    const isCaptain = lobby.captains[0]?.id === socket.id || lobby.captains[1]?.id === socket.id;
    if (!isDuel && socket.id !== lobby.hostId) return;
    if (isDuel && !isCaptain) return;
    if (lobby.phase === "phase1_reveal") startPhase2(lobby);
    else if (lobby.phase === "phase2_reveal") startPhase3(lobby);
  });

  socket.on("resetDraft", () => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby) return;
    // In duel mode, either captain can reset
    const isDuel = lobby.mode === "duel";
    const isCaptain = lobby.captains[0]?.id === socket.id || lobby.captains[1]?.id === socket.id;
    if (!isDuel && socket.id !== lobby.hostId) return;
    if (isDuel && !isCaptain) return;
    clearTimer(lobby); lobby.phase = "waiting";
    lobby.ready = [false, false]; lobby.std = null;
    broadcast(lobby);
  });

  // ── Tournament Handlers ──
  socket.on("createTourney", ({ name, hostName, format, draftMode, bestOf, maxPlayers, globalBans, timerDuration, duelPoolSize, hostPlaying }) => {
    const code = genTourneyCode();
    const isPlaying = hostPlaying !== false; // default true
    const tourney = {
      code,
      hostId: socket.id,
      name: name || "Tournament",
      format: format || "double_elim", // "double_elim" or "round_robin"
      draftMode: draftMode || "duel", // "phase", "standard", or "duel"
      bestOf: Math.min(5, Math.max(1, bestOf || 1)),
      maxPlayers: Math.min(32, Math.max(2, maxPlayers || 8)),
      globalBans: [...new Set(globalBans || [])].filter(h => HEROES.includes(h)),
      timerDuration: timerDuration || 60,
      duelPoolSize: Math.min(6, Math.max(2, duelPoolSize || 3)),
      phase: "lobby",
      hostPlaying: isPlaying,
      players: isPlaying ? [{ id: socket.id, name: hostName || "Host", isPlayer: true }] : [{ id: socket.id, name: hostName || "Host", isPlayer: false }],
      chat: [],
      coinStreaks: {}, // playerId -> best streak
    };
    tournaments.set(code, tourney);
    myTourney = code;
    socket.join("t_" + code);
    socket.emit("tourneyCreated", { code });
    broadcastTourney(tourney);
  });

  socket.on("joinTourney", ({ code, name }) => {
    const c = code.toUpperCase();
    const tourney = tournaments.get(c);
    if (!tourney) return socket.emit("err", "Tournament not found.");
    if (tourney.phase !== "lobby") return socket.emit("err", "Tournament already started.");
    if (findTourneyPlayer(tourney, socket.id)) { broadcastTourney(tourney); return; }
    if (tourney.players.length >= tourney.maxPlayers) return socket.emit("err", "Tournament is full.");
    tourney.players.push({ id: socket.id, name: name || "Player", isPlayer: true });
    myTourney = c;
    socket.join("t_" + c);
    socket.emit("tourneyJoined", { code: c });
    // System message
    tourney.chat.push({ from: null, text: `${name || "Player"} joined the tournament`, ts: Date.now() });
    broadcastTourney(tourney);
  });

  socket.on("tourneyChat", ({ text }) => {
    if (!myTourney) return;
    const tourney = tournaments.get(myTourney);
    if (!tourney) return;
    const me = findTourneyPlayer(tourney, socket.id);
    if (!me) return;
    const msg = (text || "").slice(0, 200).trim();
    if (!msg) return;
    tourney.chat.push({ from: me.name, text: msg, ts: Date.now() });
    if (tourney.chat.length > 100) tourney.chat = tourney.chat.slice(-100);
    broadcastTourney(tourney);
  });

  socket.on("coinFlip", () => {
    if (!myTourney) return;
    const tourney = tournaments.get(myTourney);
    if (!tourney) return;
    const me = findTourneyPlayer(tourney, socket.id);
    if (!me) return;
    const isHeads = Math.random() < 0.5;
    // Track streak per player
    if (!me._coinCurrent) me._coinCurrent = 0;
    if (isHeads) {
      me._coinCurrent++;
      const best = tourney.coinStreaks[socket.id] || 0;
      if (me._coinCurrent > best) tourney.coinStreaks[socket.id] = me._coinCurrent;
    } else {
      me._coinCurrent = 0;
    }
    // Send result to the flipper with their current streak
    socket.emit("coinResult", {
      heads: isHeads,
      currentStreak: me._coinCurrent,
      bestStreak: tourney.coinStreaks[socket.id] || 0,
    });
    // Broadcast updated leaderboard to everyone
    broadcastTourney(tourney);
  });

  socket.on("updateTourney", ({ field, value }) => {
    if (!myTourney) return;
    const tourney = tournaments.get(myTourney);
    if (!tourney || socket.id !== tourney.hostId || tourney.phase !== "lobby") return;
    if (field === "name") tourney.name = (value || "Tournament").slice(0, 40);
    else if (field === "format") tourney.format = ["double_elim", "round_robin"].includes(value) ? value : tourney.format;
    else if (field === "draftMode") tourney.draftMode = ["phase", "standard", "duel"].includes(value) ? value : tourney.draftMode;
    else if (field === "bestOf") tourney.bestOf = Math.min(5, Math.max(1, parseInt(value) || 1));
    else if (field === "maxPlayers") tourney.maxPlayers = Math.min(32, Math.max(2, parseInt(value) || 8));
    else if (field === "globalBans") tourney.globalBans = [...new Set(value || [])].filter(h => HEROES.includes(h));
    else if (field === "timerDuration") tourney.timerDuration = Math.min(300, Math.max(10, Math.round((parseInt(value) || 60) / 10) * 10));
    else if (field === "duelPoolSize") tourney.duelPoolSize = Math.min(6, Math.max(2, parseInt(value) || 3));
    else if (field === "hostPlaying") {
      tourney.hostPlaying = !!value;
      const host = tourney.players.find(p => p.id === tourney.hostId);
      if (host) host.isPlayer = !!value;
    }
    broadcastTourney(tourney);
  });

  socket.on("queryTourney", ({ code }) => {
    const c = code.toUpperCase();
    const tourney = tournaments.get(c);
    if (!tourney) return socket.emit("tourneyInfo", { error: "Tournament not found." });
    socket.emit("tourneyInfo", {
      code: c,
      name: tourney.name,
      playerCount: tourney.players.length,
      maxPlayers: tourney.maxPlayers,
      phase: tourney.phase,
    });
  });

  // ── Bracket Handlers ──
  socket.on("startTournament", () => {
    if (!myTourney) return;
    const tourney = tournaments.get(myTourney);
    if (!tourney || socket.id !== tourney.hostId || tourney.phase !== "lobby") return;

    // Get participating player names
    const playerNames = tourney.players.filter(p => p.isPlayer).map(p => p.name);
    if (playerNames.length < 2) return socket.emit("err", "Need at least 2 players.");

    // Generate bracket
    tourney.bracket = generateDoubleElimBracket(playerNames);
    tourney.eliminated = [];
    tourney.revealQueue = [];
    tourney.revealIndex = 0;
    tourney.phase = "bracket";

    // Propagate BYE winners and activate first wave
    propagateBracket(tourney);
    activateWave(tourney);

    // Broadcast with bracket data
    broadcastTourneyBracket(tourney);
  });

  socket.on("tourneyReadyUp", () => {
    if (!myTourney) return;
    const tourney = tournaments.get(myTourney);
    if (!tourney || tourney.phase !== "bracket") return;
    const me = findTourneyPlayer(tourney, socket.id);
    if (!me || !me.isPlayer) return;

    const match = findPlayerMatch(tourney, me.name);
    if (!match || match.status !== "ready_check") return;

    const slot = playerSlotInMatch(match, me.name);
    if (slot === -1) return;
    match.readyState[slot] = true;

    // Check if both ready
    if (match.readyState[0] && match.readyState[1]) {
      // Create a draft lobby for this match
      const draftCode = genCode();
      const draftMode = tourney.draftMode;
      const lobby = {
        code: draftCode, hostId: null,
        mode: draftMode,
        timerDuration: tourney.timerDuration,
        phase: "waiting",
        teamNames: [match.slots[0], match.slots[1]],
        captains: [null, null],
        ready: [false, false],
        spectators: [[], []],
        unassigned: [],
        picks: [[], []], pools: [[], []], origPicks: [[], []],
        bans: new Set(), overlaps: [],
        phase2Bans: [[], []], phase2Banned: [[], []],
        phase3Choice: [null, null], champions: [null, null],
        locked: [false, false],
        specPrefs: [{}, {}],
        timerRef: null, timerEnd: null,
        std: null,
        duelPoolSize: tourney.duelPoolSize,
        globalBans: [...tourney.globalBans],
        tourneyMatch: { tourneyCode: tourney.code, matchId: match.id },
      };
      lobbies.set(draftCode, lobby);
      match.draftCode = draftCode;
      match.status = "drafting";

      // Broadcast bracket first so clients have updated state for the countdown preview
      broadcastTourneyBracket(tourney);

      // Then notify players to join the draft (client shows bracket for 7s first)
      for (const p of tourney.players) {
        if (p.name === match.slots[0] || p.name === match.slots[1]) {
          io.to(p.id).emit("tourneyDraftStart", {
            draftCode,
            matchId: match.id,
            opponent: p.name === match.slots[0] ? match.slots[1] : match.slots[0],
            slot: p.name === match.slots[0] ? 0 : 1,
          });
        }
      }
    } else {
      broadcastTourneyBracket(tourney);
    }
  });

  socket.on("joinTourneyDraft", ({ draftCode, slot }) => {
    const lobby = lobbies.get(draftCode);
    if (!lobby || !lobby.tourneyMatch) return;
    if (!myTourney) return;
    const tourney = tournaments.get(myTourney);
    if (!tourney) return;
    const me = findTourneyPlayer(tourney, socket.id);
    if (!me) return;

    // Assign player as captain in the draft
    const t = slot === 0 ? 0 : 1;
    if (lobby.captains[t]) return; // already filled
    lobby.captains[t] = { id: socket.id, name: me.name };
    lobby.ready[t] = true; // auto-ready in tournament
    myLobby = draftCode;
    socket.join(draftCode);

    // If both captains joined, auto-start
    if (lobby.captains[0] && lobby.captains[1]) {
      if (lobby.mode === "standard") startStdDraft(lobby);
      else startPhase1(lobby);
    }

    broadcast(lobby);
  });

  socket.on("tourneyVoteWinner", ({ matchId, winner }) => {
    if (!myTourney) return;
    const tourney = tournaments.get(myTourney);
    if (!tourney || tourney.phase !== "bracket") return;
    const me = findTourneyPlayer(tourney, socket.id);
    if (!me || !me.isPlayer) return;

    const match = tourney.bracket.matches.find(m => m.id === matchId);
    if (!match || match.status !== "voting") return;
    if (!match.slots.includes(winner)) return;

    const slot = playerSlotInMatch(match, me.name);
    if (slot === -1) return;
    match.votes[slot] = winner;

    // Check if both voted
    if (match.votes[0] !== null && match.votes[1] !== null) {
      if (match.votes[0] === match.votes[1]) {
        // Agreement — resolve match
        resolveMatch(tourney, match, match.votes[0]);
      } else {
        // Dispute — host decides
        match.status = "dispute";
      }
    }

    broadcastTourneyBracket(tourney);
  });

  socket.on("tourneyHostDecide", ({ matchId, winner }) => {
    if (!myTourney) return;
    const tourney = tournaments.get(myTourney);
    if (!tourney || socket.id !== tourney.hostId) return;

    const match = tourney.bracket.matches.find(m => m.id === matchId);
    if (!match || match.status !== "dispute") return;
    if (!match.slots.includes(winner)) return;

    resolveMatch(tourney, match, winner);
    broadcastTourneyBracket(tourney);
  });

  socket.on("advanceReveal", () => {
    if (!myTourney) return;
    const tourney = tournaments.get(myTourney);
    if (!tourney || socket.id !== tourney.hostId || tourney.phase !== "reveal") return;

    tourney.revealIndex++;
    if (tourney.revealIndex >= tourney.revealQueue.length) {
      // All revealed — propagate and start next wave
      tourney.phase = "bracket";
      tourney.revealQueue = [];
      tourney.revealIndex = 0;

      propagateBracket(tourney);
      const wave = activateWave(tourney);

      if (isTourneyComplete(tourney)) {
        tourney.phase = "complete";
      } else if (wave.length === 0) {
        // No new matches — might need another propagation cycle
        propagateBracket(tourney);
        const wave2 = activateWave(tourney);
        if (wave2.length === 0 && isTourneyComplete(tourney)) {
          tourney.phase = "complete";
        }
      }
    }

    broadcastTourneyBracket(tourney);
  });

  socket.on("disconnect", () => {
    // Tournament disconnect
    if (myTourney) {
      const tourney = tournaments.get(myTourney);
      if (tourney && tourney.phase === "lobby") {
        const me = findTourneyPlayer(tourney, socket.id);
        tourney.players = tourney.players.filter(p => p.id !== socket.id);
        if (tourney.players.length === 0) { tournaments.delete(myTourney); }
        else {
          if (socket.id === tourney.hostId) tourney.hostId = tourney.players[0].id;
          if (me) tourney.chat.push({ from: null, text: `${me.name} left the tournament`, ts: Date.now() });
          broadcastTourney(tourney);
        }
      }
    }

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
