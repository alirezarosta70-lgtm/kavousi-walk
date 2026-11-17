const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "20kb" }));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "algadir.na";
const DATABASE_URL = process.env.DATABASE_URL || "";

/* ---------- Storage: Postgres if DATABASE_URL set, otherwise a local JSON file ---------- */
let store;
if (DATABASE_URL) {
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  store = {
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS registrations (
        id SERIAL PRIMARY KEY,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        attending BOOLEAN NOT NULL,
        companions INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    },
    async add(r) {
      await pool.query(
        "INSERT INTO registrations (first_name,last_name,attending,companions) VALUES ($1,$2,$3,$4)",
        [r.firstName, r.lastName, r.attending, r.companions]
      );
    },
    async list() {
      const { rows } = await pool.query(
        "SELECT id, first_name AS \"firstName\", last_name AS \"lastName\", attending, companions, created_at AS \"createdAt\" FROM registrations ORDER BY id DESC"
      );
      return rows;
    },
    async remove(id) {
      await pool.query("DELETE FROM registrations WHERE id=$1", [id]);
    },
  };
} else {
  const file = path.join(__dirname, "data.json");
  const read = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : []);
  const write = (d) => fs.writeFileSync(file, JSON.stringify(d));
  store = {
    async init() {},
    async add(r) {
      const d = read();
      d.push({ id: Date.now() + Math.floor(Math.random() * 1000), ...r, createdAt: new Date().toISOString() });
      write(d);
    },
    async list() { return read().reverse(); },
    async remove(id) { write(read().filter((x) => x.id !== id)); },
  };
}

/* ---------- Helpers ---------- */
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim().slice(0, 60);

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// very small brute-force guard for the admin password
const fails = new Map();
function adminOk(req, res) {
  const ip = req.headers["x-forwarded-for"] || req.ip;
  const f = fails.get(ip) || { n: 0, t: 0 };
  if (f.n >= 8 && Date.now() - f.t < 15 * 60 * 1000) {
    res.status(429).json({ error: "تعداد تلاش‌ها زیاد بود. چند دقیقه بعد دوباره امتحان کنید." });
    return false;
  }
  if (!safeEqual(req.body && req.body.password, ADMIN_PASSWORD)) {
    fails.set(ip, { n: f.n + 1, t: Date.now() });
    res.status(401).json({ error: "رمز عبور اشتباه است." });
    return false;
  }
  fails.delete(ip);
  return true;
}

/* ---------- Routes ---------- */
app.post("/api/register", async (req, res) => {
  try {
    const firstName = clean(req.body.firstName);
    const lastName = clean(req.body.lastName);
    const attending = req.body.attending === true;
    let companions = parseInt(req.body.companions, 10);
    if (!firstName || !lastName) return res.status(400).json({ error: "نام و نام خانوادگی را وارد کنید." });
    if (typeof req.body.attending !== "boolean") return res.status(400).json({ error: "لطفاً یکی از گزینه‌های بله یا خیر را انتخاب کنید." });
    if (!attending) companions = 0;
    else if (!(companions >= 0 && companions <= 4)) return res.status(400).json({ error: "تعداد همراه معتبر نیست." });
    await store.add({ firstName, lastName, attending, companions });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "خطایی رخ داد. دوباره تلاش کنید." });
  }
});

app.post("/api/admin/list", async (req, res) => {
  if (!adminOk(req, res)) return;
  res.json({ rows: await store.list() });
});

app.post("/api/admin/delete", async (req, res) => {
  if (!adminOk(req, res)) return;
  await store.remove(req.body.id);
  res.json({ ok: true });
});

app.get("/admin", (_req, res) => res.sendFile(path.join(__dirname, "admin.html")));

const PORT = process.env.PORT || 3000;
store.init().then(() => app.listen(PORT, () => console.log("listening on " + PORT)));
