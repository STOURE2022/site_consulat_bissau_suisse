# Déploiement sur Railway

Ce projet est une application web Node.js prête pour **Railway** :

- **Frontend** : le site, dans le dossier `public/` (servi tel quel).
- **Backend** : `server.js` (Express) sert le site, traite les formulaires de
  contact et de rendez-vous (relais e-mail) **et** gère les **publications**
  (partage d'informations avec photos / PDF) stockées dans **PostgreSQL**.

Les demandes de contact / rendez-vous ne sont pas stockées (relais e-mail
uniquement). Les publications, elles, sont enregistrées dans PostgreSQL, avec
leurs pièces jointes. L'espace de publication `/admin` est protégé par mot de passe.

```
.
├── server.js              ← backend (Express + PostgreSQL)
├── package.json           ← dépendances + script « start »
├── railway.json           ← configuration Railway (démarrage, healthcheck)
├── .env.example           ← modèle des variables d'environnement
├── .gitignore
├── admin/
│   └── admin.html         ← espace de publication (servi sur /admin, protégé)
└── public/                ← frontend (le site)
    ├── index.html
    ├── robots.txt
    ├── sitemap.xml
    ├── maquette-rdv.html
    ├── maquette-publications.html
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
| `ADMIN_USER` | `consul` | Identifiant de l'espace `/admin` |
| `ADMIN_PASSWORD` | *(secret, long)* | Mot de passe de l'espace `/admin` |

> Ne pas définir `PORT` : Railway le fournit automatiquement.
> Ne jamais committer le fichier `.env` (il est déjà dans `.gitignore`).

Après ajout des variables, Railway redéploie automatiquement.

---

## 4 bis. Ajouter la base PostgreSQL (publications)

L'espace de publication (partage d'informations avec photos / PDF) nécessite une
base PostgreSQL :

1. Dans le projet Railway : **New → Database → Add PostgreSQL**.
2. Railway crée le service et injecte automatiquement la variable **`DATABASE_URL`**
   dans votre application (via une référence). Vérifiez sa présence dans l'onglet
   **Variables** du service web ; **ne la recopiez pas à la main**.
3. Au démarrage, l'application crée automatiquement les tables nécessaires.
4. Définissez `ADMIN_USER` et `ADMIN_PASSWORD` (voir tableau ci-dessus) pour
   pouvoir vous connecter à l'espace de publication.

**Utilisation** : rendez-vous sur `https://(votre-domaine)/admin`, connectez-vous.
Deux onglets :
- **Publications** : rédiger une information, joindre des photos ou des PDF, publier
  (apparaît aussitôt sur la page **Actualités**), et supprimer.
- **Rendez-vous** : consulter les demandes reçues (filtrées par statut), les
  **confirmer** ou **refuser** (un courriel automatique est envoyé au demandeur si
  le SMTP est configuré), et les supprimer. Une pastille indique le nombre de
  demandes en attente.
- **Mot du Consul** : modifier le nom, la **photo** (téléversée), la fonction et le
  message du Consul (dans les trois langues) affichés sur la page d'accueil.
- **Contenu & textes** : téléverser la **photographie officielle** de la page
  d'accueil, et compléter les zones « À valider » (zone de compétence FR/PT/EN,
  délai de réponse aux rendez-vous, mentions légales : éditeur, hébergeur, durée
  de conservation). Les champs vides gardent le marqueur jaune par défaut.
- **Paramètres & bandeau** : saisir les **coordonnées et horaires** du consulat
  (ils remplacent automatiquement les marqueurs « À valider » sur tout le site :
  Contact, Rendez-vous, pied de page) et activer un **bandeau d'information
  temporaire** (ex. fermeture exceptionnelle) affiché en haut de toutes les pages.

> Les fichiers sont stockés dans PostgreSQL (colonne binaire) : ils sont donc
> persistants et sauvegardés avec la base — pas de dépendance à un disque local.
> Pour de très gros volumes d'images, un stockage objet (S3 compatible, CH/UE)
> pourra être envisagé plus tard.

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
- [ ] Connexion à `/admin` possible, publication d'un test avec une photo et un
      PDF, apparition sur la page **Actualités**, puis suppression.
- [ ] Envoi d'une demande de rendez-vous depuis le site, puis dans `/admin`
      (onglet Rendez-vous) : la demande apparaît, se confirme et se supprime.
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
