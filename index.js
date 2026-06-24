/**
 * ============================================================
 *  LOCKURL BOT  —  Anti-vol de vanity URL (mode RAPIDE)
 * ============================================================
 *  Dès qu'une vanity est modifiée :
 *   1) la vanity verrouillée est RESTAURÉE  ┐ lancés EN PARALLÈLE,
 *   2) l'auteur est DERANK (rôles retirés)  ┘ sans s'attendre.
 *
 *  Tout est optimisé pour le minimum de ms :
 *   - aucun await avant de lancer les 2 actions
 *   - membre & rôles lus depuis le CACHE
 *   - derank en UN seul appel API (roles.set)
 *   - retries éclair en cas de rate-limit / course
 *
 *  Prérequis Discord :
 *   - Serveur Boost niveau 3 (ou partenaire/vérifié) = a une vanity
 *   - Bot : "Gérer le serveur" + "Voir les logs d'audit" + "Gérer les rôles"
 *   - Intent "Server Members" activé dans le Developer Portal
 * ============================================================
 */

const {
  Client,
  GatewayIntentBits,
  Partials,
  AuditLogEvent,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  Routes,
} = require('discord.js');

const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config();

// ------------------------------------------------------------
//  CONFIG (variables d'environnement)
// ------------------------------------------------------------
const TOKEN = process.env.TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || null;
// Code verrouillé permanent (recommandé sur Railway car le disque est éphémère).
const LOCKED_VANITY = (process.env.LOCKED_VANITY || '').trim() || null;
// Sanction : 'derank' (retire tous les rôles) | 'kick' | 'ban' | 'none'
const PUNISHMENT = (process.env.PUNISHMENT || 'derank').toLowerCase();
const WHITELIST = (process.env.WHITELIST || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// Préfixe des commandes texte (le %help) et owner autorisé à voir l'aide
const PREFIX = process.env.PREFIX || '%';
const OWNER_ID = process.env.OWNER_ID || null;

if (!TOKEN || !GUILD_ID) {
  console.error('❌ TOKEN et GUILD_ID sont obligatoires.');
  process.exit(1);
}

// ------------------------------------------------------------
//  VERROU (env prioritaire, sinon fichier local)
// ------------------------------------------------------------
const LOCK_FILE = path.join(__dirname, 'lock.json');

function loadLock() {
  if (LOCKED_VANITY) return { code: LOCKED_VANITY };
  try {
    return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
  } catch {
    return { code: null };
  }
}
function saveLock(data) {
  try {
    fs.writeFileSync(LOCK_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.warn('⚠️  Sauvegarde lock.json impossible (disque éphémère ?) :', e.message);
  }
}

let lock = loadLock();

// ------------------------------------------------------------
//  CLIENT (intents minimaux pour aller vite)
// ------------------------------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // requis pour lire "%help" (intent privilégié)
  ],
  partials: [Partials.GuildMember],
});

// petit sleep
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------
//  RESTAURATION DE LA VANITY  (rapide + retries)
// ------------------------------------------------------------
async function restoreVanity(guild, t0) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await guild.client.rest.patch(Routes.guildVanityUrl(guild.id), {
        body: { code: lock.code },
        reason: 'LockURL: restauration vanity',
      });
      console.log(`⚡ Vanity restaurée "${lock.code}" en ${Date.now() - t0}ms (essai ${attempt})`);
      return true;
    } catch (err) {
      // 429 = rate limit : on attend le délai demandé, sinon micro-backoff
      const wait = err?.retryAfter ? err.retryAfter * 1000 : 50 * attempt;
      if (attempt < 4) {
        await sleep(wait);
      } else {
        console.error(`❌ Restauration échouée après 4 essais : ${err.message}`);
      }
    }
  }
  return false;
}

// ------------------------------------------------------------
//  TROUVER L'AUTEUR via audit logs (retries car parfois en retard)
// ------------------------------------------------------------
async function findExecutor(guild) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const logs = await guild.fetchAuditLogs({
        type: AuditLogEvent.GuildUpdate,
        limit: 5,
      });
      const entry = logs.entries.find((e) =>
        e.changes?.some((c) => c.key === 'vanity_url_code'),
      );
      if (entry?.executor) return entry.executor;
    } catch {
      /* ignore, on réessaie */
    }
    await sleep(120); // l'entrée d'audit peut arriver avec un petit délai
  }
  return null;
}

// ------------------------------------------------------------
//  DERANK  (retire TOUS les rôles retirables en UN appel)
// ------------------------------------------------------------
async function derank(guild, executor, t0) {
  if (!executor) return;
  if (PUNISHMENT === 'none') return;
  if (WHITELIST.includes(executor.id)) return;
  if (executor.id === guild.ownerId) return;
  if (executor.id === client.user.id) return;

  // membre depuis le cache (rapide), sinon fetch
  let member = guild.members.cache.get(executor.id);
  if (!member) {
    try {
      member = await guild.members.fetch(executor.id);
    } catch {
      return; // déjà parti
    }
  }

  const me = guild.members.me ?? (await guild.members.fetchMe());
  const myTop = me.roles.highest.position;

  try {
    if (PUNISHMENT === 'ban') {
      await member.ban({ reason: 'LockURL: vol de vanity URL' });
    } else if (PUNISHMENT === 'kick') {
      await member.kick('LockURL: vol de vanity URL');
    } else {
      // derank : on garde uniquement ce qu'on NE PEUT PAS retirer
      // (@everyone, rôles gérés par une intégration, rôles au-dessus du bot)
      const keep = member.roles.cache
        .filter((r) => r.id === guild.id || r.managed || r.position >= myTop)
        .map((r) => r.id);
      await member.roles.set(keep, 'LockURL: vol de vanity URL');
    }
    console.log(`⚡ ${PUNISHMENT} de ${executor.tag} en ${Date.now() - t0}ms`);
  } catch (err) {
    console.warn(`⚠️  Sanction impossible : ${err.message}`);
  }
}

// ------------------------------------------------------------
//  LOG (non bloquant)
// ------------------------------------------------------------
async function sendLog(guild, attempted, executor, ms) {
  if (!LOG_CHANNEL_ID) return;
  try {
    const channel = await guild.channels.fetch(LOG_CHANNEL_ID);
    if (!channel?.isTextBased()) return;
    const embed = new EmbedBuilder()
      .setColor(0xff3b30)
      .setTitle('🔒 Vol de vanity bloqué')
      .addFields(
        { name: 'Code tenté', value: `\`${attempted ?? 'aucun'}\``, inline: true },
        { name: 'Code restauré', value: `\`${lock.code}\``, inline: true },
        { name: 'Réaction', value: `${ms}ms`, inline: true },
        {
          name: 'Auteur',
          value: executor ? `${executor} (\`${executor.id}\`)` : 'Inconnu',
        },
        { name: 'Sanction', value: PUNISHMENT, inline: true },
      )
      .setTimestamp();
    await channel.send({ embeds: [embed] });
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------------------
//  ÉVÉNEMENT : changement de vanity  ->  réaction immédiate
// ------------------------------------------------------------
client.on('guildUpdate', (oldGuild, newGuild) => {
  // Gardes 100% synchrones = aucune latence avant d'agir
  if (newGuild.id !== GUILD_ID) return;
  if (!lock.code) return;

  const attempted = newGuild.vanityURLCode;
  if (oldGuild.vanityURLCode === attempted) return; // pas un changement de vanity
  if (attempted === lock.code) return; // déjà bon (notre propre correction) -> stop boucle

  const t0 = Date.now();
  console.log(`🚨 Vanity modifiée -> "${attempted}". Réaction...`);

  // On LANCE les deux actions sans await => elles partent dans le même tick, en parallèle.
  const restoreP = restoreVanity(newGuild, t0);
  const punishP = (async () => {
    const executor = await findExecutor(newGuild);
    await derank(newGuild, executor, t0);
    return executor;
  })();

  // Log après coup, sans bloquer la réaction.
  Promise.all([restoreP, punishP]).then(([, executor]) => {
    sendLog(newGuild, attempted, executor, Date.now() - t0);
  });
});

// ------------------------------------------------------------
//  COMMANDES SLASH : /lockurl lock | unlock | status
// ------------------------------------------------------------
const commands = [
  {
    name: 'lockurl',
    description: 'Gérer le verrouillage du vanity URL',
    default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
    options: [
      {
        type: 1,
        name: 'lock',
        description: 'Verrouille la vanity actuelle (ou un code précis)',
        options: [
          { type: 3, name: 'code', description: 'Code à verrouiller', required: false },
        ],
      },
      { type: 1, name: 'unlock', description: 'Désactive le verrou' },
      { type: 1, name: 'status', description: 'État du verrou' },
    ],
  },
];

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'lockurl') return;
  const sub = interaction.options.getSubcommand();

  if (sub === 'lock') {
    let code = interaction.options.getString('code');
    if (!code) {
      try {
        code = (await interaction.guild.fetchVanityData()).code;
      } catch {
        return interaction.reply({
          content: '❌ Impossible de lire la vanity (serveur Boost niveau 3 requis).',
          ephemeral: true,
        });
      }
    }
    if (!code) {
      return interaction.reply({
        content: '❌ Aucune vanity à verrouiller. Définis-en une ou précise un `code`.',
        ephemeral: true,
      });
    }
    lock = { code };
    saveLock(lock);
    return interaction.reply({
      content:
        `🔒 Vanity verrouillée sur \`${code}\`.\n` +
        '💡 Sur Railway, ajoute aussi la variable `LOCKED_VANITY=' + code + '` pour la garder après un redéploiement.',
      ephemeral: true,
    });
  }

  if (sub === 'unlock') {
    lock = { code: null };
    saveLock(lock);
    return interaction.reply({
      content:
        '🔓 Verrou désactivé.' +
        (LOCKED_VANITY ? '\n⚠️ La variable `LOCKED_VANITY` le réactivera au prochain redémarrage.' : ''),
      ephemeral: true,
    });
  }

  if (sub === 'status') {
    return interaction.reply({
      content: lock.code
        ? `🔒 ACTIF sur \`${lock.code}\` — sanction : \`${PUNISHMENT}\``
        : '🔓 Aucun verrou actif.',
      ephemeral: true,
    });
  }
});

// ------------------------------------------------------------
//  SYSTÈME %help  —  menu déroulant, OWNER UNIQUEMENT, en privé
// ------------------------------------------------------------
function formatUptime(ms) {
  if (!ms) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${d}j ${h}h ${m}m`;
}

// Chaque catégorie = une option du menu déroulant.
const HELP_CATEGORIES = {
  home: {
    label: 'Accueil',
    emoji: '🏠',
    description: "Vue d'ensemble",
    build: () =>
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('🔒 LockURL — Panneau d’aide')
        .setDescription(
          'Bot anti-vol de **vanity URL**.\n' +
            'Choisis une catégorie dans le menu ci-dessous 👇',
        )
        .addFields(
          { name: '🔒 Anti-vol Vanity', value: 'Verrouillage et restauration de l’URL.' },
          { name: '⚙️ Configuration', value: 'Variables d’environnement du bot.' },
          { name: '📊 Infos', value: 'Aide, latence et uptime.' },
        )
        .setFooter({ text: 'Réservé à l’owner' }),
  },

  vanity: {
    label: 'Anti-vol Vanity',
    emoji: '🔒',
    description: 'Commandes de verrouillage',
    build: () =>
      new EmbedBuilder()
        .setColor(0xff3b30)
        .setTitle('🔒 Anti-vol Vanity')
        .setDescription(
          'Si la vanity est modifiée : **restauration + derank** de l’auteur, ' +
            'en parallèle et au plus vite.',
        )
        .addFields(
          { name: '/lockurl lock `[code]`', value: 'Verrouille la vanity actuelle (ou un code précis).' },
          { name: '/lockurl unlock', value: 'Désactive le verrou.' },
          { name: '/lockurl status', value: 'Affiche l’état du verrou et la sanction.' },
        )
        .setFooter({ text: 'Ces commandes sont des commandes slash ( / ).' }),
  },

  config: {
    label: 'Configuration',
    emoji: '⚙️',
    description: 'Variables d’environnement',
    build: () =>
      new EmbedBuilder()
        .setColor(0xfaa61a)
        .setTitle('⚙️ Configuration (variables d’environnement)')
        .setDescription('À définir dans `.env` (ou les *Variables* Railway).')
        .addFields(
          { name: 'TOKEN', value: 'Token du bot.', inline: true },
          { name: 'GUILD_ID', value: 'Serveur protégé.', inline: true },
          { name: 'OWNER_ID', value: 'Toi (accès au %help).', inline: true },
          { name: 'LOCKED_VANITY', value: 'Code vanity verrouillé.', inline: true },
          { name: 'PUNISHMENT', value: '`derank` / `kick` / `ban` / `none`.', inline: true },
          { name: 'WHITELIST', value: 'IDs autorisés (séparés par `,`).', inline: true },
          { name: 'LOG_CHANNEL_ID', value: 'Salon des alertes (optionnel).', inline: true },
          { name: 'PREFIX', value: `Préfixe texte (actuel : \`${PREFIX}\`).`, inline: true },
        ),
  },

  infos: {
    label: 'Infos',
    emoji: '📊',
    description: 'Aide, latence, uptime',
    build: () =>
      new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle('📊 Infos')
        .addFields(
          { name: `${PREFIX}help`, value: 'Affiche ce panneau (owner uniquement).' },
          { name: 'Latence WebSocket', value: `${Math.max(0, Math.round(client.ws.ping))} ms`, inline: true },
          { name: 'Uptime', value: formatUptime(client.uptime), inline: true },
        )
        .setFooter({ text: 'LockURL Bot' }),
  },
};

// Construit le message complet (embed + menu) pour une catégorie donnée.
function buildHelpMessage(categoryKey = 'home') {
  const cat = HELP_CATEGORIES[categoryKey] ?? HELP_CATEGORIES.home;
  const menu = new StringSelectMenuBuilder()
    .setCustomId('help_menu')
    .setPlaceholder('📚 Choisis une catégorie…')
    .addOptions(
      Object.entries(HELP_CATEGORIES).map(([key, c]) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(c.label)
          .setDescription(c.description)
          .setValue(key)
          .setEmoji(c.emoji)
          .setDefault(key === categoryKey),
      ),
    );
  return {
    embeds: [cat.build()],
    components: [new ActionRowBuilder().addComponents(menu)],
  };
}

// Déclencheur "%help" — owner uniquement, réponse en MP (toi seul la vois).
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.content) return;
  if (message.content.trim().toLowerCase() !== `${PREFIX}help`) return;
  // Owner only : pour tout autre membre, le bot ne fait RIEN (invisible).
  if (!OWNER_ID || message.author.id !== OWNER_ID) return;

  try {
    await message.author.send(buildHelpMessage('home'));
    // On efface "%help" du salon pour rester discret (si on en a le droit).
    if (message.guild && message.deletable) message.delete().catch(() => {});
  } catch {
    // MP fermés -> on prévient brièvement (seul cas où ça apparaît dans le salon).
    message
      .reply('❌ Je ne peux pas t’envoyer de MP. Ouvre tes messages privés puis réessaie.')
      .catch(() => {});
  }
});

// Interaction avec le menu déroulant — re-verrouillé sur l'owner.
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isStringSelectMenu() || interaction.customId !== 'help_menu') return;
  if (interaction.user.id !== OWNER_ID) {
    return interaction.reply({ content: '⛔ Ce menu est réservé à l’owner.', ephemeral: true });
  }
  await interaction.update(buildHelpMessage(interaction.values[0]));
});

// ------------------------------------------------------------
//  READY
// ------------------------------------------------------------
client.once('ready', async () => {
  console.log(`✅ Connecté : ${client.user.tag}`);
  try {
    await client.rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), {
      body: commands,
    });
    console.log('✅ Commandes slash enregistrées.');
  } catch (err) {
    console.error('❌ Enregistrement commandes :', err.message);
  }
  // Pré-charge le membre du bot dans le cache (derank instantané ensuite)
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.members.fetchMe();
  } catch {
    /* ignore */
  }
  console.log(lock.code ? `🔒 Verrou actif : "${lock.code}"` : 'ℹ️  Aucun verrou. Utilise /lockurl lock.');
  if (!OWNER_ID) console.warn('⚠️  OWNER_ID non défini : la commande %help ne répondra à personne.');
});

client.login(TOKEN);
