// TLFKATL World Cup 2026 — backend
// Two endpoints: POST /picks (save a submission), GET /picks (read all).
// Stores everything in Postgres. Designed for Render + a Neon database.

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
app.use(cors());                 // lets your Netlify frontend talk to this server
app.use(express.json({ limit: "1mb" }));

// ── Database connection ──────────────────────────────────────
// DATABASE_URL is set in Render's environment settings (from Neon).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },   // Neon requires SSL
});

// Create the table once on startup if it doesn't exist.
// One row per player. Picks/orders/bets stored as JSON blobs,
// but each is structured (keyed by match id / group letter / bet key)
// so the future leaderboard can read them cleanly.
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS picks (
      username    TEXT PRIMARY KEY,
      phone       TEXT NOT NULL,
      picks       JSONB NOT NULL,
      group_order JSONB NOT NULL,
      bets        JSONB NOT NULL,
      submitted_at BIGINT NOT NULL
    );
  `);
  console.log("DB ready");
}

// ── Save a submission ────────────────────────────────────────
// If a username submits again, it overwrites (one-and-done, but safe to redo).
app.post("/picks", async (req, res) => {
  try {
    const { username, phone, picks, order, bets, submittedAt } = req.body;
    if (!username || !phone || !picks || !order || !bets) {
      return res.status(400).json({ error: "Missing fields" });
    }
    const uname = String(username).trim().toLowerCase();
    await pool.query(
      `INSERT INTO picks (username, phone, picks, group_order, bets, submitted_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (username) DO UPDATE SET
         phone=$2, picks=$3, group_order=$4, bets=$5, submitted_at=$6`,
      [uname, String(phone).trim(), JSON.stringify(picks),
       JSON.stringify(order), JSON.stringify(bets), submittedAt || Date.now()]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Save failed" });
  }
});

// ── Read all submissions (for the leaderboard you'll build later) ──
app.get("/picks", async (_req, res) => {
  try {
    const r = await pool.query("SELECT * FROM picks ORDER BY submitted_at ASC");
    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Read failed" });
  }
});

// ── Check if a username already submitted (for the reclaim/login step) ──
app.get("/picks/:username", async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM picks WHERE username=$1",
      [req.params.username.trim().toLowerCase()]);
    res.json(r.rows[0] || null);
  } catch (e) {
    res.status(500).json({ error: "Read failed" });
  }
});

app.get("/", (_req, res) => res.send("TLFKATL backend is running."));

const PORT = process.env.PORT || 3001;
init().then(() => app.listen(PORT, () => console.log("Listening on " + PORT)));
