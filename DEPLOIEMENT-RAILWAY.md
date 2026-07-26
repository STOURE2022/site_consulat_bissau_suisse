# Déploiement sur Railway

Ce projet est une application web Node.js prête pour **Railway** :

- **Frontend** : le site, dans le dossier `public/` (servi tel quel).
- **Backend** : `server.js` (Express) sert le site **et** traite les formulaires
  de contact et de rendez-vous, en relayant chaque demande par courriel.

Aucune donnée personnelle n'est stockée sur le serveur : les demandes sont
seulement transmises par e-mail (minimisation des données — nLPD / RGPD).

```
.
├── server.js              ← backend (Express)
├── package.json           ← dépendances + script « start »
├── railway.json           ← configuration Railway (démarrage, healthcheck)
├── .env.example           ← modèle des variables d'environnement
├── .gitignore
└── public/                ← frontend (le site)
    ├── index.html
    ├── robots.txt
    ├── sitemap.xml
    ├── maquette-rdv.html
    └── fonts/             ← (à ajouter : polices Montserrat / Lato)
```

---

## 1. Prérequis

- Un compte **Railway** (https://railway.app).
- Le code sur **GitHub** (recommandé) ou l'outil **Railway CLI**.
- Une **adresse e-mail SMTP** pour l'envoi des notifications, de préférence chez
  un hébergeur **suisse ou de l'Union européenne** (ex. Infomaniak, Mailbox.org).

---

## 2. Tester en local (facultatif mais conseillé)

```bash
npm install
npm start
```

Puis ouvrir http://localhost:3000. Sans configuration SMTP, les demandes
s'affichent dans la console du serveur (aucun e-mail n'est envoyé), ce qui permet
de vérifier le fonctionnement avant la mise en ligne.

---

## 3. Déployer

### Option A — depuis GitHub (recommandé)

1. Publier ce dossier dans un dépôt GitHub.
2. Sur Railway : **New Project → Deploy from GitHub repo**, choisir le dépôt.
3. Railway détecte Node.js, installe les dépendances et lance `node server.js`
   (défini dans `railway.json` et `package.json`).

### Option B — depuis la Railway CLI

```bash
npm i -g @railway/cli
railway login
railway init
railway up
```

---

## 4. Configurer les variables d'environnement

Dans Railway : projet → service → onglet **Variables**. Ajouter (voir
`.env.example`) :

| Variable | Exemple | Rôle |
|---|---|---|
| `SMTP_HOST` | `mail.infomaniak.com` | Serveur d'envoi |
| `SMTP_PORT` | `587` | Port SMTP |
| `SMTP_SECURE` | `false` | `true` seulement si port `465` |
| `SMTP_USER` | `site@votre-domaine.ch` | Identifiant SMTP |
| `SMTP_PASS` | *(secret)* | Mot de passe SMTP |
| `MAIL_TO` | `contact@votre-domaine.ch` | Boîte qui reçoit les demandes |
| `MAIL_FROM` | `site@votre-domaine.ch` | Expéditeur technique |

> Ne pas définir `PORT` : Railway le fournit automatiquement.
> Ne jamais committer le fichier `.env` (il est déjà dans `.gitignore`).

Après ajout des variables, Railway redéploie automatiquement.

---

## 5. Domaine

- Railway fournit une URL en `*.up.railway.app` (immédiatement fonctionnelle).
- Pour le domaine officiel : onglet **Settings → Domains → Custom Domain**, puis
  suivre les instructions DNS.
- Une fois le domaine connu, **remplacer** `www.consulat-guineebissau.ch` par le
  vrai domaine dans : `public/index.html` (balises SEO), `public/sitemap.xml` et
  `public/robots.txt`.

---

## 6. Vérifications après mise en ligne

- [ ] La page s'affiche et la navigation fonctionne dans les trois langues.
- [ ] `/(URL)/api/sante` renvoie `{"ok":true}`.
- [ ] Un envoi de test depuis **Contact** et depuis **Rendez-vous** arrive bien
      dans la boîte `MAIL_TO`.
- [ ] Les marqueurs `[À VALIDER …]` ont été remplacés par les vraies informations.
- [ ] Les polices (dossier `public/fonts/`) et les images officielles sont en place.

---

## Notes de sécurité et de conformité

- Le serveur envoie des en-têtes de sécurité (CSP « même origine », `nosniff`,
  anti-clickjacking) : le site ne charge aucune ressource tierce.
- Un **limiteur de débit** protège les formulaires (20 envois / 15 min / adresse).
- Un champ **honeypot** filtre les robots.
- Les formulaires n'acceptent **aucune pièce jointe** : rappeler aux usagers de ne
  jamais transmettre de copie de pièce d'identité (déjà indiqué sur le site).
