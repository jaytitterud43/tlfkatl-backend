// Maps our app's team names <-> BALLDONTLIE team IDs, and holds the frozen
// FIFA ranks used for the upset bonus. Anchored on the API's numeric team IDs
// (stable; names/spellings are not). Built from the real /teams response.

const TEAMS = {
  // our name : { id: BDL team id, rank: frozen FIFA rank, conf }
  "Mexico":              { id: 1,  rank: 15, conf: "CONCACAF" },
  "South Korea":         { id: 3,  rank: 23, conf: "AFC" },
  "South Africa":        { id: 2,  rank: 61, conf: "CAF" },
  "Czechia":             { id: 4,  rank: 44, conf: "UEFA" },
  "Canada":              { id: 5,  rank: 30, conf: "CONCACAF" },
  "Switzerland":         { id: 8,  rank: 19, conf: "UEFA" },
  "Qatar":               { id: 7,  rank: 36, conf: "AFC" },
  "Bosnia-Herzegovina":  { id: 6,  rank: 74, conf: "UEFA" },   // API: "Bosnia & Herzegovina"
  "Brazil":              { id: 9,  rank: 6,  conf: "CONMEBOL" },
  "Morocco":             { id: 10, rank: 8,  conf: "CAF" },
  "Scotland":            { id: 12, rank: 39, conf: "UEFA" },
  "Haiti":               { id: 11, rank: 83, conf: "CONCACAF" },
  "United States":       { id: 13, rank: 16, conf: "CONCACAF" }, // API: "USA"
  "Paraguay":            { id: 14, rank: 38, conf: "CONMEBOL" },
  "Australia":           { id: 15, rank: 26, conf: "AFC" },
  "Türkiye":             { id: 16, rank: 27, conf: "UEFA" },
  "Germany":             { id: 17, rank: 10, conf: "UEFA" },
  "Ecuador":             { id: 20, rank: 24, conf: "CONMEBOL" },
  "Ivory Coast":         { id: 19, rank: 40, conf: "CAF" },     // API: "Côte d'Ivoire"
  "Curaçao":             { id: 18, rank: 82, conf: "CONCACAF" },
  "Netherlands":         { id: 21, rank: 7,  conf: "UEFA" },
  "Japan":               { id: 22, rank: 18, conf: "AFC" },
  "Tunisia":             { id: 24, rank: 41, conf: "CAF" },
  "Sweden":              { id: 23, rank: 29, conf: "UEFA" },
  "Belgium":             { id: 25, rank: 9,  conf: "UEFA" },
  "Iran":                { id: 27, rank: 21, conf: "AFC" },
  "Egypt":               { id: 26, rank: 33, conf: "CAF" },
  "New Zealand":         { id: 28, rank: 86, conf: "OFC" },
  "Spain":               { id: 29, rank: 2,  conf: "UEFA" },
  "Uruguay":             { id: 32, rank: 17, conf: "CONMEBOL" },
  "Saudi Arabia":        { id: 31, rank: 58, conf: "AFC" },
  "Cape Verde":          { id: 30, rank: 70, conf: "CAF" },     // API: "Cabo Verde"
  "France":              { id: 33, rank: 1,  conf: "UEFA" },
  "Senegal":             { id: 34, rank: 14, conf: "CAF" },
  "Norway":              { id: 36, rank: 30, conf: "UEFA" },
  "Iraq":                { id: 35, rank: 57, conf: "AFC" },
  "Argentina":           { id: 37, rank: 3,  conf: "CONMEBOL" },
  "Austria":             { id: 39, rank: 25, conf: "UEFA" },
  "Algeria":             { id: 38, rank: 42, conf: "CAF" },
  "Jordan":              { id: 40, rank: 62, conf: "AFC" },
  "Portugal":            { id: 41, rank: 5,  conf: "UEFA" },
  "Colombia":            { id: 42, rank: 13, conf: "CONMEBOL" },
  "Uzbekistan":          { id: 43, rank: 53, conf: "AFC" },
  "DR Congo":            { id: 44, rank: 56, conf: "CAF" },
  "England":             { id: 45, rank: 4,  conf: "UEFA" },
  "Croatia":             { id: 46, rank: 11, conf: "UEFA" },
  "Panama":              { id: 48, rank: 31, conf: "CONCACAF" },
  "Ghana":               { id: 47, rank: 72, conf: "CAF" },
};

// reverse lookup: BDL id -> our name
const ID_TO_NAME = {};
for (const [name, t] of Object.entries(TEAMS)) ID_TO_NAME[t.id] = name;

module.exports = { TEAMS, ID_TO_NAME };
