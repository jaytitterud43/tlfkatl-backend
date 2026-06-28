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
const { fetchMatches, mapResults, deriveStandings } = require("./poller.js");
const { scorePhase1, TEAMS } = require("./scoring.js");

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
  console.log("DB ready");
}

async function poll(){
  if (!API_KEY){ console.warn("No BDL_API_KEY set — skipping poll"); return; }
  try {
    const matches = await fetchMatches(API_KEY);
    const { results, liveScores } = mapResults(matches);
    const standings = deriveStandings(results);
    CACHE = { results, liveScores, standings, updatedAt: Date.now() };
    console.log(`Polled ${matches.length} matches; ${Object.keys(results).length} group games mapped; ${Object.keys(standings).length} groups final.`);
  } catch(e){ console.error("Poll failed:", e.message); }
}

async function leaderboard(){
  const r = await pool.query("SELECT * FROM picks");
  const players = r.rows.map(row=>({
    username: row.username, phone: row.phone,
    picks: row.picks, order: row.group_order, bets: row.bets,
  }));
  const board = players.map(p=>{
    const { points, detail } = scorePhase1(p, CACHE.results, CACHE.standings);
    return {
      username: p.username, points, detail,
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

app.post("/refresh", async (_req,res)=>{ await poll(); res.json({ok:true, updatedAt:CACHE.updatedAt}); });

app.get("/", (_req,res)=>res.send("TLFKATL backend v2 running."));

const PORT = process.env.PORT || 3001;
init().then(()=>{
  poll();
  setInterval(poll, 90*1000);
  app.listen(PORT, ()=>console.log("Listening on "+PORT));
});
