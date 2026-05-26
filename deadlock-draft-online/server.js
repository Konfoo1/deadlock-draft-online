/**
 * @fileoverview Deadlock Draft Tool — Multiplayer Server.
 *
 * A real-time multiplayer hero draft server for Deadlock custom games, built
 * with Express and Socket.IO. Supports three game modes:
 *
 * - **Phase Draft ("Clone Wars")**: Simultaneous secret picks with overlap
 *   banning, followed by targeted bans and a final champion selection.
 * - **Standard Draft**: Classic alternating pick/ban turns with a snake draft
 *   order, base timers, and reserve time banks.
 * - **Duel Mode**: A streamlined 1v1 variant of the phase draft with
 *   configurable pool sizes and no overlap banning.
 *
 * Additionally supports a full **Tournament System** with double-elimination
 * brackets, ready checks, automatic match creation, voting/dispute resolution,
 * and a reveal sequence for completed matches.
 *
 * Architecture Overview:
 *   - Express serves static files from `./public`.
 *   - Socket.IO handles all real-time lobby/tournament communication.
 *   - Lobbies and tournaments are stored in-memory Maps (no persistence).
 *   - Each client receives a filtered state object via {@link stateFor} or
 *     {@link tourneyBracketStateFor} to prevent information leaks.
 *
 * @module server
 * @requires express
 * @requires http
 * @requires socket.io
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

// ═══════════════════════════════════════════════════════════
//  HEROES — fetched from Deadlock Assets API at startup
// ═══════════════════════════════════════════════════════════

/**
 * Sorted roster of all playable Deadlock heroes (display names).
 * Populated at startup from the Deadlock Assets API; falls back to a
 * hardcoded list if the API is unreachable.
 * @type {string[]}
 */
let HEROES = [
  "Abrams","Apollo","Bebop","Billy","Calico","Celeste","Drifter","Doorman","Dynamo",
  "Graves","Grey Talon","Haze","Holliday","Infernus",
  "Ivy","Kelvin","Lady Geist","Lash","McGinnis","Mina",
  "Mirage","Mo & Krill","Paige","Paradox","Pocket","Rem","Seven",
  "Shiv","Sinclair","Silver","Venator","Victor","Vindicta","Viscous",
  "Vyper","Warden","Wraith","Yamato",
].sort();

/**
 * Mapping of hero display name → card image URL from the Deadlock Assets API.
 * Used by clients to render hero portraits. Falls back to wiki URLs if empty.
 * @type {Object<string, string>}
 */
let HERO_IMAGES = {};

/**
 * Fetch hero roster and image URLs from the Deadlock Assets API.
 * Updates HEROES and HERO_IMAGES on success; logs warning on failure.
 * Called at startup and can be refreshed periodically.
 */
async function fetchHeroData() {
  try {
    const res = await fetch("https://assets.deadlock-api.com/v2/heroes?only_active=true");
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    const heroes = await res.json();
    const names = [];
    const images = {};
    for (const hero of heroes) {
      if (!hero.name || hero.disabled) continue;
      names.push(hero.name);
      // Prefer webp card image, fall back to png
      const img = hero.images?.icon_hero_card_webp
        || hero.images?.icon_hero_card
        || null;
      if (img) images[hero.name] = img;
    }
    if (names.length > 0) {
      HEROES = names.sort();
      HERO_IMAGES = images;
      console.log(`[HeroData] Loaded ${HEROES.length} heroes from Deadlock API`);
    }
  } catch (err) {
    console.warn(`[HeroData] Failed to fetch from API, using fallback list: ${err.message}`);
  }
}

// Fetch hero data on startup, refresh every 6 hours
fetchHeroData();
setInterval(fetchHeroData, 6 * 60 * 60 * 1000);

/**
 * API endpoint: returns the current hero roster and image map.
 * Clients can fetch this on load to stay in sync without hardcoding.
 */
app.get("/api/heroes", (req, res) => {
  res.json({ heroes: HEROES, images: HERO_IMAGES });
});

// ═══════════════════════════════════════════════════════════
//  STANDARD DRAFT TURN ORDER
// ═══════════════════════════════════════════════════════════

/**
 * Turn sequence for the Standard draft mode.
 *
 * A 16-turn snake draft: BAN BAN | PICK x6 | BAN BAN | PICK x6.
 * Each entry specifies the action type and which team acts.
 *
 * @const {Array<{type: string, team: number}>}
 */
const STD_TURNS = [
  // Ban Phase 1
  {type:"ban",team:0},{type:"ban",team:1},
  // Pick Phase 1 — snake order (6 picks, 3 per team)
  {type:"pick",team:0},{type:"pick",team:1},{type:"pick",team:1},{type:"pick",team:0},
  {type:"pick",team:0},{type:"pick",team:1},
  // Ban Phase 2
  {type:"ban",team:0},{type:"ban",team:1},
  // Pick Phase 2 — snake order (6 picks, 3 per team)
  {type:"pick",team:0},{type:"pick",team:1},{type:"pick",team:1},{type:"pick",team:0},
  {type:"pick",team:0},{type:"pick",team:1},
];

// ═══════════════════════════════════════════════════════════
//  LOBBIES
// ═══════════════════════════════════════════════════════════

/**
 * In-memory store of all active draft lobbies, keyed by lobby code.
 * @type {Map<string, LobbyState>}
 */
const lobbies = new Map();

/**
 * @typedef {Object} LobbyState
 * @property {string} code - Unique 4-character alphanumeric lobby code.
 * @property {string} hostId - Socket ID of the lobby creator/host.
 * @property {string} mode - Draft mode: 'phase', 'standard', or 'duel'.
 * @property {number} timerDuration - Phase timer duration in seconds.
 * @property {string} phase - Current lobby phase (e.g., 'waiting', 'phase1',
 *   'phase2', 'std_drafting', 'complete').
 * @property {string[]} teamNames - Display names for [Team 0, Team 1].
 * @property {Array<?{id: string, name: string}>} captains - Captain info
 *   per team slot; null if unfilled.
 * @property {boolean[]} ready - Ready status for each captain.
 * @property {Array<Array<{id: string, name: string}>>} spectators - Spectators
 *   per team.
 * @property {Array<{id: string, name: string}>} unassigned - Players not yet
 *   assigned to a team.
 * @property {Array<string[]>} picks - Heroes picked per team during phase drafts.
 * @property {Array<string[]>} pools - Remaining hero pools per team after
 *   overlap/ban processing.
 * @property {Array<string[]>} origPicks - Original (pre-ban) picks per team.
 * @property {Set<string>} bans - Set of all globally banned hero names.
 * @property {string[]} overlaps - Heroes that both teams picked (auto-banned).
 * @property {Array<string[]>} phase2Bans - Phase 2 ban selections per team.
 * @property {Array<string[]>} phase2Banned - Finalized phase 2 bans per team.
 * @property {Array<?string>} phase3Choice - Final champion choice per team.
 * @property {Array<?string>} champions - Confirmed champions per team.
 * @property {boolean[]} locked - Whether each team has locked in their current
 *   phase selections.
 * @property {Array<Object<string, number>>} specPrefs - Spectator hero
 *   preference votes per team.
 * @property {?number} timerRef - Active setTimeout reference for the phase timer.
 * @property {?number} timerEnd - Unix timestamp when the current timer expires.
 * @property {?StdDraftState} std - Standard draft state (null unless mode is
 *   'standard').
 * @property {number} duelPoolSize - Hero pool size for duel mode (2-6).
 * @property {string[]} globalBans - Heroes banned from the entire lobby by host.
 * @property {Array<{from: string, text: string, ts: number}>} chat - Lobby-wide
 *   chat message history.
 * @property {Object<string, number>} coinStreaks - Best coin flip streak per
 *   socket ID.
 * @property {Array<Array<{from: string, text: string, ts: number}>>} teamChat -
 *   Per-team private chat messages.
 * @property {Array<Array<{name: string, heroes: string[]}>>} ghostPlayers -
 *   Absent player placeholder slots per team.
 */

/**
 * @typedef {Object} StdDraftState
 * @property {number} step - Current step index into STD_TURNS.
 * @property {Array<string[]>} bans - Banned heroes per team.
 * @property {Array<string[]>} picks - Picked heroes per team.
 * @property {Array<Array<?string>>} playerAssignments - Player name assigned
 *   to each pick, per team. Null entries indicate unassigned picks.
 * @property {number} baseTime - Base timer duration per turn in seconds.
 * @property {number[]} reserve - Remaining reserve time per team in seconds.
 * @property {number} turnStart - Unix timestamp of when the current turn began.
 * @property {boolean} inReserve - Whether the active turn has entered reserve time.
 */

/**
 * Generate a unique 4-character alphanumeric lobby code.
 *
 * Uses a character set that excludes ambiguous characters (I, O, 0, 1).
 * Recursively generates a new code if a collision is detected.
 *
 * @returns {string} A unique lobby code (e.g., 'AB3K').
 */
function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return lobbies.has(code) ? genCode() : code;
}

/**
 * Calculate the number of bans allowed against a hero pool.
 *
 * Returns ``poolSize - 2`` (minimum 0), ensuring at least 2 heroes remain
 * in the pool after banning.
 *
 * @param {number} poolSize - The number of heroes in the target pool.
 * @returns {number} The number of bans allowed.
 */
function banCount(poolSize) { return Math.max(0, poolSize - 2); }

// ═══════════════════════════════════════════════════════════
//  FIND PLAYER IN LOBBY
// ═══════════════════════════════════════════════════════════

/**
 * Locate a player within a lobby by their socket ID.
 *
 * Searches captains, spectators, and unassigned players in order.
 *
 * @param {LobbyState} lobby - The lobby to search.
 * @param {string} sid - The socket ID to find.
 * @returns {?{role: string, team?: number, idx?: number}} Player descriptor
 *   with their role ('captain', 'spectator', or 'unassigned'), team index,
 *   and array index where applicable. Returns null if not found.
 */
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

/**
 * Build a role-filtered state snapshot for a specific client.
 *
 * Each player receives only the information they should see based on their
 * role (captain, spectator, or unassigned) and team assignment. This prevents
 * information leaks (e.g., seeing the opponent's secret picks during Phase 1).
 *
 * For Standard draft mode, enemy player assignments are hidden until the
 * draft is complete.
 *
 * @param {LobbyState} lobby - The lobby to generate state for.
 * @param {string} sid - The socket ID of the requesting client.
 * @returns {Object} A sanitized state object safe to send to the client.
 */
function stateFor(lobby, sid) {
  const me = findPerson(lobby, sid);
  const role = me?.role || "unknown";
  const myTeam = (role === "captain" || role === "spectator") ? me.team : -1;
  const oppTeam = myTeam === 0 ? 1 : 0;

  // In duel mode, use actual captain names as team names.
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
    heroImages: HERO_IMAGES,
    globalBans: lobby.globalBans,
    duelPoolSize: lobby.duelPoolSize,
    specPrefs: lobby.specPrefs,
    chat: lobby.chat || [],
    coinStreaks: lobby.coinStreaks || {},
    ghostPlayers: lobby.ghostPlayers || [[], []],
    teamChat: myTeam >= 0 ? (lobby.teamChat?.[myTeam] || []) : [],
    teamChat0: (role === "unassigned") ? (lobby.teamChat?.[0] || []) : undefined,
    teamChat1: (role === "unassigned") ? (lobby.teamChat?.[1] || []) : undefined,
  };

  // ── PHASE DRAFT (Clone Wars) + DUEL MODE ──
  if (lobby.mode === "phase" || lobby.mode === "duel") {
    s.bans = [...lobby.bans];

    // Phase 1: Secret hero picking — only show your own team's picks.
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
        // Unassigned viewers can see lock status but not picks.
        s.myPicks = [];
        s.myLocked = false; s.oppLocked = false;
        s.locked0 = lobby.locked[0]; s.locked1 = lobby.locked[1];
      }
    }

    // Phases after Phase 1 reveal: pools, overlaps, and original picks visible.
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

    // Phase 2: Ban opponent's heroes — show ban targets and lock state.
    if (lobby.phase === "phase2") {
      if (role === "captain" && myTeam >= 0) {
        s.banTarget = banCount(lobby.pools[oppTeam]?.length || 0);
        s.myBans = lobby.phase2Bans[myTeam] || [];
        s.myLocked = lobby.locked[myTeam];
        s.oppLocked = lobby.locked[oppTeam];
      }
    }

    // Phase 2 reveal onward: show which heroes were banned.
    if (["phase2_reveal","phase3","complete"].includes(lobby.phase)) {
      s.phase2Banned = lobby.phase2Banned || [[], []];
    }

    // Phase 3: Final champion selection.
    if (lobby.phase === "phase3") {
      if (role === "captain" && myTeam >= 0) {
        s.myChoice = lobby.phase3Choice[myTeam];
        s.myLocked = lobby.locked[myTeam];
        s.oppLocked = lobby.locked[oppTeam];
        s.skipPhase3 = (lobby.pools[myTeam]?.length || 0) <= 1;
      }
    }

    // Complete: reveal champions to everyone.
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
    // Hide enemy player assignments during draft; reveal all on completion.
    const draftComplete = st.step >= STD_TURNS.length;
    let assignments;
    if (draftComplete || myTeam < 0) {
      assignments = [st.playerAssignments?.[0] || [], st.playerAssignments?.[1] || []];
    } else {
      const myAssignments = st.playerAssignments?.[myTeam] || [];
      const oppAssignments = (st.playerAssignments?.[oppTeam] || []).map(() => null);
      assignments = myTeam === 0 ? [myAssignments, oppAssignments]
                  : [oppAssignments, myAssignments];
    }

    s.std = {
      step: st.step,
      turns: STD_TURNS,
      bans: [[...st.bans[0]], [...st.bans[1]]],
      picks: [[...st.picks[0]], [...st.picks[1]]],
      totalSteps: STD_TURNS.length,
      playerAssignments: assignments,
      reserve: [...st.reserve],
      baseTime: st.baseTime,
      inReserve: st.inReserve || false,
    };
    if (st.step < STD_TURNS.length) {
      s.std.activeTurn = STD_TURNS[st.step];
    }
  }

  // Filler players (pad to 6 per team for display)
  s.fillerPlayers = lobby.fillerPlayers || [[], []];

  // Resolve per-player hero preferences — map socket IDs to player names.
  /**
   * Resolve player preferences for a team, converting socket IDs to names.
   * @param {number} teamIdx - The team index to resolve preferences for.
   * @returns {Object<string, string[]>} Map of player name to preferred heroes.
   */
  function resolvePrefs(teamIdx) {
    const raw = lobby.playerPrefs?.[teamIdx] || {};
    const resolved = {};
    for (const [sid, heroes] of Object.entries(raw)) {
      let name = null;
      if (lobby.captains[teamIdx]?.id === sid) name = lobby.captains[teamIdx].name;
      else {
        const sp = lobby.spectators[teamIdx].find(p => p.id === sid);
        if (sp) name = sp.name;
      }
      if (name && heroes.length > 0) resolved[name] = heroes;
    }
    return resolved;
  }
  if (myTeam >= 0) {
    s.playerPrefs = resolvePrefs(myTeam);
  } else {
    s.playerPrefs0 = resolvePrefs(0);
    s.playerPrefs1 = resolvePrefs(1);
  }

  return s;
}

/**
 * Broadcast the current lobby state to all connected players.
 *
 * Each player receives a personalized state object via {@link stateFor}
 * that is filtered to their role and team.
 *
 * @param {LobbyState} lobby - The lobby to broadcast.
 */
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

/**
 * Start a countdown timer for a lobby phase.
 *
 * Clears any existing timer, sets the expiration timestamp, and schedules
 * the callback to fire when time runs out.
 *
 * @param {LobbyState} lobby - The lobby to start the timer for.
 * @param {Function} onExpire - Callback invoked when the timer expires.
 */
function startTimer(lobby, onExpire) {
  clearTimer(lobby);
  lobby.timerEnd = Date.now() + lobby.timerDuration * 1000;
  lobby.timerRef = setTimeout(() => {
    lobby.timerRef = null; lobby.timerEnd = null; onExpire();
  }, lobby.timerDuration * 1000);
}

/**
 * Cancel any active timer for a lobby and reset timer state.
 * @param {LobbyState} lobby - The lobby whose timer to clear.
 */
function clearTimer(lobby) {
  if (lobby.timerRef) { clearTimeout(lobby.timerRef); lobby.timerRef = null; }
  lobby.timerEnd = null;
}

// ═══════════════════════════════════════════════════════════
//  PHASE DRAFT LOGIC (Clone Wars)
// ═══════════════════════════════════════════════════════════

/**
 * Initialize and start Phase 1 of a phase/duel draft.
 *
 * Resets all draft state (picks, pools, bans, etc.), starts the phase timer,
 * and broadcasts the updated state to all clients.
 *
 * @param {LobbyState} lobby - The lobby to start Phase 1 in.
 */
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

/**
 * Finalize Phase 1 by processing picks, detecting overlaps, and building pools.
 *
 * If a team didn't select enough heroes (timer expired), random heroes are
 * added to fill their pool. In standard phase mode, overlapping picks between
 * teams are banned. In duel mode, overlaps are noted but not banned.
 *
 * Transitions the lobby to the 'phase1_reveal' phase.
 *
 * @param {LobbyState} lobby - The lobby to finalize Phase 1 for.
 */
function finishPhase1(lobby) {
  clearTimer(lobby);
  const isDuel = lobby.mode === "duel";
  const poolSize = isDuel ? lobby.duelPoolSize : 6;
  const availableHeroes = HEROES.filter(h => !lobby.globalBans.includes(h));

  // Fill incomplete picks with random heroes.
  for (let t = 0; t < 2; t++) {
    const have = new Set(lobby.picks[t]);
    const allPicked = isDuel ? new Set(lobby.picks[t]) : new Set([...lobby.picks[0], ...lobby.picks[1]]);
    while (have.size < poolSize) {
      const avail = availableHeroes.filter(h => !have.has(h) && (isDuel || !allPicked.has(h)));
      if (!avail.length) break;
      const pick = avail[Math.floor(Math.random() * avail.length)];
      have.add(pick); if (!isDuel) allPicked.add(pick);
    }
    lobby.picks[t] = [...have]; lobby.origPicks[t] = [...lobby.picks[t]];
  }

  // Detect and handle overlapping picks.
  if (isDuel) {
    const set0 = new Set(lobby.picks[0]);
    lobby.overlaps = lobby.picks[1].filter(h => set0.has(h));
    // Duel mode: overlaps noted but NOT banned.
    for (let t = 0; t < 2; t++) lobby.pools[t] = [...lobby.picks[t]];
  } else {
    const set0 = new Set(lobby.picks[0]);
    lobby.overlaps = lobby.picks[1].filter(h => set0.has(h));
    for (const h of lobby.overlaps) lobby.bans.add(h);
    for (let t = 0; t < 2; t++) lobby.pools[t] = lobby.picks[t].filter(h => !lobby.bans.has(h));
  }

  lobby.locked = [false, false];
  lobby.phase = "phase1_reveal";
  broadcast(lobby);
}

/**
 * Start Phase 2 (ban opponent's heroes).
 *
 * If both teams already have 2 or fewer heroes in their pools, skips directly
 * to Phase 3. Otherwise, initializes ban state, auto-locks teams that have
 * no bans to make, starts the timer, and broadcasts.
 *
 * @param {LobbyState} lobby - The lobby to start Phase 2 in.
 */
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

/**
 * Finalize Phase 2 by applying bans to opponent pools.
 *
 * Fills any incomplete ban selections with random choices from the opponent's
 * pool. Removes banned heroes from pools and transitions to 'phase2_reveal'.
 *
 * @param {LobbyState} lobby - The lobby to finalize Phase 2 for.
 */
function finishPhase2(lobby) {
  clearTimer(lobby);
  const availableHeroes = HEROES.filter(h => !lobby.globalBans.includes(h));
  // Fill incomplete bans with random selections.
  for (let t = 0; t < 2; t++) {
    const oppT = 1 - t;
    const need = banCount(lobby.pools[oppT].length);
    if (lobby.phase2Bans[t].length < need) {
      const pool = lobby.pools[oppT].filter(h => !lobby.phase2Bans[t].includes(h) && availableHeroes.includes(h));
      const shuffled = pool.sort(() => Math.random() - 0.5);
      while (lobby.phase2Bans[t].length < need && shuffled.length) lobby.phase2Bans[t].push(shuffled.pop());
    }
  }
  // Apply bans to opponent pools.
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

/**
 * Start Phase 3 (final champion selection).
 *
 * Auto-selects and locks the champion for any team with only 1 hero remaining
 * in their pool. If both teams are auto-resolved, immediately completes the
 * draft. Otherwise, starts the timer for manual selection.
 *
 * @param {LobbyState} lobby - The lobby to start Phase 3 in.
 */
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

/**
 * Finalize Phase 3 by resolving any unchosen champions with random picks.
 *
 * Sets the lobby to 'complete' and triggers tournament callbacks if applicable.
 *
 * @param {LobbyState} lobby - The lobby to finalize Phase 3 for.
 */
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

/**
 * Check if both teams have locked in and auto-advance the phase if so.
 *
 * Called after any lock-in action to detect when both teams are ready
 * to proceed, triggering the appropriate finish function.
 *
 * @param {LobbyState} lobby - The lobby to check.
 */
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

/**
 * Collect all heroes used (banned or picked) in a standard draft.
 *
 * @param {LobbyState} lobby - The lobby with standard draft state.
 * @returns {Set<string>} Set of hero names already in play.
 */
function stdAllUsed(lobby) {
  const st = lobby.std;
  return new Set([...st.bans[0], ...st.bans[1], ...st.picks[0], ...st.picks[1]]);
}

/**
 * Initialize and start a standard (alternating turns) draft.
 *
 * Sets up the draft state with ban/pick arrays, player assignments,
 * timer configuration, filler players (to pad teams to 6), and
 * per-player preference lists.
 *
 * @param {LobbyState} lobby - The lobby to start the standard draft in.
 */
function startStdDraft(lobby) {
  lobby.phase = "std_drafting";
  const baseTime = 30;
  const reserveTime = lobby.timerDuration;
  lobby.std = {
    step: 0,
    bans: [[], []],
    picks: [[], []],
    playerAssignments: [[], []],
    baseTime: baseTime,
    reserve: [reserveTime, reserveTime],
    turnStart: Date.now(),
    inReserve: false,
  };
  lobby.specPrefs = [{}, {}];

  // Generate filler players to pad each team to 6 members.
  lobby.fillerPlayers = [[], []];
  for (let t = 0; t < 2; t++) {
    let realCount = 0;
    if (lobby.captains[t]) realCount++;
    realCount += lobby.spectators[t].length;
    realCount += (lobby.ghostPlayers?.[t] || []).length;
    const needed = Math.max(0, 6 - realCount);
    for (let i = 0; i < needed; i++) {
      lobby.fillerPlayers[t].push({ name: "Player " + (realCount + i + 1) });
    }
  }

  // Initialize per-player hero preference lists (wish lists).
  lobby.playerPrefs = [{}, {}];

  // Start 30-second base timer for the first turn.
  lobby.timerEnd = Date.now() + baseTime * 1000;
  lobby.timerRef = setTimeout(() => stdBaseExpired(lobby), baseTime * 1000);
  broadcast(lobby);
}

/**
 * Handle expiration of the base timer for a standard draft turn.
 *
 * If the active team has reserve time remaining, transitions to reserve time.
 * Otherwise, performs an automatic random action.
 *
 * @param {LobbyState} lobby - The lobby whose base timer expired.
 */
function stdBaseExpired(lobby) {
  const st = lobby.std;
  if (!st || st.step >= STD_TURNS.length) return;
  const turn = STD_TURNS[st.step];
  const team = turn.team;
  if (st.reserve[team] <= 0) {
    stdAutoAction(lobby);
    return;
  }
  // Transition to reserve time.
  st.inReserve = true;
  st.turnStart = Date.now();
  lobby.timerEnd = Date.now() + st.reserve[team] * 1000;
  clearTimeout(lobby.timerRef);
  lobby.timerRef = setTimeout(() => {
    st.reserve[team] = 0;
    stdAutoAction(lobby);
  }, st.reserve[team] * 1000);
  broadcast(lobby);
}

/**
 * Perform an automatic random action when the timer expires with no input.
 *
 * Randomly selects an available hero for the current turn (ban or pick)
 * and assigns picks to a random unassigned team member.
 *
 * @param {LobbyState} lobby - The lobby to auto-act for.
 */
function stdAutoAction(lobby) {
  clearTimer(lobby);
  const st = lobby.std;
  if (st.step >= STD_TURNS.length) return;
  const turn = STD_TURNS[st.step];
  const used = stdAllUsed(lobby);
  const avail = HEROES.filter(h => !used.has(h));
  if (avail.length === 0) { stdFinish(lobby); return; }
  const hero = avail[Math.floor(Math.random() * avail.length)];
  if (turn.type === "ban") {
    st.bans[turn.team].push(hero);
  } else {
    st.picks[turn.team].push(hero);
    if (!st.playerAssignments) st.playerAssignments = [[], []];
    // Auto-assign the pick to a random unassigned team member.
    const assigned = new Set(st.playerAssignments[turn.team].filter(Boolean));
    const teamPlayers = [];
    const cap = lobby.captains[turn.team];
    if (cap) teamPlayers.push(cap.name);
    for (const s of lobby.spectators[turn.team]) teamPlayers.push(s.name);
    if (lobby.ghostPlayers && lobby.ghostPlayers[turn.team]) {
      for (const gp of lobby.ghostPlayers[turn.team]) teamPlayers.push(gp.name);
    }
    if (lobby.fillerPlayers && lobby.fillerPlayers[turn.team]) {
      for (const fp of lobby.fillerPlayers[turn.team]) teamPlayers.push(fp.name);
    }
    const unassigned = teamPlayers.filter(p => !assigned.has(p));
    const pick = unassigned.length > 0 ? unassigned[Math.floor(Math.random() * unassigned.length)] : null;
    st.playerAssignments[turn.team].push(pick);
  }
  stdAdvance(lobby);
}

/**
 * Advance to the next turn in the standard draft.
 *
 * Deducts reserve time if the current turn used it, increments the step,
 * and starts a new base timer. Finishes the draft if all steps are complete.
 *
 * @param {LobbyState} lobby - The lobby to advance.
 */
function stdAdvance(lobby) {
  const st = lobby.std;
  // Deduct elapsed reserve time if applicable.
  if (st.inReserve && st.turnStart) {
    const turn = STD_TURNS[st.step];
    const elapsed = (Date.now() - st.turnStart) / 1000;
    st.reserve[turn.team] = Math.max(0, st.reserve[turn.team] - elapsed);
  }
  st.step++;
  st.inReserve = false;
  if (st.step >= STD_TURNS.length) {
    stdFinish(lobby); return;
  }
  lobby.specPrefs = [{}, {}];
  // Start new turn with base timer.
  st.turnStart = Date.now();
  clearTimeout(lobby.timerRef);
  lobby.timerEnd = Date.now() + st.baseTime * 1000;
  lobby.timerRef = setTimeout(() => stdBaseExpired(lobby), st.baseTime * 1000);
  broadcast(lobby);
}

/**
 * Complete the standard draft and transition to the 'complete' phase.
 *
 * @param {LobbyState} lobby - The lobby to finish.
 */
function stdFinish(lobby) {
  clearTimer(lobby);
  lobby.phase = "complete";
  lobby.champions = [null, null]; // Standard draft has no single champion.
  broadcast(lobby);
  if (lobby.tourneyMatch) onTourneyDraftComplete(lobby);
}

// ═══════════════════════════════════════════════════════════
//  TOURNAMENTS
// ═══════════════════════════════════════════════════════════

/**
 * In-memory store of all active tournaments, keyed by tournament code.
 * @type {Map<string, TourneyState>}
 */
const tournaments = new Map();

/**
 * @typedef {Object} TourneyState
 * @property {string} code - Unique tournament code (e.g., 'TAB3').
 * @property {string} hostId - Socket ID of the tournament creator.
 * @property {string} name - Display name of the tournament.
 * @property {string} format - Bracket format: 'double_elim' or 'round_robin'.
 * @property {string} draftMode - Draft mode used for matches: 'phase',
 *   'standard', or 'duel'.
 * @property {number} bestOf - Best-of series count per match (1-5).
 * @property {number} maxPlayers - Maximum number of players allowed.
 * @property {string[]} globalBans - Heroes banned from all tournament matches.
 * @property {number} timerDuration - Timer duration for each draft phase.
 * @property {number} duelPoolSize - Pool size for duel mode drafts (2-6).
 * @property {string} phase - Tournament phase: 'lobby', 'bracket', 'reveal',
 *   or 'complete'.
 * @property {boolean} hostPlaying - Whether the host participates as a player.
 * @property {Array<{id: string, name: string, isPlayer: boolean}>} players -
 *   All connected tournament participants.
 * @property {Array<{from: ?string, text: string, ts: number}>} chat -
 *   Tournament chat history. `from` is null for system messages.
 * @property {Object<string, number>} coinStreaks - Best coin flip streak per ID.
 * @property {?BracketState} bracket - Generated bracket data (null in lobby).
 * @property {string[]} eliminated - Names of eliminated players.
 * @property {number[]} revealQueue - Match IDs queued for reveal animation.
 * @property {number} revealIndex - Current position in the reveal queue.
 */

/**
 * @typedef {Object} BracketState
 * @property {MatchState[]} matches - All matches in the bracket.
 * @property {Array<number[]>} wbRounds - Match IDs per winners bracket round.
 * @property {Array<number[]>} lbRounds - Match IDs per losers bracket round.
 * @property {number} grandFinalId - Match ID of the grand final.
 */

/**
 * @typedef {Object} MatchState
 * @property {number} id - Unique match ID within the bracket.
 * @property {string} bracket - Bracket position: 'winners', 'losers', or
 *   'grand_final'.
 * @property {number} round - Round number within the bracket section.
 * @property {Array<?string>} slots - Player names in each slot (null = empty/BYE).
 * @property {?string} winner - Name of the match winner (null if incomplete).
 * @property {?string} loser - Name of the match loser (null if incomplete).
 * @property {string} status - Match status: 'pending', 'preview', 'ready_check',
 *   'drafting', 'voting', 'dispute', or 'complete'.
 * @property {boolean[]} readyState - Ready check status per player slot.
 * @property {Array<?string>} votes - Winner vote per player slot.
 * @property {?string} draftCode - Lobby code for this match's draft.
 * @property {number[]} score - Series score per player slot.
 * @property {Array<{heroes: Array<?string>, winner: ?string}>} rounds -
 *   Per-round results with hero picks and round winner.
 */

/**
 * Generate a unique tournament code (prefixed with 'T').
 * @returns {string} A unique tournament code (e.g., 'TAB3').
 */
function genTourneyCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "T";
  for (let i = 0; i < 3; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return tournaments.has(code) ? genTourneyCode() : code;
}

/**
 * Find a player in a tournament by their socket ID.
 *
 * @param {TourneyState} tourney - The tournament to search.
 * @param {string} sid - The socket ID to find.
 * @returns {?{id: string, name: string, isPlayer: boolean}} The player
 *   object, or null if not found.
 */
function findTourneyPlayer(tourney, sid) {
  return tourney.players.find(p => p.id === sid) || null;
}

/**
 * Build a lobby-phase tournament state snapshot for a specific client.
 *
 * @param {TourneyState} tourney - The tournament to generate state for.
 * @param {string} sid - The requesting client's socket ID.
 * @returns {Object} Sanitized tournament state for the client.
 */
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
    phase: tourney.phase,
    isHost: sid === tourney.hostId,
    hostPlaying: tourney.hostPlaying,
    players: tourney.players.map(p => ({ id: p.id, name: p.name, isPlayer: p.isPlayer !== false })),
    chat: tourney.chat.slice(-50),
    coinStreaks: tourney.coinStreaks,
    myName: me?.name || null,
    allHeroes: HEROES,
    heroImages: HERO_IMAGES,
  };
}

/**
 * Broadcast lobby-phase tournament state to all connected players.
 * @param {TourneyState} tourney - The tournament to broadcast.
 */
function broadcastTourney(tourney) {
  for (const p of tourney.players) {
    io.to(p.id).emit("tourneyState", tourneyStateFor(tourney, p.id));
  }
}

/**
 * Broadcast bracket-phase tournament state to all connected players.
 * @param {TourneyState} tourney - The tournament to broadcast.
 */
function broadcastTourneyBracket(tourney) {
  for (const p of tourney.players) {
    io.to(p.id).emit("tourneyState", tourneyBracketStateFor(tourney, p.id));
  }
}

/**
 * Resolve a tournament match with a declared winner.
 *
 * Records the winner, marks the match as complete, and eliminates the loser
 * if they were already in the losers bracket or grand final. Checks whether
 * all active matches in the current wave are complete and triggers the reveal
 * sequence if so.
 *
 * @param {TourneyState} tourney - The tournament containing the match.
 * @param {MatchState} match - The match to resolve.
 * @param {string} winnerName - The name of the winning player.
 */
function resolveMatch(tourney, match, winnerName) {
  const loserName = match.slots[0] === winnerName ? match.slots[1] : match.slots[0];
  match.winner = winnerName;
  match.loser = loserName;
  match.status = "complete";

  // Record the winner for the latest round (for hero display).
  if (match.rounds && match.rounds.length > 0) {
    const lastRound = match.rounds[match.rounds.length - 1];
    if (!lastRound.winner) lastRound.winner = winnerName;
  }

  // Losers bracket or grand final losses result in elimination.
  if (match.bracket === "losers" || match.bracket === "grand_final") {
    if (loserName && !tourney.eliminated.includes(loserName)) {
      tourney.eliminated.push(loserName);
    }
  }

  // Check if all active (non-pending, non-complete) matches are done.
  const activeMatches = tourney.bracket.matches.filter(m =>
    m.status !== "complete" && m.status !== "pending"
  );

  if (activeMatches.length === 0) {
    // All matches in the current wave are done — start reveal sequence.
    const justCompleted = tourney.bracket.matches.filter(m =>
      m.status === "complete" && m.winner && !tourney._revealed?.has(m.id)
    );
    if (!tourney._revealed) tourney._revealed = new Set();
    const newlyCompleted = justCompleted.filter(m => !tourney._revealed.has(m.id));

    if (newlyCompleted.length > 0) {
      tourney.revealQueue = newlyCompleted.map(m => m.id);
      tourney.revealIndex = 0;
      tourney.phase = "reveal";
      for (const m of newlyCompleted) tourney._revealed.add(m.id);
    } else {
      // Nothing new to reveal — advance the bracket.
      propagateBracket(tourney);
      activateWave(tourney);
      if (isTourneyComplete(tourney)) tourney.phase = "complete";
    }
  }
}

/**
 * Callback invoked when a tournament-linked draft lobby completes.
 *
 * Records the draft result (champion heroes) as a round in the match and
 * transitions the match to a voting phase where players declare the winner.
 *
 * @param {LobbyState} lobby - The completed draft lobby.
 */
function onTourneyDraftComplete(lobby) {
  const tm = lobby.tourneyMatch;
  if (!tm) return;
  const tourney = tournaments.get(tm.tourneyCode);
  if (!tourney) return;
  const match = tourney.bracket.matches.find(m => m.id === tm.matchId);
  if (!match) return;

  // Record round result with hero selections.
  if (!match.rounds) match.rounds = [];
  match.rounds.push({
    heroes: [lobby.champions[0] || null, lobby.champions[1] || null],
    winner: null,
  });

  // Transition match to voting phase.
  match.status = "voting";
  match.votes = [null, null];

  // Notify match participants.
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

/**
 * Round up to the next power of 2.
 * @param {number} n - The input value.
 * @returns {number} The smallest power of 2 >= n.
 */
function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

/**
 * Generate a complete double-elimination bracket for a set of players.
 *
 * Creates winners bracket rounds, losers bracket rounds (with drop-down
 * rounds that receive losers from the winners bracket), and a grand final.
 * Players are shuffled and padded with BYE slots to the next power of 2.
 *
 * @param {string[]} playerNames - Names of all participating players.
 * @returns {BracketState} The generated bracket with all matches, round
 *   groupings, and the grand final match ID.
 */
function generateDoubleElimBracket(playerNames) {
  const n = playerNames.length;
  const size = nextPow2(n);
  const wRounds = Math.log2(size);
  const lRounds = 2 * (wRounds - 1);

  // Shuffle players and pad with BYE (null) entries.
  const shuffled = [...playerNames].sort(() => Math.random() - 0.5);
  while (shuffled.length < size) shuffled.push(null);

  const matches = [];
  let matchId = 0;

  // ── Winners Bracket Round 1 ──
  const wbRounds = [];
  const r1 = [];
  for (let i = 0; i < size / 2; i++) {
    const m = {
      id: matchId++,
      bracket: "winners",
      round: 0,
      slots: [shuffled[i * 2], shuffled[i * 2 + 1]],
      winner: null,
      loser: null,
      status: "pending",
      readyState: [false, false],
      votes: [null, null],
      draftCode: null,
      score: [0, 0],
      rounds: [],
    };
    // Auto-resolve BYE matches.
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

  // ── Subsequent Winners Bracket Rounds ──
  for (let r = 1; r < wRounds; r++) {
    const prevRound = wbRounds[r - 1];
    const thisRound = [];
    for (let i = 0; i < prevRound.length; i += 2) {
      const m = {
        id: matchId++,
        bracket: "winners",
        round: r,
        slots: [null, null],
        feeders: [prevRound[i], prevRound[i + 1]],
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
    const isDropDown = lr % 2 === 0;
    const thisRound = [];
    if (lr === 0) {
      // First LB round: losers from WB Round 1 face each other.
      const wbLosers = wbRounds[0];
      for (let i = 0; i < wbLosers.length; i += 2) {
        const m = {
          id: matchId++,
          bracket: "losers",
          round: lr,
          slots: [null, null],
          feedersLoser: [wbLosers[i], wbLosers[i + 1]],
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
      // Drop-down round: WB losers enter against LB survivors.
      const wbRound = Math.floor(lr / 2) + 1;
      const wbRoundMatches = wbRounds[wbRound] || [];
      const prevLbRound = lbRounds[lr - 1];
      const count = Math.max(wbRoundMatches.length, (prevLbRound || []).length);
      for (let i = 0; i < count; i++) {
        const m = {
          id: matchId++,
          bracket: "losers",
          round: lr,
          slots: [null, null],
          feederWinner: prevLbRound ? prevLbRound[i] : null,
          feederLoser: wbRoundMatches[i] !== undefined ? wbRoundMatches[i] : null,
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
      // Reduction round: LB survivors face each other.
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

/**
 * Propagate winners and losers through the bracket after matches complete.
 *
 * Iterates through all pending matches and fills in slots based on their
 * feeder match results. Handles winners bracket feeders, losers bracket
 * drop-downs, and grand final feeders.
 *
 * @param {TourneyState} tourney - The tournament whose bracket to propagate.
 */
function propagateBracket(tourney) {
  const matches = tourney.bracket.matches;
  const byId = {};
  for (const m of matches) byId[m.id] = m;

  for (const m of matches) {
    if (m.status === "complete") continue;
    if (m.slots[0] !== null && m.slots[1] !== null) continue;

    // Winners bracket: fed by previous winners.
    if (m.feeders) {
      const f0 = byId[m.feeders[0]];
      const f1 = byId[m.feeders[1]];
      if (f0 && f0.status === "complete" && f0.winner) m.slots[0] = f0.winner;
      if (f1 && f1.status === "complete" && f1.winner) m.slots[1] = f1.winner;
    }

    // Losers bracket first round: fed by WB losers.
    if (m.feedersLoser) {
      const f0 = byId[m.feedersLoser[0]];
      const f1 = byId[m.feedersLoser[1]];
      if (f0 && f0.status === "complete" && f0.loser) m.slots[0] = f0.loser;
      if (f1 && f1.status === "complete" && f1.loser) m.slots[1] = f1.loser;
    }

    // Losers bracket drop-down: LB winner + WB loser.
    if (m.feederWinner !== undefined && m.feederWinner !== null) {
      const fw = byId[m.feederWinner];
      if (fw && fw.status === "complete" && fw.winner) m.slots[0] = fw.winner;
    }
    if (m.feederLoser !== undefined && m.feederLoser !== null && !m.feedersLoser) {
      const fl = byId[m.feederLoser];
      if (fl && fl.status === "complete" && fl.loser) m.slots[1] = fl.loser;
    }

    // Grand final: WB winner + LB winner.
    if (m.feederWB !== undefined) {
      const fw = byId[m.feederWB];
      if (fw && fw.status === "complete" && fw.winner) m.slots[0] = fw.winner;
    }
    if (m.feederLB !== undefined) {
      const fl = byId[m.feederLB];
      if (fl && fl.status === "complete" && fl.winner) m.slots[1] = fl.winner;
    }
  }
}

/**
 * Get all matches ready to begin (both slots filled, status 'pending').
 *
 * @param {TourneyState} tourney - The tournament to query.
 * @returns {MatchState[]} Array of matches ready to activate.
 */
function getActiveWaveMatches(tourney) {
  return tourney.bracket.matches.filter(m =>
    m.slots[0] !== null && m.slots[1] !== null && m.status === "pending"
  );
}

/**
 * Activate the next wave of matches in the tournament bracket.
 *
 * Propagates the bracket, finds ready matches, sets them to 'preview' status,
 * and after a 7-second delay transitions them to 'ready_check' for player
 * confirmation.
 *
 * @param {TourneyState} tourney - The tournament to activate matches for.
 * @returns {MatchState[]} The activated matches.
 */
function activateWave(tourney) {
  propagateBracket(tourney);
  const wave = getActiveWaveMatches(tourney);
  for (const m of wave) {
    m.status = "preview";
    m.readyState = [false, false];
  }
  if (wave.length > 0) {
    broadcastTourneyBracket(tourney);
    // After 7 seconds, transition from preview to ready check.
    setTimeout(() => {
      let changed = false;
      for (const m of wave) {
        if (m.status === "preview") {
          m.status = "ready_check";
          changed = true;
        }
      }
      if (changed) broadcastTourneyBracket(tourney);
    }, 7000);
  }
  return wave;
}

/**
 * Check whether the tournament is complete (grand final resolved).
 *
 * @param {TourneyState} tourney - The tournament to check.
 * @returns {boolean} True if the grand final match is complete.
 */
function isTourneyComplete(tourney) {
  const gf = tourney.bracket.matches.find(m => m.id === tourney.bracket.grandFinalId);
  return gf && gf.status === "complete";
}

/**
 * Find a player's current active match in the tournament bracket.
 *
 * @param {TourneyState} tourney - The tournament to search.
 * @param {string} playerName - The player name to look for.
 * @returns {?MatchState} The active match, or null if no active match found.
 */
function findPlayerMatch(tourney, playerName) {
  return tourney.bracket.matches.find(m =>
    (m.slots[0] === playerName || m.slots[1] === playerName) &&
    m.status !== "complete" && m.status !== "pending"
  );
}

/**
 * Get a player's slot index (0 or 1) within a match.
 *
 * @param {MatchState} match - The match to check.
 * @param {string} playerName - The player name to locate.
 * @returns {number} Slot index (0 or 1), or -1 if not found.
 */
function playerSlotInMatch(match, playerName) {
  if (match.slots[0] === playerName) return 0;
  if (match.slots[1] === playerName) return 1;
  return -1;
}

/**
 * Get the list of match IDs queued for the reveal animation.
 *
 * @param {TourneyState} tourney - The tournament to query.
 * @returns {number[]} Array of match IDs in the reveal queue.
 */
function getCompletedWaveMatches(tourney) {
  if (!tourney.revealQueue) return [];
  return tourney.revealQueue;
}

/**
 * Build a bracket-phase tournament state snapshot for a specific client.
 *
 * Extends the base {@link tourneyStateFor} with bracket data, the client's
 * current match info, reveal queue state, and elimination list.
 *
 * @param {TourneyState} tourney - The tournament to generate state for.
 * @param {string} sid - The requesting client's socket ID.
 * @returns {Object} Sanitized tournament+bracket state for the client.
 */
function tourneyBracketStateFor(tourney, sid) {
  const base = tourneyStateFor(tourney, sid);
  const me = findTourneyPlayer(tourney, sid);
  const myName = me?.name || null;

  // Find this player's current active match.
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
  base.tourneyPhase = tourney.phase;
  base.eliminated = tourney.eliminated || [];

  return base;
}

// ═══════════════════════════════════════════════════════════
//  SOCKET HANDLERS
// ═══════════════════════════════════════════════════════════

io.on("connection", (socket) => {
  /** @type {?string} Lobby code this socket is connected to. */
  let myLobby = null;
  /** @type {?string} Tournament code this socket is connected to. */
  let myTourney = null;

  // ── Lobby Creation ──

  /**
   * @event createLobby
   * @description Create a new draft lobby. The creator becomes the host.
   * @param {Object} data
   * @param {string} data.name - Display name for the creating player.
   * @param {number} [data.timerDuration=120] - Phase timer in seconds.
   * @param {string} [data.mode='phase'] - Draft mode: 'phase', 'standard',
   *   or 'duel'.
   */
  socket.on("createLobby", ({ name, timerDuration, mode }) => {
    const code = genCode();
    const isDuel = mode === "duel";
    const lobby = {
      code, hostId: socket.id,
      mode: mode || "phase",
      timerDuration: timerDuration || 120,
      phase: "waiting",
      teamNames: isDuel ? [name || "Player 1", "Player 2"] : ["Hidden King", "Archmother"],
      captains: isDuel ? [{ id: socket.id, name }, null] : [null, null],
      ready: [false, false],
      spectators: [[], []],
      unassigned: isDuel ? [] : [{ id: socket.id, name }],
      picks: [[], []], pools: [[], []], origPicks: [[], []],
      bans: new Set(), overlaps: [],
      phase2Bans: [[], []], phase2Banned: [[], []],
      phase3Choice: [null, null], champions: [null, null],
      locked: [false, false],
      specPrefs: [{}, {}],
      timerRef: null, timerEnd: null,
      std: null,
      duelPoolSize: 3,
      globalBans: [],
      chat: [],
      coinStreaks: {},
      teamChat: [[], []],
      ghostPlayers: [[], []],
    };
    lobbies.set(code, lobby);
    myLobby = code;
    socket.join(code);
    socket.emit("lobbyCreated", { code });
    broadcast(lobby);
  });

  /**
   * @event queryLobby
   * @description Query a lobby's basic info before joining.
   * @param {Object} data
   * @param {string} data.code - The lobby code to query.
   */
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

  // ── Reconnection ──

  /**
   * @event rejoinLobby
   * @description Rejoin an existing lobby after a disconnect.
   * @param {Object} data
   * @param {string} data.code - The lobby code.
   * @param {string} data.name - The player's display name.
   * @param {string} [data.role] - Previous role ('captain', 'spectator').
   * @param {number} [data.team] - Previous team index (0 or 1).
   */
  socket.on("rejoinLobby", ({ code, name, role, team }) => {
    if (!code || !name) return;
    const c = code.toUpperCase();
    const lobby = lobbies.get(c);
    if (!lobby) return socket.emit("err", "Lobby no longer exists.");

    // Attempt to find and update the player's old socket ID.
    let found = false;
    for (let t = 0; t < 2; t++) {
      if (lobby.captains[t] && lobby.captains[t].name === name) {
        lobby.captains[t].id = socket.id;
        found = true; break;
      }
      const spIdx = lobby.spectators[t].findIndex(s => s.name === name);
      if (spIdx >= 0) {
        lobby.spectators[t][spIdx].id = socket.id;
        found = true; break;
      }
    }
    if (!found) {
      const uaIdx = lobby.unassigned.findIndex(u => u.name === name);
      if (uaIdx >= 0) {
        lobby.unassigned[uaIdx].id = socket.id;
        found = true;
      }
    }

    // If player not found (cleaned up on disconnect), try to re-add them.
    if (!found) {
      if (lobby.phase === "waiting") {
        if (role === "captain" && (team === 0 || team === 1) && !lobby.captains[team]) {
          lobby.captains[team] = { id: socket.id, name };
        } else {
          lobby.unassigned.push({ id: socket.id, name });
        }
      }
      // During active drafts, disconnected players can observe but not participate.
    }

    // Note: Player preference socket ID migration is not implemented.
    for (let t = 0; t < 2; t++) {
      const prefs = lobby.playerPrefs?.[t];
      if (prefs) {
        for (const [oldSid, heroes] of Object.entries(prefs)) {
          // TODO: Map old socket IDs to new ones for preference migration.
        }
      }
    }

    myLobby = c;
    socket.join(c);
    const me = findPerson(lobby, socket.id);
    socket.emit("joined", { code: c, role: me ? me.role : "spectator" });
    broadcast(lobby);
  });

  // ── Join as Captain ──

  /**
   * @event joinAsCaptain
   * @description Join a lobby as a team captain.
   * @param {Object} data
   * @param {string} data.code - The lobby code.
   * @param {string} data.name - Display name.
   * @param {number} [data.team] - Preferred team (0 or 1).
   */
  socket.on("joinAsCaptain", ({ code, name, team }) => {
    const c = code.toUpperCase();
    const lobby = lobbies.get(c);
    if (!lobby) return socket.emit("err", "Lobby not found.");
    if (lobby.phase !== "waiting") return socket.emit("err", "Draft already in progress.");
    if (findPerson(lobby, socket.id)) { broadcast(lobby); return; }
    if (team === 0 || team === 1) {
      if (!lobby.captains[team]) {
        lobby.captains[team] = { id: socket.id, name };
      } else if (!lobby.captains[1 - team]) {
        lobby.captains[1 - team] = { id: socket.id, name };
      } else {
        return socket.emit("err", "Both captain slots are filled.");
      }
    } else {
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

  // ── Join as Spectator ──

  /**
   * @event joinAsSpectator
   * @description Join a lobby as a team member/spectator.
   * @param {Object} data
   * @param {string} data.code - The lobby code.
   * @param {string} data.name - Display name.
   * @param {number} [data.team] - Preferred team (0 or 1).
   */
  socket.on("joinAsSpectator", ({ code, name, team }) => {
    const c = code.toUpperCase();
    const lobby = lobbies.get(c);
    if (!lobby) return socket.emit("err", "Lobby not found.");
    if (findPerson(lobby, socket.id)) { broadcast(lobby); return; }
    // In duel mode, auto-promote to captain if a slot is open.
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
    if (typeof team === "number" && (team === 0 || team === 1) && lobby.phase === "waiting") {
      lobby.spectators[team].push({ id: socket.id, name });
      myLobby = c; socket.join(c);
      socket.emit("joined", { code: c, role: "spectator" });
    } else {
      lobby.unassigned.push({ id: socket.id, name });
      myLobby = c; socket.join(c);
      socket.emit("joined", { code: c, role: "unassigned" });
    }
    broadcast(lobby);
  });

  // ── Team Management ──

  /** @event joinTeam - Move yourself to a different team or unassigned. */
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

  /** @event hostMovePlayer - Host moves a player between teams. */
  socket.on("hostMovePlayer", ({ playerId, toTeam }) => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby || lobby.phase !== "waiting" || socket.id !== lobby.hostId) return;
    const target = findPerson(lobby, playerId);
    if (!target || playerId === lobby.hostId) return;
    let playerName = "Player";
    if (target.role === "unassigned") {
      playerName = lobby.unassigned[target.idx]?.name || "Player";
      lobby.unassigned.splice(target.idx, 1);
    } else if (target.role === "spectator") {
      playerName = lobby.spectators[target.team][target.idx]?.name || "Player";
      lobby.spectators[target.team].splice(target.idx, 1);
    } else if (target.role === "captain") {
      playerName = lobby.captains[target.team]?.name || "Player";
      lobby.captains[target.team] = null;
      lobby.ready[target.team] = false;
    } else return;
    if (toTeam === -1) {
      lobby.unassigned.push({ id: playerId, name: playerName });
    } else {
      const t = toTeam === 0 ? 0 : 1;
      lobby.spectators[t].push({ id: playerId, name: playerName });
    }
    broadcast(lobby);
  });

  /** @event hostToggleCaptain - Host toggles themselves as captain for a team. */
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

  /** @event promoteToCaptain - Host promotes a player to captain. */
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

  // ── Ready / Settings ──

  /** @event toggleReady - Captain toggles their ready state. */
  socket.on("toggleReady", () => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby || lobby.phase !== "waiting") return;
    const t = lobby.captains[0]?.id === socket.id ? 0 : lobby.captains[1]?.id === socket.id ? 1 : -1;
    if (t === -1) return;
    lobby.ready[t] = !lobby.ready[t];
    broadcast(lobby);
  });

  /** @event updateTimer - Host updates the phase timer duration. */
  socket.on("updateTimer", ({ duration }) => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby || socket.id !== lobby.hostId || lobby.phase !== "waiting") return;
    lobby.timerDuration = Math.min(300, Math.max(10, Math.round(duration / 10) * 10));
    broadcast(lobby);
  });

  /** @event updatePoolSize - Host updates the duel mode pool size. */
  socket.on("updatePoolSize", ({ size }) => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby || socket.id !== lobby.hostId || lobby.phase !== "waiting" || lobby.mode !== "duel") return;
    lobby.duelPoolSize = Math.min(6, Math.max(2, Math.round(size)));
    broadcast(lobby);
  });

  /** @event updateGlobalBans - Host updates the global hero ban list. */
  socket.on("updateGlobalBans", ({ heroes }) => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby || socket.id !== lobby.hostId || lobby.phase !== "waiting") return;
    lobby.globalBans = [...new Set(heroes)].filter(h => HEROES.includes(h));
    broadcast(lobby);
  });

  // ── Draft Start ──

  /** @event startDraft - Host starts the draft (requires 2 ready captains). */
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

  /** @event lockPicks - Captain locks in their Phase 1 hero picks. */
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

  /** @event lockBans - Captain locks in their Phase 2 opponent bans. */
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

  /** @event lockFinal - Captain locks in their Phase 3 final champion. */
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

  /**
   * @event stdAction
   * @description Captain makes a pick or ban in the standard draft.
   * @param {Object} data
   * @param {string} data.hero - The hero to pick or ban.
   * @param {string} [data.assignedTo] - Player name to assign the pick to.
   */
  socket.on("stdAction", ({ hero, assignedTo }) => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby || lobby.mode !== "standard" || lobby.phase !== "std_drafting" || !lobby.std) return;
    const st = lobby.std;
    if (st.step >= STD_TURNS.length) return;
    const turn = STD_TURNS[st.step];
    const t = lobby.captains[0]?.id === socket.id ? 0 : lobby.captains[1]?.id === socket.id ? 1 : -1;
    if (t !== turn.team) return;
    const used = stdAllUsed(lobby);
    if (used.has(hero) || !HEROES.includes(hero)) return;
    clearTimer(lobby);
    if (turn.type === "ban") st.bans[turn.team].push(hero);
    else {
      st.picks[turn.team].push(hero);
      if (!st.playerAssignments) st.playerAssignments = [[], []];
      st.playerAssignments[turn.team].push(assignedTo || null);
    }
    stdAdvance(lobby);
  });

  /** @event reassignPick - Captain reassigns a hero pick to a different player. */
  socket.on("reassignPick", ({ team, pickIndex, assignedTo }) => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby || lobby.mode !== "standard" || !lobby.std) return;
    const me = findPerson(lobby, socket.id);
    if (!me || me.role !== "captain" || me.team !== team) return;
    const st = lobby.std;
    if (!st.playerAssignments) st.playerAssignments = [[], []];
    if (pickIndex < 0 || pickIndex >= st.picks[team].length) return;
    st.playerAssignments[team][pickIndex] = assignedTo || null;
    broadcast(lobby);
  });

  /** @event specPref - Spectator toggles a hero preference vote. */
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

  /** @event advancePhase - Host (or captain in duel) advances to next phase. */
  socket.on("advancePhase", () => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby) return;
    const isDuel = lobby.mode === "duel";
    const isCaptain = lobby.captains[0]?.id === socket.id || lobby.captains[1]?.id === socket.id;
    if (!isDuel && socket.id !== lobby.hostId) return;
    if (isDuel && !isCaptain) return;
    if (lobby.phase === "phase1_reveal") startPhase2(lobby);
    else if (lobby.phase === "phase2_reveal") startPhase3(lobby);
  });

  /** @event resetDraft - Host (or captain in duel) resets the draft to waiting. */
  socket.on("resetDraft", () => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby) return;
    const isDuel = lobby.mode === "duel";
    const isCaptain = lobby.captains[0]?.id === socket.id || lobby.captains[1]?.id === socket.id;
    if (!isDuel && socket.id !== lobby.hostId) return;
    if (isDuel && !isCaptain) return;
    clearTimer(lobby); lobby.phase = "waiting";
    lobby.ready = [false, false]; lobby.std = null;
    broadcast(lobby);
  });

  // ── Tournament Handlers ──

  /**
   * @event createTourney
   * @description Create a new tournament lobby.
   */
  socket.on("createTourney", ({ name, hostName, format, draftMode, bestOf, maxPlayers, globalBans, timerDuration, duelPoolSize, hostPlaying }) => {
    const code = genTourneyCode();
    const isPlaying = hostPlaying !== false;
    const tourney = {
      code,
      hostId: socket.id,
      name: name || "Tournament",
      format: format || "double_elim",
      draftMode: draftMode || "duel",
      bestOf: Math.min(5, Math.max(1, bestOf || 1)),
      maxPlayers: Math.min(32, Math.max(2, maxPlayers || 8)),
      globalBans: [...new Set(globalBans || [])].filter(h => HEROES.includes(h)),
      timerDuration: timerDuration || 60,
      duelPoolSize: Math.min(6, Math.max(2, duelPoolSize || 3)),
      phase: "lobby",
      hostPlaying: isPlaying,
      players: isPlaying ? [{ id: socket.id, name: hostName || "Host", isPlayer: true }] : [{ id: socket.id, name: hostName || "Host", isPlayer: false }],
      chat: [],
      coinStreaks: {},
    };
    tournaments.set(code, tourney);
    myTourney = code;
    socket.join("t_" + code);
    socket.emit("tourneyCreated", { code });
    broadcastTourney(tourney);
  });

  /** @event joinTourney - Join an existing tournament lobby. */
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
    tourney.chat.push({ from: null, text: `${name || "Player"} joined the tournament`, ts: Date.now() });
    broadcastTourney(tourney);
  });

  /** @event tourneyChat - Send a chat message in the tournament lobby. */
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

  /** @event coinFlip - Flip a coin in the tournament lobby (streak tracked). */
  socket.on("coinFlip", () => {
    if (!myTourney) return;
    const tourney = tournaments.get(myTourney);
    if (!tourney) return;
    const me = findTourneyPlayer(tourney, socket.id);
    if (!me) return;
    const isHeads = Math.random() < 0.5;
    if (!me._coinCurrent) me._coinCurrent = 0;
    if (isHeads) {
      me._coinCurrent++;
      const best = tourney.coinStreaks[socket.id] || 0;
      if (me._coinCurrent > best) tourney.coinStreaks[socket.id] = me._coinCurrent;
    } else {
      me._coinCurrent = 0;
    }
    // Notify others that a flip is happening (for UI deferred updates).
    for (const p of tourney.players) {
      if (p.id !== socket.id) {
        io.to(p.id).emit("coinFlipStarted", { flipper: me.name });
      }
    }
    socket.emit("coinResult", {
      heads: isHeads,
      currentStreak: me._coinCurrent,
      bestStreak: tourney.coinStreaks[socket.id] || 0,
    });
    broadcastTourney(tourney);
  });

  /** @event updateTourney - Host updates tournament settings. */
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

  /** @event queryTourney - Query basic tournament info before joining. */
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

  /** @event startTournament - Host starts the tournament and generates bracket. */
  socket.on("startTournament", () => {
    if (!myTourney) return;
    const tourney = tournaments.get(myTourney);
    if (!tourney || socket.id !== tourney.hostId || tourney.phase !== "lobby") return;
    const playerNames = tourney.players.filter(p => p.isPlayer).map(p => p.name);
    if (playerNames.length < 2) return socket.emit("err", "Need at least 2 players.");
    tourney.bracket = generateDoubleElimBracket(playerNames);
    tourney.eliminated = [];
    tourney.revealQueue = [];
    tourney.revealIndex = 0;
    tourney.phase = "bracket";
    propagateBracket(tourney);
    activateWave(tourney);
  });

  /** @event tourneyReadyUp - Player confirms readiness for their match. */
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

    // If both players are ready, create a draft lobby for the match.
    if (match.readyState[0] && match.readyState[1]) {
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
      broadcastTourneyBracket(tourney);

      // Notify match participants to join the draft lobby.
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

  /** @event joinTourneyDraft - Player joins their tournament match's draft lobby. */
  socket.on("joinTourneyDraft", ({ draftCode, slot }) => {
    const lobby = lobbies.get(draftCode);
    if (!lobby || !lobby.tourneyMatch) return;
    if (!myTourney) return;
    const tourney = tournaments.get(myTourney);
    if (!tourney) return;
    const me = findTourneyPlayer(tourney, socket.id);
    if (!me) return;
    const t = slot === 0 ? 0 : 1;
    if (lobby.captains[t]) return;
    lobby.captains[t] = { id: socket.id, name: me.name };
    lobby.ready[t] = true;
    myLobby = draftCode;
    socket.join(draftCode);
    // Auto-start draft when both captains have joined.
    if (lobby.captains[0] && lobby.captains[1]) {
      if (lobby.mode === "standard") startStdDraft(lobby);
      else startPhase1(lobby);
    }
    broadcast(lobby);
  });

  /** @event tourneyVoteWinner - Player votes on who won their match. */
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
    if (match.votes[0] !== null && match.votes[1] !== null) {
      if (match.votes[0] === match.votes[1]) {
        resolveMatch(tourney, match, match.votes[0]);
      } else {
        match.status = "dispute";
      }
    }
    broadcastTourneyBracket(tourney);
  });

  /** @event tourneyHostDecide - Host resolves a disputed match result. */
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

  /** @event advanceReveal - Host advances the bracket reveal sequence. */
  socket.on("advanceReveal", () => {
    if (!myTourney) return;
    const tourney = tournaments.get(myTourney);
    if (!tourney || socket.id !== tourney.hostId || tourney.phase !== "reveal") return;
    tourney.revealIndex++;
    if (tourney.revealIndex >= tourney.revealQueue.length) {
      tourney.phase = "bracket";
      tourney.revealQueue = [];
      tourney.revealIndex = 0;
      propagateBracket(tourney);
      const wave = activateWave(tourney);
      if (isTourneyComplete(tourney)) {
        tourney.phase = "complete";
      } else if (wave.length === 0) {
        propagateBracket(tourney);
        const wave2 = activateWave(tourney);
        if (wave2.length === 0 && isTourneyComplete(tourney)) {
          tourney.phase = "complete";
        }
      }
    }
    broadcastTourneyBracket(tourney);
  });

  // ── Lobby Chat ──

  /** @event lobbyChat - Send a chat message in the draft lobby. */
  socket.on("lobbyChat", ({ text }) => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby) return;
    const me = findPerson(lobby, socket.id);
    if (!me) return;
    const msg = (text || "").slice(0, 200).trim();
    if (!msg) return;
    let fromName = "Unknown";
    if (me.role === "captain") fromName = lobby.captains[me.team]?.name || "Captain";
    else if (me.role === "spectator") fromName = lobby.spectators[me.team][me.idx]?.name || "Player";
    else if (me.role === "unassigned") fromName = lobby.unassigned[me.idx]?.name || "Spectator";
    if (!lobby.chat) lobby.chat = [];
    lobby.chat.push({ from: fromName, text: msg, ts: Date.now() });
    if (lobby.chat.length > 100) lobby.chat = lobby.chat.slice(-100);
    broadcast(lobby);
  });

  // ── Lobby Coin Flip ──

  /** @event lobbyCoinFlip - Flip a coin in the draft lobby (streak tracked). */
  socket.on("lobbyCoinFlip", () => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby) return;
    const me = findPerson(lobby, socket.id);
    if (!me) return;
    const isHeads = Math.random() < 0.5;
    if (!lobby._coinCurrent) lobby._coinCurrent = {};
    if (!lobby.coinStreaks) lobby.coinStreaks = {};
    if (isHeads) {
      lobby._coinCurrent[socket.id] = (lobby._coinCurrent[socket.id] || 0) + 1;
      const best = lobby.coinStreaks[socket.id] || 0;
      if (lobby._coinCurrent[socket.id] > best) lobby.coinStreaks[socket.id] = lobby._coinCurrent[socket.id];
    } else {
      lobby._coinCurrent[socket.id] = 0;
    }
    const everyone = [
      ...lobby.captains.filter(Boolean),
      ...lobby.spectators[0], ...lobby.spectators[1],
      ...lobby.unassigned,
    ];
    for (const p of everyone) {
      if (p.id !== socket.id) {
        io.to(p.id).emit("lobbyCoinFlipStarted", { flipper: socket.id });
      }
    }
    socket.emit("lobbyCoinResult", {
      heads: isHeads,
      currentStreak: lobby._coinCurrent[socket.id] || 0,
      bestStreak: lobby.coinStreaks[socket.id] || 0,
    });
    broadcast(lobby);
  });

  // ── Team Chat (during draft) ──

  /** @event teamChat - Send a message visible only to your own team. */
  socket.on("teamChat", ({ text }) => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby) return;
    const me = findPerson(lobby, socket.id);
    if (!me || me.team === undefined || me.team === null) return;
    const msg = (text || "").slice(0, 200).trim();
    if (!msg) return;
    if (!lobby.teamChat) lobby.teamChat = [[], []];
    lobby.teamChat[me.team].push({ from: me.role === "captain" ? "⭐ " + (lobby.captains[me.team]?.name || "Captain") : (me.role === "spectator" ? lobby.spectators[me.team][me.idx]?.name : "Unknown"), text: msg, ts: Date.now() });
    if (lobby.teamChat[me.team].length > 100) lobby.teamChat[me.team] = lobby.teamChat[me.team].slice(-100);
    broadcast(lobby);
  });

  // ── Ghost Players (absent player slots) ──

  /** @event addGhostPlayer - Captain adds a placeholder for an absent player. */
  socket.on("addGhostPlayer", ({ team, name }) => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby) return;
    const me = findPerson(lobby, socket.id);
    if (!me || me.role !== "captain" || me.team !== team) return;
    const n = (name || "").trim().slice(0, 20);
    if (!n) return;
    if (!lobby.ghostPlayers) lobby.ghostPlayers = [[], []];
    if (lobby.ghostPlayers[team].length >= 5) return;
    lobby.ghostPlayers[team].push({ name: n, heroes: [] });
    broadcast(lobby);
  });

  /** @event removeGhostPlayer - Captain removes a ghost player slot. */
  socket.on("removeGhostPlayer", ({ team, index }) => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby) return;
    const me = findPerson(lobby, socket.id);
    if (!me || me.role !== "captain" || me.team !== team) return;
    if (!lobby.ghostPlayers?.[team]) return;
    lobby.ghostPlayers[team].splice(index, 1);
    broadcast(lobby);
  });

  /** @event ghostPick - Captain toggles a hero preference for a ghost player. */
  socket.on("ghostPick", ({ team, playerIndex, hero }) => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby) return;
    const me = findPerson(lobby, socket.id);
    if (!me || me.role !== "captain" || me.team !== team) return;
    if (!lobby.ghostPlayers?.[team]?.[playerIndex]) return;
    const gp = lobby.ghostPlayers[team][playerIndex];
    if (gp.heroes.includes(hero)) {
      gp.heroes = gp.heroes.filter(h => h !== hero);
    } else {
      gp.heroes.push(hero);
    }
    broadcast(lobby);
  });

  // ── Filler Players ──

  /** @event renameFiller - Captain renames an auto-generated filler player. */
  socket.on("renameFiller", ({ team, index, name }) => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby || lobby.mode !== "standard") return;
    const me = findPerson(lobby, socket.id);
    if (!me || me.role !== "captain" || me.team !== team) return;
    if (!lobby.fillerPlayers?.[team]?.[index]) return;
    const n = (name || "").trim().slice(0, 20);
    if (!n) return;
    const oldName = lobby.fillerPlayers[team][index].name;
    lobby.fillerPlayers[team][index].name = n;
    // Update player assignments referencing the old name.
    if (lobby.std && lobby.std.playerAssignments && lobby.std.playerAssignments[team]) {
      lobby.std.playerAssignments[team] = lobby.std.playerAssignments[team].map(a => a === oldName ? n : a);
    }
    broadcast(lobby);
  });

  // ── Player Preferences (hero wish list) ──

  /** @event playerPref - Team member toggles a hero on their preference list. */
  socket.on("playerPref", ({ hero, on }) => {
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby || lobby.mode !== "standard" || !lobby.playerPrefs) return;
    const me = findPerson(lobby, socket.id);
    if (!me) return;
    const myTeam = (me.role === "captain" || me.role === "spectator") ? me.team : -1;
    if (myTeam < 0) return;
    const prefs = lobby.playerPrefs[myTeam];
    const key = socket.id;
    if (!prefs[key]) prefs[key] = [];
    if (on) {
      if (!prefs[key].includes(hero)) prefs[key].push(hero);
    } else {
      prefs[key] = prefs[key].filter(h => h !== hero);
    }
    broadcast(lobby);
  });

  // ── Disconnect ──

  socket.on("disconnect", () => {
    // Handle tournament disconnection.
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

    // Handle lobby disconnection.
    if (!myLobby) return;
    const lobby = lobbies.get(myLobby);
    if (!lobby) return;
    if (lobby.phase === "waiting") {
      // Remove the player from all roles.
      for (let t = 0; t < 2; t++) {
        if (lobby.captains[t]?.id === socket.id) { lobby.captains[t] = null; lobby.ready[t] = false; }
        lobby.spectators[t] = lobby.spectators[t].filter(s => s.id !== socket.id);
      }
      lobby.unassigned = lobby.unassigned.filter(u => u.id !== socket.id);
      const all = [...lobby.captains.filter(Boolean), ...lobby.spectators[0], ...lobby.spectators[1], ...lobby.unassigned];
      // Delete empty lobbies.
      if (all.length === 0) { clearTimer(lobby); lobbies.delete(myLobby); return; }
      // Transfer host if the host disconnected.
      if (socket.id === lobby.hostId) {
        const nh = lobby.captains[0] || lobby.captains[1] || all[0];
        if (nh) lobby.hostId = nh.id;
      }
      broadcast(lobby);
    }
    // During active drafts, players remain in the lobby (can rejoin).
  });
});

// ═══════════════════════════════════════════════════════════
//  SERVER STARTUP
// ═══════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Deadlock Draft server listening on port ${PORT}`));
