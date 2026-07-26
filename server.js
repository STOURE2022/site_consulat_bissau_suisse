/* ============================================================================
   SERVEUR — Consulat honoraire de la République de Guinée-Bissau en Suisse
   ----------------------------------------------------------------------------
   Rôle : servir le site (dossier « public/ ») ET traiter les formulaires de
   contact et de rendez-vous, en relayant chaque demande par courriel.

   Aucune donnée personnelle n'est stockée sur le serveur : les demandes sont
   uniquement transmises par e-mail (minimisation des données — nLPD / RGPD).

   Configuration par variables d'environnement (voir .env.example) :
     PORT                 fourni automatiquement par Railway
     SMTP_HOST/PORT/...   serveur d'envoi d'e-mails (Suisse ou UE de préférence)
     MAIL_TO / MAIL_FROM  destinataire et expéditeur des notifications
   ============================================================================ */
"use strict";

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

/* -------------------------------------------------------------------------- */
/* Base de données PostgreSQL (fournie par Railway via DATABASE_URL).          */
/* Sans DATABASE_URL, les fonctions de publication sont désactivées et le site */
/* retombe sur les actualités statiques : le reste du site fonctionne quand    */
/* même (utile en local avant configuration).                                  */
/* -------------------------------------------------------------------------- */
let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Connexion interne Railway : pas de SSL. Pour une URL publique/externe,
    // définir PGSSL=require.
    ssl: process.env.PGSSL === "require" ? { rejectUnauthorized: false } : false,
  });
  pool.on("error", function (e) { console.error("Erreur pool PostgreSQL :", e && e.message); });
}

/* Crée les tables si nécessaire (idempotent). */
async function initBase() {
  if (!pool) return;
  await pool.query(
    "CREATE TABLE IF NOT EXISTS publications (" +
      "id SERIAL PRIMARY KEY, titre TEXT NOT NULL, rubrique TEXT NOT NULL, " +
      "date_pub DATE NOT NULL, resume TEXT, corps TEXT NOT NULL, " +
      "une BOOLEAN DEFAULT FALSE, cree_le TIMESTAMPTZ DEFAULT now())"
  );
  await pool.query(
    "CREATE TABLE IF NOT EXISTS fichiers (" +
      "id SERIAL PRIMARY KEY, publication_id INTEGER REFERENCES publications(id) ON DELETE CASCADE, " +
      "nom TEXT NOT NULL, type_mime TEXT NOT NULL, est_image BOOLEAN DEFAULT FALSE, " +
      "contenu BYTEA NOT NULL, taille INTEGER)"
  );
}

/* Réception des pièces jointes en mémoire (max 10 Mo/fichier, 8 fichiers). */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 8 },
  fileFilter: function (req, file, cb) {
    cb(null, /^image\//.test(file.mimetype) || file.mimetype === "application/pdf");
  },
});

/* Authentification de l'espace d'administration (HTTP Basic).
   Identifiants définis par ADMIN_USER / ADMIN_PASSWORD (variables Railway). */
function egaliteConstante(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
function adminAuth(req, res, next) {
  const user = process.env.ADMIN_USER, pass = process.env.ADMIN_PASSWORD;
  if (!user || !pass) {
    return res.status(503).json({ ok: false, erreur: "Espace d'administration non configuré (ADMIN_USER / ADMIN_PASSWORD)." });
  }
  const m = (req.headers.authorization || "").match(/^Basic (.+)$/);
  if (m) {
    const paire = Buffer.from(m[1], "base64").toString();
    const i = paire.indexOf(":");
    const u = paire.slice(0, i), p = paire.slice(i + 1);
    if (egaliteConstante(u, user) && egaliteConstante(p, pass)) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Espace consulat"');
  return res.status(401).json({ ok: false, erreur: "Authentification requise." });
}

/* Railway place l'application derrière un proxy : nécessaire pour que le
   limiteur de débit identifie correctement l'adresse d'origine. */
app.set("trust proxy", 1);

/* En-têtes de sécurité, cohérents avec un site sans ressource tierce.
   La politique CSP autorise uniquement le même domaine (et les styles/scripts
   internes en ligne, tels que le site les utilise) : aucun appel externe. */
app.use(function (req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
      "script-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; " +
      "frame-ancestors 'self'; base-uri 'self'; form-action 'self'"
  );
  next();
});

app.use(express.json({ limit: "20kb" }));

/* Fichiers statiques (le site). */
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));

/* Limiteur de débit sur les endpoints d'envoi : 20 requêtes / 15 min / IP. */
app.use(
  "/api/",
  rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false })
);

/* -------------------------------------------------------------------------- */
/* Transport e-mail — créé uniquement si les variables SMTP sont présentes.    */
/* Sans configuration SMTP, les demandes sont journalisées (utile en phase de  */
/* test) et l'utilisateur reçoit tout de même une confirmation.                */
/* -------------------------------------------------------------------------- */
let transport = null;
if (process.env.SMTP_HOST) {
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "587", 10),
    secure: process.env.SMTP_SECURE === "true", // true pour le port 465
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
}

function estCourriel(v) {
  return typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}
function txt(v) {
  return typeof v === "string" ? v.trim() : "";
}

async function envoyer(sujet, corps, replyTo) {
  if (!transport) {
    console.log("[E-MAIL NON CONFIGURÉ] " + sujet + "\n" + corps + "\n");
    return { livre: false };
  }
  await transport.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: process.env.MAIL_TO || process.env.SMTP_USER,
    replyTo: replyTo || undefined,
    subject: sujet,
    text: corps,
  });
  return { livre: true };
}

/* -------------------------------------------------------------------------- */
/* Formulaire de contact                                                       */
/* -------------------------------------------------------------------------- */
app.post("/api/contact", async function (req, res) {
  const b = req.body || {};
  if (b.site) return res.json({ ok: true }); // honeypot rempli => robot ignoré

  const nom = txt(b.nom),
    courriel = txt(b.courriel),
    message = txt(b.message),
    objet = txt(b.objet) || "Sans objet";

  if (!nom || !estCourriel(courriel) || !message) {
    return res.status(400).json({ ok: false, erreur: "Champs manquants ou invalides." });
  }

  const corps =
    "Nouveau message de contact\n\n" +
    "Nom : " + nom + "\n" +
    "Courriel : " + courriel + "\n" +
    "Objet : " + objet + "\n\n" +
    "Message :\n" + message + "\n";

  try {
    const r = await envoyer("[Site] Contact — " + objet, corps, courriel);
    res.json({ ok: true, livre: r.livre });
  } catch (e) {
    console.error("Erreur envoi contact :", e && e.message);
    res.status(502).json({ ok: false, erreur: "Envoi impossible pour le moment." });
  }
});

/* -------------------------------------------------------------------------- */
/* Demande de rendez-vous                                                      */
/* -------------------------------------------------------------------------- */
app.post("/api/rendezvous", async function (req, res) {
  const b = req.body || {};
  if (b.site) return res.json({ ok: true });

  const nom = txt(b.nom),
    courriel = txt(b.courriel),
    tel = txt(b.tel),
    motif = txt(b.motif),
    jour = txt(b.jour),
    heure = txt(b.heure),
    message = txt(b.message);

  if (!nom || !estCourriel(courriel) || !tel || !motif || !jour || !heure) {
    return res.status(400).json({ ok: false, erreur: "Champs manquants ou invalides." });
  }

  const corps =
    "Nouvelle demande de rendez-vous\n\n" +
    "Motif : " + motif + "\n" +
    "Jour souhaité : " + jour + "\n" +
    "Créneau : " + heure + "\n\n" +
    "Nom : " + nom + "\n" +
    "Courriel : " + courriel + "\n" +
    "Téléphone : " + tel + "\n\n" +
    "Précisions :\n" + (message || "(aucune)") + "\n\n" +
    "Rappel : ce créneau doit être confirmé par le consulat.";

  try {
    const r = await envoyer("[Site] Rendez-vous — " + jour + " " + heure, corps, courriel);
    res.json({ ok: true, livre: r.livre });
  } catch (e) {
    console.error("Erreur envoi rendez-vous :", e && e.message);
    res.status(502).json({ ok: false, erreur: "Envoi impossible pour le moment." });
  }
});

/* ========================================================================== */
/* PUBLICATIONS (partage d'informations avec pièces jointes)                  */
/* ========================================================================== */

/* Liste publique des publications (sans le contenu binaire des fichiers). */
app.get("/api/publications", async function (req, res) {
  if (!pool) return res.json({ ok: true, publications: [] });
  try {
    const pubs = await pool.query(
      "SELECT id, titre, rubrique, to_char(date_pub,'YYYY-MM-DD') AS date, resume, corps, une " +
        "FROM publications ORDER BY une DESC, date_pub DESC, id DESC"
    );
    const ids = pubs.rows.map(function (r) { return r.id; });
    const parPub = {};
    if (ids.length) {
      const fs = await pool.query(
        "SELECT id, publication_id, nom, est_image FROM fichiers WHERE publication_id = ANY($1) ORDER BY id",
        [ids]
      );
      fs.rows.forEach(function (f) {
        (parPub[f.publication_id] = parPub[f.publication_id] || []).push({
          id: f.id, nom: f.nom, estImage: f.est_image,
        });
      });
    }
    const publications = pubs.rows.map(function (p) {
      return {
        id: p.id, titre: p.titre, rubrique: p.rubrique, date: p.date,
        resume: p.resume, corps: p.corps, une: p.une, fichiers: parPub[p.id] || [],
      };
    });
    res.json({ ok: true, publications: publications });
  } catch (e) {
    console.error("GET /api/publications :", e && e.message);
    res.status(500).json({ ok: false, erreur: "Erreur base de données." });
  }
});

/* Sert le contenu binaire d'une pièce jointe (photo ou PDF). */
app.get("/api/fichier/:id", async function (req, res) {
  if (!pool) return res.status(404).end();
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).end();
  try {
    const r = await pool.query("SELECT nom, type_mime, contenu FROM fichiers WHERE id = $1", [id]);
    if (!r.rows.length) return res.status(404).end();
    const f = r.rows[0];
    res.setHeader("Content-Type", f.type_mime);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Content-Disposition", 'inline; filename="' + encodeURIComponent(f.nom) + '"');
    res.send(f.contenu);
  } catch (e) {
    console.error("GET /api/fichier :", e && e.message);
    res.status(500).end();
  }
});

/* Crée une publication (réservé à l'administration). Multipart : champs + fichiers. */
app.post("/api/publications", adminAuth, upload.array("fichiers", 8), async function (req, res) {
  if (!pool) return res.status(503).json({ ok: false, erreur: "Base de données non configurée." });
  const b = req.body || {};
  const titre = txt(b.titre), rubrique = txt(b.rubrique), corps = txt(b.corps), resume = txt(b.resume);
  const une = b.une === "true" || b.une === "on" || b.une === "1";
  let date = txt(b.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) date = new Date().toISOString().slice(0, 10);
  if (!titre || !rubrique || !corps) {
    return res.status(400).json({ ok: false, erreur: "Titre, rubrique et contenu sont requis." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ins = await client.query(
      "INSERT INTO publications (titre, rubrique, date_pub, resume, corps, une) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
      [titre, rubrique, date, resume, corps, une]
    );
    const pubId = ins.rows[0].id;
    const fichiers = req.files || [];
    for (let i = 0; i < fichiers.length; i++) {
      const f = fichiers[i];
      const estImage = /^image\//.test(f.mimetype);
      await client.query(
        "INSERT INTO fichiers (publication_id, nom, type_mime, est_image, contenu, taille) VALUES ($1,$2,$3,$4,$5,$6)",
        [pubId, f.originalname, f.mimetype, estImage, f.buffer, f.size]
      );
    }
    await client.query("COMMIT");
    res.json({ ok: true, id: pubId });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("POST /api/publications :", e && e.message);
    res.status(500).json({ ok: false, erreur: "Enregistrement impossible." });
  } finally {
    client.release();
  }
});

/* Supprime une publication (réservé à l'administration). */
app.delete("/api/publications/:id", adminAuth, async function (req, res) {
  if (!pool) return res.status(503).json({ ok: false });
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ ok: false });
  try {
    await pool.query("DELETE FROM publications WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /api/publications :", e && e.message);
    res.status(500).json({ ok: false });
  }
});

/* Vérifie les identifiants d'administration (utilisé par l'écran de connexion). */
app.get("/api/admin/verifier", adminAuth, function (req, res) {
  res.json({ ok: true });
});

/* Page d'administration : l'écran de connexion est public, mais toutes les
   opérations d'écriture (publier / supprimer) exigent les identifiants. */
app.get("/admin", function (req, res) {
  res.sendFile(path.join(__dirname, "admin", "admin.html"));
});

/* Point de santé (utilisé par le healthcheck de Railway). */
app.get("/api/sante", function (req, res) {
  res.json({ ok: true });
});

/* Toute autre route GET renvoie le site (la navigation se fait par ancre #/). */
app.get("*", function (req, res) {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, function () {
  console.log("Serveur à l'écoute sur le port " + PORT);
  if (!transport) console.log("Note : SMTP non configuré — les demandes sont journalisées.");
  if (!pool) {
    console.log("Note : PostgreSQL non configuré (DATABASE_URL) — publications désactivées, actualités statiques.");
  } else {
    initBase()
      .then(function () { console.log("PostgreSQL : tables prêtes."); })
      .catch(function (e) { console.error("Échec initialisation base :", e && e.message); });
  }
});
