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
  await pool.query(
    "CREATE TABLE IF NOT EXISTS parametres (cle TEXT PRIMARY KEY, valeur TEXT)"
  );
  await pool.query(
    "CREATE TABLE IF NOT EXISTS rendezvous (" +
      "id SERIAL PRIMARY KEY, motif TEXT, jour DATE, heure TEXT, " +
      "nom TEXT NOT NULL, courriel TEXT NOT NULL, tel TEXT, message TEXT, " +
      "statut TEXT NOT NULL DEFAULT 'en_attente', cree_le TIMESTAMPTZ DEFAULT now())"
  );
  await pool.query(
    "CREATE TABLE IF NOT EXISTS documents (" +
      "id SERIAL PRIMARY KEY, titre TEXT NOT NULL, nom TEXT NOT NULL, " +
      "type_mime TEXT NOT NULL, contenu BYTEA NOT NULL, taille INTEGER, " +
      "cree_le TIMESTAMPTZ DEFAULT now())"
  );
  await pool.query(
    "CREATE TABLE IF NOT EXISTS creneaux (" +
      "id SERIAL PRIMARY KEY, jour DATE NOT NULL, heure TEXT NOT NULL, " +
      "duree INTEGER DEFAULT 30, type TEXT NOT NULL, statut TEXT NOT NULL DEFAULT 'libre', " +
      "nom TEXT, courriel TEXT, tel TEXT, motif TEXT, lien_visio TEXT, " +
      "cree_le TIMESTAMPTZ DEFAULT now())"
  );
  await pool.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS creneaux_uniq ON creneaux (jour, heure, type)"
  );
}

/* Types de rendez-vous autorisés. */
const TYPES_RDV = ["visio", "tel", "pres"];

/* Génère la liste des heures « HH:MM » entre début et fin, par pas de « duree ». */
function genererHeures(debut, fin, duree) {
  function toMin(s) { const p = String(s).split(":"); return (+p[0]) * 60 + (+p[1] || 0); }
  function toStr(m) { return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"); }
  if (!/^\d{1,2}:\d{2}$/.test(debut)) return [];
  const d = toMin(debut), f = /^\d{1,2}:\d{2}$/.test(fin) ? toMin(fin) : d, out = [];
  if (f <= d) return [debut];
  for (let m = d; m + duree <= f && out.length < 60; m += duree) out.push(toStr(m));
  return out;
}
/* Ajoute n jours à une date ISO (YYYY-MM-DD). */
function ajouterJours(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/* Statuts autorisés pour une demande de rendez-vous. */
const STATUTS_RDV = ["en_attente", "confirme", "refuse", "annule"];

/* Garantit l'existence de la table documents (auto-réparation si initBase n'a
   pas pu la créer). Idempotent. */
async function assurerTableDocuments() {
  if (!pool) return;
  await pool.query(
    "CREATE TABLE IF NOT EXISTS documents (" +
      "id SERIAL PRIMARY KEY, titre TEXT NOT NULL, nom TEXT NOT NULL, " +
      "type_mime TEXT NOT NULL, contenu BYTEA NOT NULL, taille INTEGER, " +
      "cree_le TIMESTAMPTZ DEFAULT now())"
  );
}

/* Clés de paramètres autorisées (coordonnées, horaires, bandeau d'information). */
const CLES_PARAM = [
  "adresse", "ville", "telephone", "permanence", "courriel", "ambassade", "assistante",
  "horaires_reception", "horaires_jours", "horaires_permanence",
  "bandeau_actif", "bandeau_type", "bandeau_texte",
  "consul_nom", "consul_fonction_fr", "consul_fonction_pt", "consul_fonction_en",
  "consul_texte_fr", "consul_texte_pt", "consul_texte_en",
  // Zones institutionnelles à compléter par le consulat.
  "zone_competence_fr", "zone_competence_pt", "zone_competence_en",
  "rdv_delai", "editeur", "hebergeur",
  "conservation_fr", "conservation_pt", "conservation_en",
  // consul_portrait_id et hero_photo_id sont gérés par leurs endpoints d'upload.
];

/* Enregistre (ou met à jour) un paramètre unique. */
async function definirParam(cle, valeur) {
  await pool.query(
    "INSERT INTO parametres (cle, valeur) VALUES ($1,$2) ON CONFLICT (cle) DO UPDATE SET valeur = $2",
    [cle, valeur == null ? "" : String(valeur)]
  );
}
async function lireParam(cle) {
  const r = await pool.query("SELECT valeur FROM parametres WHERE cle = $1", [cle]);
  return r.rows.length ? r.rows[0].valeur : null;
}

/* Réception des pièces jointes en mémoire (max 10 Mo/fichier, 8 fichiers). */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 8 },
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
/* Liste des comptes admin autorisés. Deux sources cumulables :
   - ADMIN_USER / ADMIN_PASSWORD : le compte unique historique ;
   - ADMIN_USERS : plusieurs comptes nominatifs, sous la forme
     "leila:motdepasse1,consul:motdepasse2" (paires séparées par des virgules,
     identifiant et mot de passe séparés par « : »). Le mot de passe ne doit
     pas contenir de virgule. */
function comptesAdmin() {
  const comptes = [];
  if (process.env.ADMIN_USER && process.env.ADMIN_PASSWORD) {
    comptes.push({ u: process.env.ADMIN_USER, p: process.env.ADMIN_PASSWORD });
  }
  if (process.env.ADMIN_USERS) {
    process.env.ADMIN_USERS.split(",").forEach(function (paire) {
      const s = paire.trim();
      const i = s.indexOf(":");
      if (i > 0) comptes.push({ u: s.slice(0, i).trim(), p: s.slice(i + 1) });
    });
  }
  return comptes;
}

/* Rôle d'un compte : « consul » (accès complet, dont « Mot du Consul ») ou
   « staff » (tout sauf le Mot du Consul). Sont consuls : le compte historique
   ADMIN_USER, et tout identifiant listé dans ADMIN_CONSULS (séparés par des
   virgules). Tous les autres sont des collaborateurs. */
function roleDe(u) {
  if (process.env.ADMIN_USER && u === process.env.ADMIN_USER) return "consul";
  const liste = (process.env.ADMIN_CONSULS || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  return liste.indexOf(u) !== -1 ? "consul" : "staff";
}

function adminAuth(req, res, next) {
  const comptes = comptesAdmin();
  if (!comptes.length) {
    return res.status(503).json({ ok: false, erreur: "Espace d'administration non configuré (ADMIN_USER / ADMIN_PASSWORD ou ADMIN_USERS)." });
  }
  const m = (req.headers.authorization || "").match(/^Basic (.+)$/);
  if (m) {
    const paire = Buffer.from(m[1], "base64").toString();
    const i = paire.indexOf(":");
    const u = paire.slice(0, i), p = paire.slice(i + 1);
    /* On teste tous les comptes sans court-circuit pour ne pas divulguer par le
       temps de réponse quel identifiant existe. */
    let trouve = null;
    for (const c of comptes) {
      if (egaliteConstante(u, c.u) && egaliteConstante(p, c.p)) trouve = c;
    }
    if (trouve) {
      req.adminUser = trouve.u;
      req.adminRole = roleDe(trouve.u);
      return next();
    }
  }
  res.set("WWW-Authenticate", 'Basic realm="Espace consulat"');
  return res.status(401).json({ ok: false, erreur: "Authentification requise." });
}

/* Réserve une route au consul (à placer après adminAuth). */
function consulAuth(req, res, next) {
  if (req.adminRole === "consul") return next();
  return res.status(403).json({ ok: false, erreur: "Action réservée au consul." });
}

/* Clés de paramètres relevant du « Mot du Consul » : modifiables par le consul
   uniquement (les collaborateurs peuvent éditer tout le reste). */
const CLES_CONSUL = [
  "consul_nom", "consul_fonction_fr", "consul_fonction_pt", "consul_fonction_en",
  "consul_texte_fr", "consul_texte_pt", "consul_texte_en",
];

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

/* Limiteur STRICT réservé aux endpoints qui envoient un e-mail ou acceptent une
   écriture publique (formulaire de contact, demande et réservation de rendez-vous).
   20 requêtes / 15 min / IP suffisent largement à un usage légitime et bloquent le
   spam. À NE PAS appliquer globalement : les lectures et surtout les images passent
   toutes par /api/ (une page peut faire des dizaines de requêtes), ce qui déclenchait
   des 429 et faisait « disparaître » les photos pourtant présentes en base. */
const limiteEnvoi = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { ok: false, erreur: "Trop de tentatives. Merci de réessayer dans quelques minutes." },
});

/* Limiteur GLOBAL très large sur /api/ : n'entrave jamais la navigation normale
   (images en cache, lectures), mais borne les abus manifestes. */
app.use("/api/", rateLimit({ windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));

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
app.post("/api/contact", limiteEnvoi, async function (req, res) {
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
app.post("/api/rendezvous", limiteEnvoi, async function (req, res) {
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

  /* Enregistrement en base (si disponible). N'empêche pas l'e-mail en cas d'échec. */
  if (pool) {
    try {
      const jourValide = /^\d{4}-\d{2}-\d{2}$/.test(jour) ? jour : null;
      await pool.query(
        "INSERT INTO rendezvous (motif, jour, heure, nom, courriel, tel, message) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [motif, jourValide, heure, nom, courriel, tel, message]
      );
    } catch (e) {
      console.error("Enregistrement rendez-vous :", e && e.message);
    }
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
    "À traiter dans l'espace d'administration (/admin, onglet Rendez-vous).";

  try {
    const r = await envoyer("[Site] Rendez-vous — " + jour + " " + heure, corps, courriel);
    res.json({ ok: true, livre: r.livre });
  } catch (e) {
    console.error("Erreur envoi rendez-vous :", e && e.message);
    // La demande est enregistrée : on renvoie tout de même un succès.
    res.json({ ok: true, livre: false });
  }
});

/* Liste des demandes de rendez-vous (administration). Filtre optionnel ?statut= */
app.get("/api/rendezvous", adminAuth, async function (req, res) {
  if (!pool) return res.json({ ok: true, demandes: [] });
  const statut = txt(req.query.statut);
  try {
    let r;
    if (statut && STATUTS_RDV.indexOf(statut) !== -1) {
      r = await pool.query(
        "SELECT id, motif, to_char(jour,'YYYY-MM-DD') AS jour, heure, nom, courriel, tel, message, statut, " +
          "to_char(cree_le,'YYYY-MM-DD\"T\"HH24:MI') AS cree_le FROM rendezvous WHERE statut = $1 ORDER BY cree_le DESC",
        [statut]
      );
    } else {
      r = await pool.query(
        "SELECT id, motif, to_char(jour,'YYYY-MM-DD') AS jour, heure, nom, courriel, tel, message, statut, " +
          "to_char(cree_le,'YYYY-MM-DD\"T\"HH24:MI') AS cree_le FROM rendezvous ORDER BY cree_le DESC"
      );
    }
    res.json({ ok: true, demandes: r.rows });
  } catch (e) {
    console.error("GET /api/rendezvous :", e && e.message);
    res.status(500).json({ ok: false, erreur: "Erreur base de données." });
  }
});

/* Change le statut d'une demande + informe le demandeur par courriel (si SMTP). */
app.patch("/api/rendezvous/:id", adminAuth, async function (req, res) {
  if (!pool) return res.status(503).json({ ok: false });
  const id = parseInt(req.params.id, 10);
  const statut = txt((req.body || {}).statut);
  if (!id || STATUTS_RDV.indexOf(statut) === -1) {
    return res.status(400).json({ ok: false, erreur: "Requête invalide." });
  }
  try {
    const r = await pool.query(
      "UPDATE rendezvous SET statut = $1 WHERE id = $2 RETURNING nom, courriel, to_char(jour,'YYYY-MM-DD') AS jour, heure",
      [statut, id]
    );
    if (!r.rows.length) return res.status(404).json({ ok: false });
    const rv = r.rows[0];
    // Courriel d'information au demandeur pour une confirmation ou un refus.
    if (statut === "confirme" || statut === "refuse") {
      const sujet = statut === "confirme"
        ? "Confirmation de votre rendez-vous"
        : "Votre demande de rendez-vous";
      const corps = statut === "confirme"
        ? "Bonjour " + rv.nom + ",\n\nVotre rendez-vous du " + rv.jour + " à " + rv.heure +
          " est confirmé.\n\nConsulat honoraire de la République de Guinée-Bissau en Suisse."
        : "Bonjour " + rv.nom + ",\n\nNous ne sommes malheureusement pas en mesure de retenir le créneau " +
          "demandé (" + rv.jour + " à " + rv.heure + "). N'hésitez pas à formuler une nouvelle demande.\n\n" +
          "Consulat honoraire de la République de Guinée-Bissau en Suisse.";
      // Courriel envoyé au demandeur (destinataire = son adresse).
      if (transport) {
        transport.sendMail({
          from: process.env.MAIL_FROM || process.env.SMTP_USER,
          to: rv.courriel, replyTo: process.env.MAIL_TO || undefined,
          subject: sujet, text: corps,
        }).catch(function (e) { console.error("Envoi demandeur :", e && e.message); });
      } else {
        console.log("[E-MAIL NON CONFIGURÉ] " + sujet + " -> " + rv.courriel);
      }
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("PATCH /api/rendezvous :", e && e.message);
    res.status(500).json({ ok: false });
  }
});

/* Supprime une demande de rendez-vous (administration). */
app.delete("/api/rendezvous/:id", adminAuth, async function (req, res) {
  if (!pool) return res.status(503).json({ ok: false });
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ ok: false });
  try {
    await pool.query("DELETE FROM rendezvous WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /api/rendezvous :", e && e.message);
    res.status(500).json({ ok: false });
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

/* ========================================================================== */
/* PARAMÈTRES (coordonnées, horaires, bandeau d'information)                  */
/* ========================================================================== */

/* Lecture publique : renvoie tous les paramètres sous forme d'objet. */
app.get("/api/parametres", async function (req, res) {
  if (!pool) return res.json({ ok: true, parametres: {} });
  try {
    const r = await pool.query("SELECT cle, valeur FROM parametres");
    const o = {};
    r.rows.forEach(function (x) { o[x.cle] = x.valeur; });
    res.json({ ok: true, parametres: o });
  } catch (e) {
    console.error("GET /api/parametres :", e && e.message);
    res.status(500).json({ ok: false, erreur: "Erreur base de données." });
  }
});

/* Enregistrement (réservé à l'administration). Corps JSON : { cle: valeur, … }. */
app.put("/api/parametres", adminAuth, async function (req, res) {
  if (!pool) return res.status(503).json({ ok: false, erreur: "Base de données non configurée." });
  const b = req.body || {};
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < CLES_PARAM.length; i++) {
      const cle = CLES_PARAM[i];
      if (!(cle in b)) continue; // on ne touche qu'aux clés fournies
      // Les clés du « Mot du Consul » ne sont modifiables que par le consul.
      if (CLES_CONSUL.indexOf(cle) !== -1 && req.adminRole !== "consul") continue;
      const val = b[cle] == null ? "" : String(b[cle]);
      await client.query(
        "INSERT INTO parametres (cle, valeur) VALUES ($1,$2) ON CONFLICT (cle) DO UPDATE SET valeur = $2",
        [cle, val]
      );
    }
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("PUT /api/parametres :", e && e.message);
    res.status(500).json({ ok: false, erreur: "Enregistrement impossible." });
  } finally {
    client.release();
  }
});

/* Téléverse (ou remplace) la photo du Consul honoraire. Réservé à l'admin.
   La photo est stockée dans la table « fichiers » (sans publication) et son id
   est mémorisé dans le paramètre « consul_portrait_id ». */
app.post("/api/consul/portrait", adminAuth, consulAuth, upload.single("portrait"), async function (req, res) {
  if (!pool) return res.status(503).json({ ok: false, erreur: "Base de données non configurée." });
  if (!req.file || !/^image\//.test(req.file.mimetype)) {
    return res.status(400).json({ ok: false, erreur: "Veuillez fournir une image." });
  }
  try {
    const ancien = await lireParam("consul_portrait_id");
    const ins = await pool.query(
      "INSERT INTO fichiers (publication_id, nom, type_mime, est_image, contenu, taille) VALUES (NULL,$1,$2,true,$3,$4) RETURNING id",
      [req.file.originalname, req.file.mimetype, req.file.buffer, req.file.size]
    );
    await definirParam("consul_portrait_id", String(ins.rows[0].id));
    if (ancien) { await pool.query("DELETE FROM fichiers WHERE id = $1", [parseInt(ancien, 10)]); }
    res.json({ ok: true, id: ins.rows[0].id });
  } catch (e) {
    console.error("POST /api/consul/portrait :", e && e.message);
    res.status(500).json({ ok: false, erreur: "Enregistrement impossible." });
  }
});

/* Retire la photo du Consul. */
app.delete("/api/consul/portrait", adminAuth, consulAuth, async function (req, res) {
  if (!pool) return res.status(503).json({ ok: false });
  try {
    const ancien = await lireParam("consul_portrait_id");
    if (ancien) await pool.query("DELETE FROM fichiers WHERE id = $1", [parseInt(ancien, 10)]);
    await definirParam("consul_portrait_id", "");
    res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /api/consul/portrait :", e && e.message);
    res.status(500).json({ ok: false });
  }
});

/* Téléverse (ou remplace) la photographie officielle de la page d'accueil.
   Stockée dans « fichiers », son id est mémorisé dans « hero_photo_id ». */
app.post("/api/hero/photo", adminAuth, upload.single("photo"), async function (req, res) {
  if (!pool) return res.status(503).json({ ok: false, erreur: "Base de données non configurée." });
  if (!req.file || !/^image\//.test(req.file.mimetype)) {
    return res.status(400).json({ ok: false, erreur: "Veuillez fournir une image." });
  }
  try {
    const ancien = await lireParam("hero_photo_id");
    const ins = await pool.query(
      "INSERT INTO fichiers (publication_id, nom, type_mime, est_image, contenu, taille) VALUES (NULL,$1,$2,true,$3,$4) RETURNING id",
      [req.file.originalname, req.file.mimetype, req.file.buffer, req.file.size]
    );
    await definirParam("hero_photo_id", String(ins.rows[0].id));
    if (ancien) { await pool.query("DELETE FROM fichiers WHERE id = $1", [parseInt(ancien, 10)]); }
    res.json({ ok: true, id: ins.rows[0].id });
  } catch (e) {
    console.error("POST /api/hero/photo :", e && e.message);
    res.status(500).json({ ok: false, erreur: "Enregistrement impossible." });
  }
});

/* Retire la photographie officielle. */
app.delete("/api/hero/photo", adminAuth, async function (req, res) {
  if (!pool) return res.status(503).json({ ok: false });
  try {
    const ancien = await lireParam("hero_photo_id");
    if (ancien) await pool.query("DELETE FROM fichiers WHERE id = $1", [parseInt(ancien, 10)]);
    await definirParam("hero_photo_id", "");
    res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /api/hero/photo :", e && e.message);
    res.status(500).json({ ok: false });
  }
});

/* Vérifie les identifiants d'administration (utilisé par l'écran de connexion). */
app.get("/api/admin/verifier", adminAuth, function (req, res) {
  res.json({ ok: true, role: req.adminRole, user: req.adminUser });
});

/* ========================================================================== */
/* DOCUMENTS UTILES (bibliothèque de PDF, page Services)                      */
/* ========================================================================== */

/* Liste publique des documents (sans le contenu binaire). */
app.get("/api/documents", async function (req, res) {
  if (!pool) return res.json({ ok: true, documents: [] });
  try {
    await assurerTableDocuments();
    const r = await pool.query("SELECT id, titre, nom, type_mime FROM documents ORDER BY cree_le DESC, id DESC");
    res.json({ ok: true, documents: r.rows });
  } catch (e) {
    console.error("GET /api/documents :", e && e.message);
    res.status(500).json({ ok: false, erreur: "Erreur base de données." });
  }
});

/* Sert le contenu d'un document (ouverture / téléchargement). */
app.get("/api/document/:id", async function (req, res) {
  if (!pool) return res.status(404).end();
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).end();
  try {
    const r = await pool.query("SELECT nom, type_mime, contenu FROM documents WHERE id = $1", [id]);
    if (!r.rows.length) return res.status(404).end();
    const f = r.rows[0];
    res.setHeader("Content-Type", f.type_mime);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("Content-Disposition", 'inline; filename="' + encodeURIComponent(f.nom) + '"');
    res.send(f.contenu);
  } catch (e) {
    console.error("GET /api/document :", e && e.message);
    res.status(500).end();
  }
});

/* Ajoute un document (réservé à l'administration). Multipart : titre + fichier. */
app.post("/api/documents", adminAuth, upload.single("fichier"), async function (req, res) {
  if (!pool) return res.status(503).json({ ok: false, erreur: "Base de données non configurée." });
  const titre = txt((req.body || {}).titre);
  if (!titre) return res.status(400).json({ ok: false, erreur: "Le titre est requis." });
  if (!req.file) return res.status(400).json({ ok: false, erreur: "Veuillez joindre un fichier." });
  try {
    await assurerTableDocuments();
    const ins = await pool.query(
      "INSERT INTO documents (titre, nom, type_mime, contenu, taille) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [titre, req.file.originalname, req.file.mimetype, req.file.buffer, req.file.size]
    );
    res.json({ ok: true, id: ins.rows[0].id });
  } catch (e) {
    console.error("POST /api/documents :", e && e.message);
    res.status(500).json({ ok: false, erreur: "Enregistrement impossible." });
  }
});

/* Supprime un document (réservé à l'administration). */
app.delete("/api/documents/:id", adminAuth, async function (req, res) {
  if (!pool) return res.status(503).json({ ok: false });
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ ok: false });
  try {
    await pool.query("DELETE FROM documents WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /api/documents :", e && e.message);
    res.status(500).json({ ok: false });
  }
});

/* ========================================================================== */
/* CRÉNEAUX DE RENDEZ-VOUS (visio / téléphonique / présentiel)                */
/* ========================================================================== */

/* Créneaux LIBRES à venir (public). Filtre optionnel ?type=visio|tel|pres */
app.get("/api/creneaux", async function (req, res) {
  if (!pool) return res.json({ ok: true, creneaux: [] });
  const type = txt(req.query.type);
  try {
    let q = "SELECT id, to_char(jour,'YYYY-MM-DD') AS jour, heure, duree, type FROM creneaux " +
            "WHERE statut='libre' AND jour >= current_date";
    const params = [];
    if (type && TYPES_RDV.indexOf(type) !== -1) { params.push(type); q += " AND type = $1"; }
    q += " ORDER BY jour, heure";
    const r = await pool.query(q, params);
    res.json({ ok: true, creneaux: r.rows });
  } catch (e) { console.error("GET /api/creneaux :", e && e.message); res.status(500).json({ ok: false }); }
});

/* Tous les créneaux à venir (admin) — pour la gestion. */
app.get("/api/creneaux/tous", adminAuth, async function (req, res) {
  if (!pool) return res.json({ ok: true, creneaux: [] });
  try {
    const r = await pool.query(
      "SELECT id, to_char(jour,'YYYY-MM-DD') AS jour, heure, duree, type, statut, nom, courriel, tel, motif, lien_visio " +
      "FROM creneaux WHERE jour >= current_date ORDER BY jour, heure");
    res.json({ ok: true, creneaux: r.rows });
  } catch (e) { console.error("GET /api/creneaux/tous :", e && e.message); res.status(500).json({ ok: false }); }
});

/* Ouvre des créneaux (admin) — avec récurrence hebdomadaire. */
app.post("/api/creneaux", adminAuth, async function (req, res) {
  if (!pool) return res.status(503).json({ ok: false, erreur: "Base de données non configurée." });
  const b = req.body || {};
  const type = txt(b.type);
  const debut = txt(b.heure_debut), fin = txt(b.heure_fin);
  const duree = Math.min(240, Math.max(10, parseInt(b.duree, 10) || 30));
  const semaines = Math.min(26, Math.max(1, parseInt(b.repeter, 10) || 1));
  if (TYPES_RDV.indexOf(type) === -1) return res.status(400).json({ ok: false, erreur: "Type invalide." });
  // Accepte un tableau `jours` (multi-dates) ou un `jour` unique (rétrocompatibilité).
  let jours = Array.isArray(b.jours) ? b.jours.map(txt) : (b.jour ? [txt(b.jour)] : []);
  jours = jours.filter(function (j) { return /^\d{4}-\d{2}-\d{2}$/.test(j); });
  // Dédoublonne en conservant l'ordre.
  jours = jours.filter(function (j, i) { return jours.indexOf(j) === i; });
  if (!jours.length) return res.status(400).json({ ok: false, erreur: "Aucune date valide." });
  if (jours.length > 60) return res.status(400).json({ ok: false, erreur: "Trop de dates sélectionnées (60 maximum)." });
  const heures = genererHeures(debut, fin, duree);
  if (!heures.length) return res.status(400).json({ ok: false, erreur: "Horaires invalides." });
  const client = await pool.connect();
  let crees = 0;
  try {
    await client.query("BEGIN");
    for (let d = 0; d < jours.length; d++) {
      for (let w = 0; w < semaines; w++) {
        const j = ajouterJours(jours[d], w * 7);
        for (let k = 0; k < heures.length; k++) {
          const r = await client.query(
            "INSERT INTO creneaux (jour, heure, duree, type) VALUES ($1,$2,$3,$4) " +
            "ON CONFLICT (jour, heure, type) DO NOTHING", [j, heures[k], duree, type]);
          crees += r.rowCount;
        }
      }
    }
    await client.query("COMMIT");
    res.json({ ok: true, crees: crees });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("POST /api/creneaux :", e && e.message);
    res.status(500).json({ ok: false, erreur: "Création impossible." });
  } finally { client.release(); }
});

/* Supprime un créneau (admin). */
app.delete("/api/creneaux/:id", adminAuth, async function (req, res) {
  if (!pool) return res.status(503).json({ ok: false });
  const id = parseInt(req.params.id, 10); if (!id) return res.status(400).json({ ok: false });
  try { await pool.query("DELETE FROM creneaux WHERE id = $1", [id]); res.json({ ok: true }); }
  catch (e) { console.error("DELETE /api/creneaux :", e && e.message); res.status(500).json({ ok: false }); }
});

/* Réserve un créneau libre (public) — confirmation automatique + lien visio. */
app.post("/api/creneaux/:id/reserver", limiteEnvoi, async function (req, res) {
  if (!pool) return res.status(503).json({ ok: false, erreur: "Base de données non configurée." });
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const nom = txt(b.nom), courriel = txt(b.courriel), tel = txt(b.tel), motif = txt(b.motif);
  if (!id || !nom || !estCourriel(courriel)) return res.status(400).json({ ok: false, erreur: "Champs manquants ou invalides." });
  try {
    const lien = "https://meet.jit.si/ConsulatGuineeBissau-" + crypto.randomUUID();
    const r = await pool.query(
      "UPDATE creneaux SET statut='reserve', nom=$1, courriel=$2, tel=$3, motif=$4, " +
      "lien_visio = CASE WHEN type='visio' THEN $5 ELSE NULL END " +
      "WHERE id=$6 AND statut='libre' " +
      "RETURNING type, to_char(jour,'YYYY-MM-DD') AS jour, heure, lien_visio",
      [nom, courriel, tel, motif, lien, id]);
    if (!r.rows.length) return res.status(409).json({ ok: false, erreur: "Ce créneau vient d'être réservé. Choisissez-en un autre." });
    const c = r.rows[0];
    const typeNom = { visio: "Visioconférence", tel: "Téléphonique", pres: "Présentiel" }[c.type] || c.type;
    let adressePres = "";
    if (c.type === "pres") {
      try {
        const a = await lireParam("adresse"), v = await lireParam("ville");
        adressePres = [a, v].filter(Boolean).join(", ");
      } catch (e) { /* repli silencieux */ }
    }
    const details = c.type === "visio"
      ? "Lien de connexion (visio) : " + c.lien_visio
      : c.type === "tel"
        ? "Le consulat vous appellera au numéro indiqué, à l'heure convenue."
        : "Adresse : " + (adressePres || "voir la page Contact du site") + ".";
    const corpsDem = "Bonjour " + nom + ",\n\nVotre rendez-vous est confirmé.\n\n" +
      "Type : " + typeNom + "\nDate : " + c.jour + "\nHeure : " + c.heure + "\n\n" + details +
      "\n\nConsulat honoraire de la République de Guinée-Bissau à Genève.";
    if (transport) {
      transport.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to: courriel,
        replyTo: process.env.MAIL_TO || undefined, subject: "Confirmation de votre rendez-vous", text: corpsDem })
        .catch(function (e) { console.error("mail demandeur", e && e.message); });
    }
    envoyer("[Site] Rendez-vous réservé — " + c.jour + " " + c.heure + " (" + typeNom + ")",
      "Nouveau rendez-vous réservé\n\nType : " + typeNom + "\nDate : " + c.jour + "\nHeure : " + c.heure +
      "\nNom : " + nom + "\nCourriel : " + courriel + "\nTéléphone : " + (tel || "—") +
      "\nMotif : " + (motif || "—") + (c.type === "visio" ? "\nLien visio : " + c.lien_visio : ""), courriel)
      .catch(function (e) { console.error("mail consulat", e && e.message); });
    res.json({ ok: true, type: c.type, jour: c.jour, heure: c.heure, lien_visio: c.lien_visio });
  } catch (e) {
    console.error("POST reserver :", e && e.message);
    res.status(500).json({ ok: false, erreur: "Réservation impossible." });
  }
});

/* Page d'administration : l'écran de connexion est public, mais toutes les
   opérations d'écriture (publier / supprimer) exigent les identifiants. */
app.get("/admin", function (req, res) {
  res.sendFile(path.join(__dirname, "admin", "admin.html"));
});

/* Point de santé (utilisé par le healthcheck de Railway). */
app.get("/api/sante", async function (req, res) {
  const info = { ok: true, version: "documents-v2", db: !!pool, tables: [] };
  if (pool) {
    try {
      const r = await pool.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
      );
      info.tables = r.rows.map(function (x) { return x.table_name; });
      info.documentsTable = info.tables.indexOf("documents") !== -1;
    } catch (e) {
      info.dbError = e && e.message;
    }
  }
  res.json(info);
});

/* Toute autre route GET renvoie le site (la navigation se fait par ancre #/). */
app.get("*", function (req, res) {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* Gestionnaire d'erreurs : renvoie un JSON propre pour les routes /api
   (notamment les erreurs d'upload multer : fichier trop volumineux, etc.). */
app.use(function (err, req, res, next) {
  console.error("Erreur non gérée :", err && err.message);
  var estApi = req.path && req.path.indexOf("/api/") === 0;
  if (estApi) {
    var msg = (err && err.code === "LIMIT_FILE_SIZE")
      ? "Fichier trop volumineux (15 Mo maximum)."
      : "Erreur lors du traitement de la requête.";
    return res.status(400).json({ ok: false, erreur: msg });
  }
  res.status(500).send("Erreur serveur.");
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
