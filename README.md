# Site du Consulat honoraire de la République de Guinée-Bissau en Suisse

Le site est dans le dossier **`public/`** : le fichier principal est
**`public/index.html`**, accompagné de `public/robots.txt` et `public/sitemap.xml`.
Le fichier `public/index.html` fonctionne aussi par simple double-clic (pour un
aperçu local), sans logiciel à installer.

> **Déploiement.** Le projet contient en plus un petit serveur (`server.js`) qui
> sert le site et traite les formulaires de contact et de rendez-vous. Pour la
> mise en ligne sur Railway, voir le guide **`DEPLOIEMENT-RAILWAY.md`**.

Ce guide explique, sans connaissances techniques, comment :

1. [Modifier un texte](#1-modifier-un-texte)
2. [Ajouter ou modifier une actualité](#2-ajouter-ou-modifier-une-actualité)
3. [Publier un document PDF](#3-publier-un-document-pdf)
4. [Remplir les informations « à valider »](#4-remplir-les-informations-à-valider)
5. [Ajouter les polices, les armoiries et les images](#5-ajouter-les-polices-les-armoiries-et-les-images)
6. [Avant la mise en ligne](#6-avant-la-mise-en-ligne)

> **Règle d'or** : faites toujours une **copie de sauvegarde** de `index.html` avant
> toute modification. Ouvrez le fichier avec un éditeur de texte simple
> (Bloc-notes, Notepad++, VS Code…), **jamais** avec Word.

---

## Comment le site est organisé

Tout le texte visible du site vit dans un seul endroit du fichier `index.html` :
un dictionnaire appelé **`D`**, avec une entrée par langue :

- `D.fr` → français
- `D.pt` → portugais
- `D.en` → anglais

Vous n'avez **jamais** besoin de toucher au reste du code. Vous ne modifiez que
les **textes entre guillemets** à l'intérieur de `D`.

> Chaque texte que vous changez en français (`D.fr`) doit, si possible, être changé
> aussi dans `D.pt` et `D.en`, pour que les trois langues restent cohérentes.

---

## 1. Modifier un texte

1. Ouvrez `public/index.html` dans un éditeur de texte.
2. Utilisez la fonction **Rechercher** (Ctrl+F) pour trouver le texte à changer,
   par exemple `Mot du Consul honoraire`.
3. Modifiez uniquement le texte **entre les guillemets**. Ne supprimez ni les
   guillemets `"`, ni les virgules, ni les accolades `{ }`.

**Exemple** — pour changer le titre d'une carte :

```js
{ icon: "ic-check", title: "Ce que nous faisons", text: "Informer, orienter, assister et représenter." }
```

Vous pouvez remplacer `Ce que nous faisons` par un autre libellé :

```js
{ icon: "ic-check", title: "Nos services", text: "Informer, orienter, assister et représenter." }
```

4. Enregistrez le fichier, puis ouvrez-le dans le navigateur (ou actualisez avec F5)
   pour vérifier.

> **Accents et caractères spéciaux** : écrivez normalement (é, à, ç, ã, ô…).
> Le fichier est enregistré en UTF-8, ils s'afficheront correctement.
> Pour mettre un mot **en gras** dans un paragraphe, entourez-le de
> `<strong>` et `</strong>` : `Convention de <strong>Vienne</strong>`.

---

## 2. Ajouter ou modifier une actualité

Les actualités se trouvent dans la liste **`news`** de chaque langue
(cherchez `news:` dans le fichier).

Chaque actualité est un bloc de cette forme :

```js
{
  cat: "Communiqué",          // rubrique : Communiqué, Diaspora, Économie, Culture…
  r: 1,                        // 1 = « à la une » (mise en avant) ; 0 = normale
  d: "2026-07-10",             // date au format AAAA-MM-JJ
  t: "Titre de l'actualité",
  x: "Texte de l'actualité, en une ou deux phrases."
}
```

**Pour ajouter une actualité**, copiez un bloc existant, collez-le juste au-dessus,
modifiez son contenu, et n'oubliez pas la **virgule** entre deux blocs :

```js
news: [
  {
    cat: "Communiqué", r: 1, d: "2026-09-01",
    t: "Nouvelle information importante",
    x: "Description de la nouvelle information."
  },
  {
    cat: "Diaspora", r: 0, d: "2026-06-24",
    t: "Ancienne actualité…",
    x: "…"
  }
]
```

- La rubrique que vous indiquez dans `cat` apparaît **automatiquement** comme
  filtre sur la page Actualités. Pour garder des filtres cohérents, réutilisez les
  mêmes noms de rubriques (`Communiqué`, `Diaspora`, `Économie`, `Culture`).
- Pensez à ajouter la même actualité dans `D.pt` (rubrique `Comunicado`,
  `Diáspora`, `Economia`…) et `D.en` (`Statement`, `Diaspora`, `Economy`…) pour
  qu'elle apparaisse aussi dans les autres langues.

---

## 3. Publier un document PDF

Les documents téléchargeables sont décrits dans les blocs de type `downloads`
(cherchez `type: "downloads"`). Tant qu'un document n'a pas de lien, il apparaît
comme **« à venir »** et n'est pas cliquable.

**Étapes :**

1. Placez le fichier PDF dans **`public/`**, par exemple dans un dossier
   `public/documents/`. Donnez-lui un nom simple, sans espace ni accent :
   `demarches.pdf`.
2. Dans le bloc `downloads`, ajoutez le champ `href` qui pointe vers ce fichier :

```js
items: [
  { t: "Liste des démarches et des autorités compétentes",
    desc: "Document d'information — mis à jour en 2026",
    href: "documents/demarches.pdf",
    format: "PDF" }
]
```

3. Enregistrez et vérifiez : le document devient cliquable et se télécharge.

> **Sécurité** : ne publiez jamais de document contenant des données personnelles
> (copie de pièce d'identité, etc.).

---

## 4. Remplir les informations « à valider »

Partout où une information officielle manque encore, le site affiche un
**marqueur surligné en jaune** de la forme :

- `[À VALIDER PAR LE CONSULAT : …]` (français)
- `[A VALIDAR PELO CONSULADO : …]` (portugais)
- `[TO BE CONFIRMED BY THE CONSULATE : …]` (anglais)

**Pour chaque marqueur**, cherchez-le dans le fichier (Ctrl+F) et remplacez le
marqueur **entier, crochets compris**, par l'information réelle.

**Exemple :**

```js
{ k: "Téléphone", v: "[À VALIDER : +41 …]" }
```

devient

```js
{ k: "Téléphone", v: "+41 22 000 00 00" }
```

Informations à fournir en priorité : ville, adresse du bureau, téléphone,
permanence, courriel, nom du Consul honoraire, et **ville + adresse de l'Ambassade
de rattachement**. Ces mêmes informations figurent aussi :

- dans les **données structurées** (cherchez `application/ld+json` dans `index.html`) ;
- dans les fichiers `sitemap.xml` et `robots.txt` (le **domaine** du site).

---

## 5. Ajouter les polices, les armoiries et les images

Ces éléments sont **facultatifs** : sans eux, le site reste lisible (polices
système, emplacements d'image réservés). Pour un rendu définitif :

- **Polices** : créez un dossier `public/fonts/` et déposez-y les
  fichiers `montserrat-600.woff2`, `montserrat-700.woff2`, `lato-400.woff2`,
  `lato-700.woff2`. Le site les utilisera automatiquement.
- **Armoiries officielles** : dans `index.html`, cherchez
  `EMPLACEMENT ARMOIRIES OFFICIELLES` et remplacez l'icône temporaire par le
  fichier vectoriel **autorisé par le Ministère des Affaires étrangères**.
- **Photographies** : les zones grisées « Photographie officielle » et
  « Portrait du Consul » indiquent où placer les images et à quel format.
  N'utilisez **jamais** de photo générée automatiquement ni de personne fictive.
- **Image de partage** (réseaux sociaux) : déposez une image `partage.jpg`
  (1200 × 630 px) dans `public/` et décommentez la ligne `og:image` dans `public/index.html`.

---

## 6. Avant la mise en ligne

- [ ] Remplacer **toutes** les mentions `www.consulat-guineebissau.ch` par le
      **domaine officiel** dans `index.html`, `sitemap.xml` et `robots.txt`.
- [ ] Remplir tous les marqueurs `[À VALIDER …]` (voir section 4).
- [ ] Faire **relire les traductions** portugaise et anglaise par un locuteur natif.
- [ ] **Brancher le formulaire de contact** à un service d'envoi de courriel :
      dans `index.html`, cherchez `BRANCHEMENT DU BACKEND À FAIRE PAR LE CLIENT`.
      De préférence, choisir un prestataire hébergé en Suisse ou dans l'Union
      européenne (conformité nLPD / RGPD).
- [ ] Vérifier le site sur ordinateur **et** sur téléphone, dans les trois langues.
- [ ] Déposer les fichiers (`index.html`, `sitemap.xml`, `robots.txt`, dossiers
      `fonts/`, `documents/`, images) chez l'hébergeur.

---

### Rappel important

Ce site est **informatif**. Il ne doit jamais laisser croire que le consulat
honoraire délivre un document officiel (passeport, visa, acte d'état civil,
légalisation). Ces démarches relèvent exclusivement de l'Ambassade compétente.
Conservez toujours cette distinction lors de vos modifications.
