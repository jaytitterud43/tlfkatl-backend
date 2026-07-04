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

// Score a person's bracket.
//   bracket  = the ORIGINAL submission (used for R32 only): {r32:[{match,pick}], ...}
//   bracket2 = the RE-PICK on the correct tree (used for R16 onward): {r16,qf,sf,final,champion}
//   koByPair = { "TeamA|TeamB": {winner,...} } actual knockout results.
// R32 scores from `bracket`. The two AUTO_AWARD_R16 games give everyone 10 pts flat.
// All other R16/QF/SF/Final score from `bracket2` on the correct matchups.
function scorePhase2(bracket, bracket2, koByPair){
  let pts = 0;
  const detail = { r32:0, r16:0, qf:0, sf:0, final:0, autoR16:0 };

  // R32 — from original bracket
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

  // R16 onward — from the re-pick (correct tree). Skip auto-awarded games to avoid double count.
  for (const round of ["r16","qf","sf","final"]){
    for (const g of (bracket2?.[round] || [])){
      if (!g || !g.pick || !g.match || g.match.length!==2) continue;
      const [a,b] = g.match; if (!a||!b) continue;
      const key = [a,b].sort().join("|");
      if (round==="r16" && AUTO_KEYS.includes(key)) continue; // already auto-awarded
      const actual = koByPair[key];
      if (!actual || !actual.winner) continue;
      if (g.pick === actual.winner){ pts += BRACKET_PTS[round]; detail[round]++; }
    }
  }

  return { points: pts, detail };
}

module.exports = { GAMES, GROUPS, GLETTERS, TEAMS, scorePhase1, scorePhase2, PTS, BRACKET_PTS, AUTO_AWARD_R16 };
