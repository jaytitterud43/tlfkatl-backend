// Scoring engine for TLFKATL World Cup 2026.
// Pure functions: given players' picks and the match results we've stored,
// compute each player's points. No network here — server.js feeds it data.

const { TEAMS, ID_TO_NAME } = require("./teams.js");

// Our canonical groups + the standard 6-game pairing order, matching the
// frontend exactly so game ids line up (A1..A6, B1..B6, ...).
const GROUPS = {
  A:["Mexico","South Korea","South Africa","Czechia"],
  B:["Canada","Switzerland","Qatar","Bosnia-Herzegovina"],
  C:["Brazil","Morocco","Scotland","Haiti"],
  D:["United States","Paraguay","Australia","Türkiye"],
  E:["Germany","Ecuador","Ivory Coast","Curaçao"],
  F:["Netherlands","Japan","Tunisia","Sweden"],
  G:["Belgium","Iran","Egypt","New Zealand"],
  H:["Spain","Uruguay","Saudi Arabia","Cape Verde"],
  I:["France","Senegal","Norway","Iraq"],
  J:["Argentina","Austria","Algeria","Jordan"],
  K:["Portugal","Colombia","Uzbekistan","DR Congo"],
  L:["England","Croatia","Panama","Ghana"],
};
const PAIRINGS = [[0,1],[2,3],[0,2],[1,3],[0,3],[1,2]];
const GLETTERS = Object.keys(GROUPS);

// Build the canonical game list: id -> {home, away, group, upset eligibility}
function buildGames(){
  const games = {};
  for (const L of GLETTERS){
    const t = GROUPS[L];
    PAIRINGS.forEach(([i,j],idx)=>{
      const home=t[i], away=t[j];
      const gap = Math.abs(TEAMS[home].rank - TEAMS[away].rank);
      games[`${L}${idx+1}`] = { id:`${L}${idx+1}`, group:L, home, away, upsetGap: gap>=10 };
    });
  }
  return games;
}
const GAMES = buildGames();

// Scoring constants (locked with the user)
const PTS = { correct:3, upset:2, perfectGroup:10 };

// ── Score one player's Phase 1 ──
// results: { gameId: {homeScore, awayScore, status} }  (only 'completed' count)
// finalStandings: { groupLetter: [team1st, team2nd, team3rd, team4th] }  (when group done)
function scorePhase1(player, results, finalStandings){
  let pts = 0;
  const detail = { perGame:0, upset:0, groupOrder:0, correctGames:0, upsetHits:0, perfectGroups:0 };

  // per-game + upset
  for (const [gid, g] of Object.entries(GAMES)){
    const r = results[gid];
    if (!r || r.status !== "completed") continue;
    const pick = player.picks[gid];           // "home" | "draw" | "away"
    if (!pick) continue;
    const actual = r.homeScore > r.awayScore ? "home"
                 : r.homeScore < r.awayScore ? "away" : "draw";
    if (pick === actual){
      pts += PTS.correct; detail.perGame += PTS.correct; detail.correctGames++;
      // upset bonus: correctly picked the lower-ranked side to WIN (not draw),
      // in a game with a 10+ rank gap.
      if (g.upsetGap && pick !== "draw"){
        const winner = pick === "home" ? g.home : g.away;
        const loser  = pick === "home" ? g.away : g.home;
        if (TEAMS[winner].rank > TEAMS[loser].rank){   // higher number = lower ranked
          pts += PTS.upset; detail.upset += PTS.upset; detail.upsetHits++;
        }
      }
    }
  }

  // perfect group order (+10), only for groups that are finalized
  for (const L of GLETTERS){
    const actualOrder = finalStandings[L];
    const predicted = player.order[L];
    if (!actualOrder || !predicted || predicted.length !== 4) continue;
    const exact = actualOrder.every((team,i)=>predicted[i]===team);
    if (exact){ pts += PTS.perfectGroup; detail.groupOrder += PTS.perfectGroup; detail.perfectGroups++; }
  }

  return { points: pts, detail };
}

// Phase 2 bracket scoring values per correct pick, by round.
const BRACKET_PTS = { r32:6, r16:10, qf:18, sf:30, final:52 };

// R16 games auto-awarded to everyone (already underway when the re-pick opened),
// keyed by sorted team pair. Everyone gets full R16 points (10) for these.
const AUTO_AWARD_R16 = [
  ["Canada","Morocco"],
  ["France","Paraguay"],
];
const AUTO_KEYS = AUTO_AWARD_R16.map(p => p.slice().sort().join("|"));

// Map our round keys to the round names the poller stores (from the API stage name).
const ROUND_NAME = { r32:"Round of 32", r16:"Round of 16", qf:"Quarterfinal", sf:"Semifinal", final:"Final" };

// Normalize round names so "Quarterfinal"/"Quarterfinals"/"quarter-final" all compare equal.
function roundNameMatches(actual, want){
  if (!actual || !want) return false;
  const norm = s => String(s).toLowerCase().replace(/[-\s]/g,"").replace(/s$/,"");
  return norm(actual) === norm(want);
}

// Did `team` win its real game in the given round? Opponent-agnostic and round-scoped.
// A team plays at most one game per round, so we find that game and check the winner.
function teamWonInRound(team, roundKey, koByPair){
  const wantRound = ROUND_NAME[roundKey];
  for (const g of Object.values(koByPair)){
    if (!g) continue;
    if (g.home !== team && g.away !== team) continue;      // team not in this game
    if (g.round && !roundNameMatches(g.round, wantRound)) continue; // wrong round, skip
    if (!g.winner) return false;                            // team's game not decided yet
    return g.winner === team;                               // credit iff team won it
  }
  return false;                                             // no game found for team this round
}

// Score a person's bracket.
//   bracket  = ORIGINAL submission (R32 only): {r32:[{match,pick}], ...}
//   bracket2 = RE-PICK (R16 onward): {r16,qf,sf,final,champion}
//   koByPair = { "TeamA|TeamB": {winner, home, away, round, ...} } actual results.
// R32 & auto games unchanged. R16/QF/SF/Final now score on "did my picked team win
// its real game that round" — the projected opponent is irrelevant.
function scorePhase2(bracket, bracket2, koByPair){
  let pts = 0;
  const detail = { r32:0, r16:0, qf:0, sf:0, final:0, autoR16:0 };

  // R32 — from original bracket (exact matchup is correct by construction; keep as-is)
  for (const g of (bracket?.r32 || [])){
    if (!g || !g.pick || !g.match || g.match.length!==2) continue;
    const [a,b] = g.match; if (!a||!b) continue;
    const actual = koByPair[[a,b].sort().join("|")];
    if (!actual || !actual.winner) continue;
    if (g.pick === actual.winner){ pts += BRACKET_PTS.r32; detail.r32++; }
  }

  // Auto-awarded R16 games — everyone gets full R16 points, no pick needed
  for (const k of AUTO_KEYS){
    pts += BRACKET_PTS.r16; detail.autoR16++;
  }

  // R16 onward — score by whether the PICKED TEAM won its real game that round.
  for (const round of ["r16","qf","sf","final"]){
    for (const g of (bracket2?.[round] || [])){
      if (!g || !g.pick) continue;
      // skip the auto-awarded R16 games (already credited to everyone)
      if (round==="r16" && g.match && g.match.length===2){
        const key = [g.match[0],g.match[1]].sort().join("|");
        if (AUTO_KEYS.includes(key)) continue;
      }
      if (teamWonInRound(g.pick, round, koByPair)){
        pts += BRACKET_PTS[round]; detail[round]++;
      }
    }
  }

  return { points: pts, detail };
}

module.exports = { GAMES, GROUPS, GLETTERS, TEAMS, scorePhase1, scorePhase2, PTS, BRACKET_PTS, AUTO_AWARD_R16 };
