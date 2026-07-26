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
const nodemailer = require("nodemailer");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 3000;

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
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
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
});
