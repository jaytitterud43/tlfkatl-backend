// Polls BALLDONTLIE for World Cup match data, maps it onto our canonical
// game ids, and derives group results + final standings for the scoring engine.

const { TEAMS, ID_TO_NAME } = require("./teams.js");
const { GAMES, GROUPS, GLETTERS } = require("./scoring.js");

const BASE = "https://api.balldontlie.io/fifa/worldcup/v1";

// Build a quick lookup: "homeId-awayId" (unordered) -> our game id, for group games only.
const PAIR_TO_GID = {};
for (const [gid, g] of Object.entries(GAMES)){
  const a = TEAMS[g.home].id, b = TEAMS[g.away].id;
  PAIR_TO_GID[[a,b].sort((x,y)=>x-y).join("-")] = gid;
}

// Fetch all 2026 matches (paginated by cursor). Returns raw match array.
async function fetchMatches(apiKey){
  let all = [], cursor = null;
  for (let i=0;i<10;i++){                       // safety cap on pages
    const url = new URL(`${BASE}/matches`);
    url.searchParams.set("per_page","100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url, { headers:{ Authorization: apiKey } });
    if (!res.ok) throw new Error(`matches fetch ${res.status}`);
    const json = await res.json();
    all = all.concat(json.data || []);
    cursor = json.meta && json.meta.next_cursor;
    if (!cursor) break;
  }
  return all;
}

// Turn raw matches into our results map { gid: {homeScore, awayScore, status, live...} }
// keyed to OUR game ids and oriented to OUR home/away (so picks line up).
function mapResults(matches){
  const results = {};
  const liveScores = [];   // for the frontend's ESPN-style display

  for (const m of matches){
    if (!m.home_team || !m.away_team) continue;     // knockout TBD slots
    if (!m.group) continue;                          // group games only for phase 1
    const hId = m.home_team.id, aId = m.away_team.id;
    const key = [hId,aId].sort((x,y)=>x-y).join("-");
    const gid = PAIR_TO_GID[key];
    if (!gid) continue;                              // not one of our 72 (shouldn't happen)

    const ourGame = GAMES[gid];
    // API home/away may be flipped vs our canonical home/away — orient to ours.
    const apiHomeName = ID_TO_NAME[hId];
    const sameOrientation = apiHomeName === ourGame.home;
    const ourHomeScore = sameOrientation ? m.home_score : m.away_score;
    const ourAwayScore = sameOrientation ? m.away_score : m.home_score;

    results[gid] = {
      homeScore: ourHomeScore,
      awayScore: ourAwayScore,
      status: m.status,                  // scheduled | in_progress | completed | ...
      datetime: m.datetime,
    };

    liveScores.push({
      gid, group: ourGame.group,
      home: ourGame.home, away: ourGame.away,
      homeScore: ourHomeScore ?? null, awayScore: ourAwayScore ?? null,
      status: m.status, datetime: m.datetime,
    });
  }
  return { results, liveScores };
}

// Extract KNOCKOUT results. Knockout games have no group. We key each result by
// the unordered pair of OUR team names, since each pairing is unique in a bracket.
// Winner accounts for penalty shootouts (a 90-min draw decided on pens).
function knockoutResults(matches){
  const out = {};            // "TeamA|TeamB" (sorted) -> { winner, a, b, status, datetime }
  const liveKO = [];
  for (const m of matches){
    if (!m.home_team || !m.away_team) continue;   // TBD slot, not set yet
    if (m.group) continue;                         // skip group games
    const hName = ID_TO_NAME[m.home_team.id];
    const aName = ID_TO_NAME[m.away_team.id];
    if (!hName || !aName) continue;
    const key = [hName, aName].sort().join("|");
    let winner = null;
    if (m.status === "completed"){
      if (m.home_score > m.away_score) winner = hName;
      else if (m.away_score > m.home_score) winner = aName;
      else {
        // draw after regulation/ET -> decided by penalties if the API provides them
        // penalty shootout — BALLDONTLIE uses *_score_penalties
        const hp = m.home_score_penalties ?? null;
        const ap = m.away_score_penalties ?? null;
        if (hp != null && ap != null) winner = hp > ap ? hName : aName;
        // if no pen data yet, leave winner null until the feed fills it in
      }
    }
    const hpen = m.home_score_penalties ?? null;
    const apen = m.away_score_penalties ?? null;
    // stage.name / round_name tell us which round this game is (Round of 32, Round of 16, etc.)
    const roundName = (m.stage && m.stage.name) || m.round_name || null;
    out[key] = { winner, home:hName, away:aName,
      homeScore:m.home_score ?? null, awayScore:m.away_score ?? null,
      homePens:hpen, awayPens:apen, pens:(hpen!=null&&apen!=null),
      round:roundName, status:m.status, datetime:m.datetime };
    liveKO.push({ home:hName, away:aName,
      homeScore:m.home_score ?? null, awayScore:m.away_score ?? null,
      homePens:hpen, awayPens:apen, pens:(hpen!=null&&apen!=null),
      round:roundName, status:m.status, datetime:m.datetime });
  }
  return { koByPair: out, liveKO };
}

// Derive final 1-4 standings per group, but ONLY for groups where all 6 games
// are completed. Uses points -> goal difference -> goals for (standard tiebreak).
function deriveStandings(results){
  const standings = {};
  for (const L of GLETTERS){
    const gids = [1,2,3,4,5,6].map(n=>`${L}${n}`);
    const allDone = gids.every(g => results[g] && results[g].status === "completed");
    if (!allDone) continue;

    const table = {};
    for (const team of GROUPS[L]) table[team] = { team, pts:0, gd:0, gf:0 };
    for (const gid of gids){
      const r = results[gid];
      const { home, away } = GAMES[gid];
      const hs = r.homeScore, as = r.awayScore;
      table[home].gf += hs; table[away].gf += as;
      table[home].gd += hs-as; table[away].gd += as-hs;
      if (hs>as){ table[home].pts += 3; }
      else if (hs<as){ table[away].pts += 3; }
      else { table[home].pts += 1; table[away].pts += 1; }
    }
    const ordered = Object.values(table).sort((x,y)=>
      y.pts-x.pts || y.gd-x.gd || y.gf-x.gf
    ).map(r=>r.team);
    standings[L] = ordered;
  }
  return standings;
}

module.exports = { fetchMatches, mapResults, deriveStandings, knockoutResults };
