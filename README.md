# 🔒 LockURL Bot

Bot Discord anti-vol de **vanity URL**, **100% commandes préfixe** (`%`).
Dès qu'une vanity est modifiée : **restauration + sanction** de l'auteur, en
parallèle et au plus vite. **Tout se configure depuis le bot** — la seule
variable à fournir est le **token**.

## ✨ Principes
- **Une seule variable : `TOKEN`.** Le reste (vanity, sanction, salon de logs,
  whitelist, préfixe, serveur protégé) se règle **dans Discord** via `%lock`.
- **Owner détecté automatiquement** = le compte (ou l'équipe) propriétaire du
  bot sur le Developer Portal. Lui seul peut utiliser les commandes.
- **Réponses dans le salon** où tu tapes la commande (pas de MP).

## ⚠️ Conditions Discord
- Serveur **Boost niveau 3** (ou partenaire/vérifié) → possède une vanity.
- Dans *Developer Portal > Bot*, active les deux intents privilégiés :
  **Server Members Intent** et **Message Content Intent**.
- Permissions du bot : **Gérer le serveur**, **Voir les logs d'audit**,
  **Gérer les rôles** (+ Expulser/Bannir selon la sanction choisie).
- Le rôle du bot doit être **au-dessus** des membres à sanctionner.

## 🛠️ Commandes (préfixe `%` par défaut)
- `%help` → aide avec menu déroulant
- `%lock` → **panneau de configuration** (menu déroulant + popups) :
  - 🔒 Verrouiller la vanity actuelle
  - ✏️ Définir un code précis (popup, applique + verrouille)
  - 🔓 Désactiver le verrou
  - ⚔️ Changer la sanction (derank / kick / ban / none)
  - 📋 Définir le salon de logs
  - 👥 Gérer la whitelist
  - 🔤 Changer le préfixe
  - 🔄 Rafraîchir

> Le serveur protégé est défini automatiquement sur celui où tu utilises `%lock`.

## 🚀 Déploiement sur Railway (via GitHub)
1. Pousse ce dossier sur un repo GitHub (le `.gitignore` protège ton `.env`) :
   ```bash
   git init
   git add .
   git commit -m "lockurl bot"
   git branch -M main
   git remote add origin https://github.com/TON_PSEUDO/lockurl-bot.git
   git push -u origin main
   ```
2. railway.app → *New Project → Deploy from GitHub repo* → ton repo.
3. Onglet **Variables** → ajoute seulement :
   | Clé     | Valeur           |
   |---------|------------------|
   | `TOKEN` | ton token de bot |
4. Railway redéploie à chaque `git push`. Logs attendus :
   ```
   ✅ Connecté : TonBot#1234
   👑 Owner(s) du bot : 123456789012345678
   ```
5. Sur ton serveur, tape `%lock` et configure tout depuis le panneau.

### 💾 Persistance (recommandé)
Le disque Railway est **éphémère** : ta config serait perdue au redéploiement.
Pour la garder : *service Railway → New Volume → Mount path `/data`*, puis ajoute
la variable `DATA_DIR=/data`. Le bot y stockera `config.json`.

## 🧪 En local
```bash
npm install
cp .env.example .env   # colle juste ton token
npm start
```
