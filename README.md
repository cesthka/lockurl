# 🔒 LockURL Bot (mode rapide)

Bot Discord anti-vol de **vanity URL**. Dès qu'une vanity est modifiée, il :
1. **restaure** la vanity verrouillée, et
2. **derank** l'auteur (retire tous ses rôles) — **les deux en parallèle**, au plus vite.

## ⚡ Pourquoi c'est rapide
- Les deux actions partent **dans le même tick**, sans s'attendre.
- Membre et rôles lus depuis le **cache** (pas de requête inutile).
- Derank en **un seul appel API** (`roles.set`).
- **Retries éclair** si rate-limit ou si l'audit log arrive avec un léger retard.

> ⏱️ La latence minimale dépend surtout du **gateway Discord** (le temps que
> Discord t'envoie l'événement) et de la propagation des **audit logs** pour
> identifier l'auteur — ça, aucun bot ne peut le contourner. Le code, lui,
> n'ajoute quasiment aucun délai.

## ⚠️ Conditions Discord
- Serveur **Boost niveau 3** (ou partenaire/vérifié) → possède une vanity.
- Intent **Server Members Intent** activé dans *Developer Portal > Bot*.
- Intent **Message Content Intent** activé aussi (nécessaire pour lire `%help`).
- Permissions du bot : **Gérer le serveur**, **Voir les logs d'audit**,
  **Gérer les rôles** (+ Expulser/Bannir selon PUNISHMENT).
- Le rôle du bot doit être **au-dessus** des membres à derank.

## 🚀 Déploiement sur Railway (via GitHub)

1. **Pousse ce dossier sur un repo GitHub** :
   ```bash
   git init
   git add .
   git commit -m "lockurl bot"
   git branch -M main
   git remote add origin https://github.com/TON_PSEUDO/lockurl-bot.git
   git push -u origin main
   ```
   Le `.gitignore` exclut `.env` (ne mets JAMAIS ton token sur GitHub).

2. Sur **railway.app** : *New Project -> Deploy from GitHub repo -> sélectionne ton repo*.
   Railway détecte Node.js et lance `npm start` automatiquement (pas besoin de
   domaine : le bot est un *worker* qui se connecte en sortie à Discord).

3. Dans l'onglet **Variables**, ajoute :
   | Clé              | Valeur                                     |
   |------------------|--------------------------------------------|
   | `TOKEN`          | ton token de bot                           |
   | `GUILD_ID`       | l'ID du serveur                            |
   | `OWNER_ID`       | ton ID Discord (accès au `%help`)          |
   | `LOCKED_VANITY`  | ton code (ex: `monserveur`)                |
   | `PUNISHMENT`     | `derank` (ou `kick` / `ban` / `none`)      |
   | `LOG_CHANNEL_ID` | (optionnel) ID d'un salon de logs          |
   | `WHITELIST`      | (optionnel) IDs autorisés, séparés par `,` |

4. Railway **redéploie automatiquement à chaque `git push`**. Dans les logs tu
   dois voir `Connecté` puis `Verrou actif`.

> Le disque de Railway est **éphémère** : c'est pourquoi on met le code dans la
> variable `LOCKED_VANITY` (permanente) plutôt que de compter sur `lock.json`.
>
> Railway n'a plus de vraie offre gratuite : ~5 $/mois (crédit d'essai de 5 $
> pour les nouveaux comptes ; un compte GitHub récent peut être limité au début).
>
> Sur Railway ton bot **partage une IP** avec d'autres utilisateurs : en cas
> d'attaque qui spamme les changements de vanity tu peux atteindre les
> rate-limits Discord plus vite (les retries du bot gèrent ça du mieux possible).

## 🛠️ Commandes
- `%help` -> panneau d'aide avec **menu déroulant**, envoyé **en MP**, **owner uniquement**
- `/lockurl lock` -> verrouille la vanity actuelle
- `/lockurl lock code:moncode` -> verrouille un code précis
- `/lockurl unlock` -> désactive
- `/lockurl status` -> état

> ℹ️ `%help` est réservé à l'ID défini dans `OWNER_ID`. Pour tout autre membre,
> le bot ne répond rien (la commande est invisible). Le menu est envoyé en
> message privé pour que toi seul le voies ; le `%help` tapé dans un salon est
> automatiquement supprimé si le bot en a la permission.

## 🧪 En local (test)
```bash
npm install
cp .env.example .env   # remplis le fichier
npm start
```
