// TLFKATL World Cup 2026 — backend (v2: with live API scoring)
// Endpoints:
//   POST /picks            save a player's submission
//   GET  /picks            all submissions (raw)
//   GET  /picks/:username  one player
//   GET  /scores           computed leaderboard (Phase 1)
//   GET  /live             live/recent match scores (ESPN-style feed)
//   POST /refresh          force a poll now (handy for testing)

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const { fetchMatches, mapResults, deriveStandings, knockoutResults } = require("./poller.js");
const { scorePhase1, scorePhase2, TEAMS } = require("./scoring.js");

// ── Bucket 3: prop settlement (frozen once, end of tournament) ──
// Penaldo v Pessi: +5 to "Pessi" pickers. Golden Nostril: +5 to "No — they don't"
// (Portugal missed the semis). Dark Horse: +18 to "Norway" pickers (reached QF).
// Flop: nobody correct (0). Chum v Cum: +5 to "Chum (Africa)" pickers.
// Values computed from each player's stored bets and locked in here.
const PROP_POINTS = {
  "tittenheimer": 28,
  "goose": 23,
  "johnaldinho": 15,
  "vansteenhuyse_nick": 15,
  "gavinweitzenberg": 15,
  "jbdd": 15,
  "natekush": 10,
  "cam": 10,
  "cassiusthundercock": 10,
  "maxcondron": 10,
  "als7": 5,
  "will khouri": 5,
};

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
const API_KEY = process.env.BDL_API_KEY;
// Optional manual lock controls:
//   LOCK_PICKS=true        -> force locked regardless of time
//   LOCK_PICKS=false       -> force open regardless of time
//   (unset)                -> auto: lock once the first match kicks off
const LOCK_OVERRIDE = process.env.LOCK_PICKS;

let CACHE = { results:{}, liveScores:[], standings:{}, updatedAt:0 };

// Returns { locked:bool, kickoff:ISO|null } — auto-derives the cutoff from the
// earliest scheduled match in the live feed, so it tracks the real schedule.
function lockState(){
  if (LOCK_OVERRIDE === "true")  return { locked:true,  kickoff:null, forced:true };
  if (LOCK_OVERRIDE === "false") return { locked:false, kickoff:null, forced:true };
  const ms = CACHE.liveScores || [];
  if (!ms.length) return { locked:false, kickoff:null };   // no data yet -> stay open
  let earliest = null;
  for (const m of ms){
    const t = new Date(m.datetime).getTime();
    if (!isNaN(t) && (earliest===null || t<earliest)) earliest = t;
  }
  if (earliest===null) return { locked:false, kickoff:null };
  return { locked: Date.now() >= earliest, kickoff: new Date(earliest).toISOString() };
}

async function init(){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS picks (
      username TEXT PRIMARY KEY, phone TEXT NOT NULL,
      picks JSONB NOT NULL, group_order JSONB NOT NULL, bets JSONB NOT NULL,
      submitted_at BIGINT NOT NULL
    );`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS brackets (
      username TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      bracket JSONB NOT NULL,
      submitted_at BIGINT NOT NULL
    );`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS brackets2 (
      username TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      bracket JSONB NOT NULL,
      submitted_at BIGINT NOT NULL
    );`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS brackets3 (
      username TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      bracket JSONB NOT NULL,
      submitted_at BIGINT NOT NULL
    );`);
  console.log("DB ready");
}

async function poll(){
  if (!API_KEY){ console.warn("No BDL_API_KEY set — skipping poll"); return; }
  try {
    const matches = await fetchMatches(API_KEY);
    const { results, liveScores } = mapResults(matches);
    const standings = deriveStandings(results);
    const { koByPair, liveKO } = knockoutResults(matches);
    CACHE = { results, liveScores, standings, koByPair, liveKO, updatedAt: Date.now() };
    const koDone = Object.values(koByPair).filter(k=>k.winner).length;
    console.log(`Polled ${matches.length} matches; ${Object.keys(results).length} group games; ${Object.keys(standings).length} groups final; ${koDone} knockout results.`);
  } catch(e){ console.error("Poll failed:", e.message); }
}

async function leaderboard(){
  const r = await pool.query("SELECT * FROM picks");
  const players = r.rows.map(row=>({
    username: row.username, phone: row.phone,
    picks: row.picks, order: row.group_order, bets: row.bets,
  }));
  // bracket picks keyed by username
  const br = await pool.query("SELECT * FROM brackets");
  const brByUser = {};
  for (const row of br.rows) brByUser[row.username] = row.bracket;
  // re-picks (correct-tree R16 onward) keyed by username
  const br2 = await pool.query("SELECT * FROM brackets2");
  const br2ByUser = {};
  for (const row of br2.rows) br2ByUser[row.username] = row.bracket;
  // semis/final re-picks keyed by username (may be empty table early)
  const br3ByUser = {};
  try {
    const br3 = await pool.query("SELECT * FROM brackets3");
    for (const row of br3.rows) br3ByUser[row.username] = row.bracket;
  } catch(e){ /* table may not exist yet; ignore */ }

  const board = players.map(p=>{
    const p1 = scorePhase1(p, CACHE.results, CACHE.standings);
    const p2 = scorePhase2(brByUser[p.username], br2ByUser[p.username], CACHE.koByPair || {}, br3ByUser[p.username]);
    const p3 = PROP_POINTS[p.username] || 0;   // Bucket 3: one-time prop settlement (frozen)
    return {
      username: p.username,
      points: p1.points + p2.points + p3,
      phase1: p1.points, phase2: p2.points, phase3: p3,
      detail: p1.detail, bracketDetail: p2.detail,
      darkhorse: p.bets.darkhorse || null,
      flop: p.bets.flop || null,
      goldenboot: p.bets.goldenboot || null,
    };
  }).sort((a,b)=> b.points - a.points);
  return board;
}

app.post("/picks", async (req,res)=>{
  try{
    const lock = lockState();
    if (lock.locked){
      return res.status(403).json({ error:"Picks are locked. The tournament has started.", locked:true });
    }
    const { username, phone, picks, order, bets, submittedAt } = req.body;
    if(!username||!phone||!picks||!order||!bets) return res.status(400).json({error:"Missing fields"});
    const u = String(username).trim().toLowerCase();
    await pool.query(
      `INSERT INTO picks (username,phone,picks,group_order,bets,submitted_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (username) DO UPDATE SET phone=$2,picks=$3,group_order=$4,bets=$5,submitted_at=$6`,
      [u, String(phone).trim(), JSON.stringify(picks), JSON.stringify(order), JSON.stringify(bets), submittedAt||Date.now()]
    );
    res.json({ok:true});
  }catch(e){ console.error(e); res.status(500).json({error:"Save failed"}); }
});

// lets the frontend check lock status (to show a "locked" screen)
app.get("/lockstatus", (_req,res)=> res.json(lockState()));

// ── BRACKET ──
// Bracket locks at the first knockout (R32) kickoff: 2026-06-28T19:00:00Z.
// Override with BRACKET_LOCK=true/false.
const BRACKET_KICKOFF = Date.parse("2026-06-28T19:00:00Z");
function bracketLocked(){
  const o=process.env.BRACKET_LOCK;
  if(o==="true") return true;
  if(o==="false") return false;
  return Date.now() >= BRACKET_KICKOFF;
}

app.post("/bracket", async (req,res)=>{
  try{
    if(bracketLocked()) return res.status(403).json({error:"Bracket is locked. Knockouts have started.",locked:true});
    const { username, phone, bracket, submittedAt } = req.body;
    if(!username||!phone||!bracket) return res.status(400).json({error:"Missing fields"});
    const u=String(username).trim().toLowerCase();
    await pool.query(
      `INSERT INTO brackets (username,phone,bracket,submitted_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (username) DO UPDATE SET phone=$2,bracket=$3,submitted_at=$4`,
      [u, String(phone).trim(), JSON.stringify(bracket), submittedAt||Date.now()]
    );
    res.json({ok:true});
  }catch(e){ console.error(e); res.status(500).json({error:"Save failed"}); }
});

app.get("/brackets", async (_req,res)=>{
  try{ const r=await pool.query("SELECT * FROM brackets ORDER BY submitted_at ASC"); res.json(r.rows); }
  catch(e){ res.status(500).json({error:"Read failed"}); }
});

app.get("/bracket/:username", async (req,res)=>{
  try{ const r=await pool.query("SELECT * FROM brackets WHERE username=$1",[req.params.username.trim().toLowerCase()]);
    res.json(r.rows[0]||null);
  }catch(e){ res.status(500).json({error:"Read failed"}); }
});

// ── BRACKET RE-PICK (correct-tree R16 onward) ──
// Per-game lock: a matchup is locked once its kickoff has passed (from live feed).
// The two auto-awarded R16 games (Canada/Morocco, France/Paraguay) are not re-picked.
const AUTO_R16_KEYS = [["Canada","Morocco"],["France","Paraguay"]].map(p=>p.slice().sort().join("|"));

// kickoff time (ms) for a matchup, looked up from the knockout live feed by team pair
function koKickoff(a,b){
  const key=[a,b].sort().join("|");
  const g = (CACHE.koByPair||{})[key];
  return g?.datetime ? Date.parse(g.datetime) : null;
}
function matchupLocked(a,b){
  const o=process.env.BRACKET2_LOCK;
  if(o==="false") return false;      // force everything open (testing)
  if(o==="true") return true;        // force everything locked
  const t=koKickoff(a,b);
  if(t===null) return false;         // unknown/not scheduled yet -> open
  return Date.now() >= t;            // locked once it kicks off
}

app.post("/bracket2", async (req,res)=>{
  try{
    const { username, phone, bracket, submittedAt } = req.body;
    if(!username||!phone||!bracket) return res.status(400).json({error:"Missing fields"});
    const u=String(username).trim().toLowerCase();

    // Reject picks for any R16 game that's already kicked off (or auto-awarded).
    for (const g of (bracket.r16||[])){
      if(!g||!g.match||g.match.length!==2) continue;
      const [a,b]=g.match; if(!a||!b) continue;
      const key=[a,b].sort().join("|");
      if(AUTO_R16_KEYS.includes(key)) continue;       // not re-picked; ignore if present
      if(matchupLocked(a,b)){
        return res.status(403).json({error:`That matchup (${a} v ${b}) has already kicked off.`,locked:true});
      }
    }
    await pool.query(
      `INSERT INTO brackets2 (username,phone,bracket,submitted_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (username) DO UPDATE SET phone=$2,bracket=$3,submitted_at=$4`,
      [u, String(phone).trim(), JSON.stringify(bracket), submittedAt||Date.now()]
    );
    res.json({ok:true});
  }catch(e){ console.error(e); res.status(500).json({error:"Save failed"}); }
});

app.get("/brackets2", async (_req,res)=>{
  try{ const r=await pool.query("SELECT * FROM brackets2 ORDER BY submitted_at ASC"); res.json(r.rows); }
  catch(e){ res.status(500).json({error:"Read failed"}); }
});
app.get("/bracket2/:username", async (req,res)=>{
  try{ const r=await pool.query("SELECT * FROM brackets2 WHERE username=$1",[req.params.username.trim().toLowerCase()]);
    res.json(r.rows[0]||null);
  }catch(e){ res.status(500).json({error:"Read failed"}); }
});

// ── bracket3: semis/final re-pick (made once all QFs known) ──
// Locks once any semifinal has kicked off. Env BRACKET3_LOCK overrides ("true"/"false").
function semisLocked(){
  const o=process.env.BRACKET3_LOCK;
  if(o==="false") return false;
  if(o==="true") return true;
  const ko = CACHE.koByPair || {};
  return Object.values(ko).some(g =>
    g && g.round && String(g.round).toLowerCase().startsWith("semi") && g.status && g.status!=="scheduled"
  );
}
app.get("/bracket3lock", (_req,res)=> res.json({ locked: semisLocked() }));

app.post("/bracket3", async (req,res)=>{
  try{
    const { username, phone, bracket, submittedAt } = req.body;
    if(!username||!phone||!bracket) return res.status(400).json({error:"Missing fields"});
    if(semisLocked()) return res.status(403).json({error:"The semifinals have kicked off — picks are locked.",locked:true});
    const u=String(username).trim().toLowerCase();
    await pool.query(
      `INSERT INTO brackets3 (username,phone,bracket,submitted_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (username) DO UPDATE SET phone=$2,bracket=$3,submitted_at=$4`,
      [u, String(phone).trim(), JSON.stringify(bracket), submittedAt||Date.now()]
    );
    res.json({ok:true});
  }catch(e){ console.error(e); res.status(500).json({error:"Save failed"}); }
});

app.get("/brackets3", async (_req,res)=>{
  try{ const r=await pool.query("SELECT * FROM brackets3 ORDER BY submitted_at ASC"); res.json(r.rows); }
  catch(e){ res.status(500).json({error:"Read failed"}); }
});
app.get("/bracket3/:username", async (req,res)=>{
  try{ const r=await pool.query("SELECT * FROM brackets3 WHERE username=$1",[req.params.username.trim().toLowerCase()]);
    res.json(r.rows[0]||null);
  }catch(e){ res.status(500).json({error:"Read failed"}); }
});
// tells the re-pick UI which R16 matchups are still open vs locked
app.get("/repickstatus", (_req,res)=>{
  const r16 = (CACHE.liveKO||[]).filter(m=>{
    const key=[m.home,m.away].sort().join("|");
    return !AUTO_R16_KEYS.includes(key);
  });
  res.json({ autoAwarded:[["Canada","Morocco"],["France","Paraguay"]], matches:CACHE.liveKO||[], updatedAt:CACHE.updatedAt });
});

app.get("/bracketlock", (_req,res)=> res.json({locked:bracketLocked(), kickoff:new Date(BRACKET_KICKOFF).toISOString()}));

app.get("/picks", async (_req,res)=>{
  try{ const r=await pool.query("SELECT * FROM picks ORDER BY submitted_at ASC"); res.json(r.rows); }
  catch(e){ res.status(500).json({error:"Read failed"}); }
});

app.get("/picks/:username", async (req,res)=>{
  try{ const r=await pool.query("SELECT * FROM picks WHERE username=$1",[req.params.username.trim().toLowerCase()]);
    res.json(r.rows[0]||null);
  }catch(e){ res.status(500).json({error:"Read failed"}); }
});

app.get("/scores", async (_req,res)=>{
  try{ res.json({ leaderboard: await leaderboard(), standings: CACHE.standings, updatedAt: CACHE.updatedAt }); }
  catch(e){ console.error(e); res.status(500).json({error:"Score failed"}); }
});

app.get("/live", (_req,res)=>{ res.json({ matches: CACHE.liveScores, updatedAt: CACHE.updatedAt }); });
app.get("/knockout", (_req,res)=>{ res.json({ matches: CACHE.liveKO || [], koByPair: CACHE.koByPair || {}, updatedAt: CACHE.updatedAt }); });

app.post("/refresh", async (_req,res)=>{ await poll(); res.json({ok:true, updatedAt:CACHE.updatedAt}); });

app.get("/", (_req,res)=>res.send("TLFKATL backend v2 running."));

const PORT = process.env.PORT || 3001;
init().then(()=>{
  poll();
  setInterval(poll, 90*1000);
  app.listen(PORT, ()=>console.log("Listening on "+PORT));
});
