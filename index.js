/**
 * ============================================================
 *  LOCKURL BOT  —  Anti-vol de vanity URL (full préfixe)
 * ============================================================
 *  - Seule variable nécessaire : TOKEN.
 *  - Owner détecté automatiquement (= propriétaire du bot Discord).
 *  - TOUT se configure depuis le bot via le panneau %lock :
 *      vanity verrouillée, sanction, salon de logs, whitelist, préfixe.
 *  - Commandes 100% préfixe (%), réponses dans le salon.
 *
 *  Quand la vanity est modifiée : restauration + sanction de l'auteur,
 *  lancées en parallèle, au plus vite.
 *
 *  Prérequis Discord :
 *   - Serveur Boost niveau 3 (ou partenaire/vérifié) = possède une vanity
 *   - Bot : "Gérer le serveur" + "Voir les logs d'audit" + "Gérer les rôles"
 *   - Intents "Server Members" + "Message Content" activés (Developer Portal)
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
  ChannelSelectMenuBuilder,
  UserSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  Routes,
} = require('discord.js');

const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config();

// ------------------------------------------------------------
//  Seule variable requise : TOKEN
// ------------------------------------------------------------
const TOKEN = process.env.TOKEN;
if (!TOKEN) {
  console.error('❌ La variable TOKEN est obligatoire.');
  process.exit(1);
}
// (Optionnel) dossier de stockage — pointe vers un Volume Railway pour persister.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// ------------------------------------------------------------
//  CONFIG  (tout est modifiable via les commandes, pas via l'env)
// ------------------------------------------------------------
const DEFAULTS = {
  prefix: '%',
  guildId: null, // serveur protégé (auto-défini quand tu utilises %lock)
  code: null, // vanity verrouillée
  punishment: 'derank', // derank | kick | ban | none
  logChannelId: null,
  whitelist: [], // IDs autorisés à changer la vanity sans sanction
  extraOwners: [], // co-owners ajoutés via %owner (en plus du propriétaire du bot)
};

function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}
function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (e) {
    console.warn('⚠️  Config non sauvegardée (ajoute un Volume Railway pour la persistance) :', e.message);
  }
}

let config = loadConfig();

// Owner du bot (rempli au démarrage à partir de l'application Discord)
let OWNER_IDS = new Set();
// Propriétaire(s) de l'application : seuls eux peuvent gérer les co-owners.
const isPrimaryOwner = (id) => OWNER_IDS.has(id);
// Owner "effectif" = propriétaire de l'app OU co-owner ajouté via %owner.
const isOwner = (id) => OWNER_IDS.has(id) || config.extraOwners.includes(id);

// ------------------------------------------------------------
//  CLIENT
// ------------------------------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.GuildMember],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================
//  PROTECTION : restauration + sanction
// ============================================================

async function restoreVanity(guild, t0) {
  try {
    await guild.client.rest.patch(Routes.guildVanityUrl(guild.id), {
      body: { code: config.code },
      reason: 'LockURL: restauration vanity',
    });
    console.log(`⚡ Vanity restaurée "${config.code}" en ${Date.now() - t0}ms`);
    return { ok: true };
  } catch (err) {
    // On affiche le VRAI message d'erreur de Discord (sans rien supposer).
    const status = err?.status ?? err?.httpStatus;
    const dcode = err?.code;
    const dmsg = err?.rawError?.message || err?.message || 'erreur inconnue';
    console.error('❌ Restauration vanity échouée — erreur Discord brute :', {
      status,
      code: dcode,
      message: dmsg,
    });

    let hint = '';
    if (status === 429 || /rate|limit/i.test(dmsg)) {
      hint = ' → rate-limit du vanity (changé trop souvent). Attends quelques heures avant de retester.';
    } else if (dcode === 50013) {
      hint = ' → vérifie la permission "Gérer le serveur" / la hiérarchie du rôle du bot.';
    } else if (status === 403) {
      hint = ' → 403 malgré les perms : très probablement le rate-limit anti-spam du vanity (attends quelques heures).';
    }
    return { ok: false, reason: `Discord ${status ?? '?'} (code ${dcode ?? '?'}) : ${dmsg}${hint}` };
  }
}

async function findExecutor(guild) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.GuildUpdate, limit: 5 });
      const entry = logs.entries.find((e) => e.changes?.some((c) => c.key === 'vanity_url_code'));
      if (entry?.executor) return entry.executor;
    } catch {
      /* on réessaie */
    }
    await sleep(120);
  }
  return null;
}

async function punish(guild, executor, t0) {
  if (!executor || config.punishment === 'none') return;
  if (config.whitelist.includes(executor.id)) return;
  if (executor.id === guild.ownerId) return;
  if (executor.id === client.user.id) return;

  let member = guild.members.cache.get(executor.id);
  if (!member) {
    try {
      member = await guild.members.fetch(executor.id);
    } catch {
      return;
    }
  }

  const me = guild.members.me ?? (await guild.members.fetchMe());
  const myTop = me.roles.highest.position;

  try {
    if (config.punishment === 'ban') {
      await member.ban({ reason: 'LockURL: vol de vanity URL' });
    } else if (config.punishment === 'kick') {
      await member.kick('LockURL: vol de vanity URL');
    } else {
      const keep = member.roles.cache
        .filter((r) => r.id === guild.id || r.managed || r.position >= myTop)
        .map((r) => r.id);
      await member.roles.set(keep, 'LockURL: vol de vanity URL');
    }
    console.log(`⚡ ${config.punishment} de ${executor.tag} en ${Date.now() - t0}ms`);
  } catch (err) {
    console.warn(`⚠️  Sanction impossible : ${err.message}`);
  }
}

async function sendLog(guild, attempted, executor, ms, restore) {
  if (!config.logChannelId) return;
  try {
    const channel = await guild.channels.fetch(config.logChannelId);
    if (!channel?.isTextBased()) return;
    const embed = new EmbedBuilder()
      .setColor(restore.ok ? 0xff3b30 : 0xed4245)
      .setTitle('🔒 Tentative de vol de vanity')
      .addFields(
        { name: 'Code tenté', value: `\`${attempted ?? 'aucun'}\``, inline: true },
        {
          name: 'Restauration',
          value: restore.ok ? `✅ \`${config.code}\` remis` : `❌ ÉCHEC — ${restore.reason}`,
          inline: true,
        },
        { name: 'Réaction', value: `${ms}ms`, inline: true },
        { name: 'Auteur', value: executor ? `${executor} (\`${executor.id}\`)` : 'Inconnu' },
        { name: 'Sanction', value: config.punishment, inline: true },
      )
      .setTimestamp();
    await channel.send({ embeds: [embed] });
  } catch {
    /* ignore */
  }
}

// Prévient l'owner quand la restauration échoue (salon de logs sinon MP).
async function alertRestoreFailure(guild, reason) {
  const text =
    `⚠️ **La vanity a été modifiée mais je n'ai PAS pu la remettre.**\n` +
    `Raison : ${reason}\n\n` +
    `👉 Si c'est une permission : donne au bot **Gérer le serveur**.\n` +
    `👉 Si c'est un rate-limit : attends que la limite Discord retombe (peut durer plusieurs heures si l'URL a beaucoup changé).`;
  try {
    if (config.logChannelId) {
      const ch = await guild.channels.fetch(config.logChannelId);
      if (ch?.isTextBased()) return void ch.send(text);
    }
    const ownerId = [...OWNER_IDS][0];
    if (ownerId) {
      const user = await client.users.fetch(ownerId);
      await user.send(text);
    }
  } catch {
    /* ignore */
  }
}

client.on('guildUpdate', (oldGuild, newGuild) => {
  if (!config.guildId || newGuild.id !== config.guildId) return;
  if (!config.code) return;

  const attempted = newGuild.vanityURLCode;
  if (oldGuild.vanityURLCode === attempted) return;
  if (attempted === config.code) return; // déjà bon -> stop boucle

  const t0 = Date.now();
  console.log(`🚨 Vanity modifiée -> "${attempted}". Réaction...`);

  const restoreP = restoreVanity(newGuild, t0);
  const punishP = (async () => {
    const executor = await findExecutor(newGuild);
    await punish(newGuild, executor, t0);
    return executor;
  })();

  Promise.all([restoreP, punishP]).then(([restore, executor]) => {
    sendLog(newGuild, attempted, executor, Date.now() - t0, restore);
    if (!restore.ok) alertRestoreFailure(newGuild, restore.reason);
  });
});

// Applique (et donc verrouille) une vanity sur le serveur.
async function setGuildVanity(guild, code) {
  await guild.client.rest.patch(Routes.guildVanityUrl(guild.id), {
    body: { code },
    reason: 'LockURL: définition via %lock',
  });
}

// ============================================================
//  AIDE  %help  (menu déroulant, in-channel)
// ============================================================
function formatUptime(ms) {
  if (!ms) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${d}j ${h}h ${m}m`;
}

const HELP_CATEGORIES = {
  home: {
    label: 'Accueil',
    emoji: '🏠',
    description: "Vue d'ensemble",
    build: () =>
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('🔒 LockURL — Aide')
        .setDescription('Bot anti-vol de **vanity URL**.\nChoisis une catégorie ci-dessous 👇')
        .addFields(
          { name: '🔒 Vanity', value: 'Verrouillage et restauration de l’URL.' },
          { name: '⚙️ Configuration', value: 'Tout se règle via le panneau, pas de variables.' },
          { name: '📊 Infos', value: 'Commandes, latence, uptime.' },
        )
        .setFooter({ text: 'Réservé à l’owner du bot' }),
  },
  vanity: {
    label: 'Vanity',
    emoji: '🔒',
    description: 'Protection de l’URL',
    build: () =>
      new EmbedBuilder()
        .setColor(0xff3b30)
        .setTitle('🔒 Protection Vanity')
        .setDescription(
          'Si la vanity est modifiée : **restauration + sanction** de l’auteur, ' +
            'en parallèle et au plus vite.',
        )
        .addFields(
          { name: `${config.prefix}lock`, value: 'Ouvre le panneau de contrôle (tout se gère ici).' },
          { name: 'Verrouiller la vanity actuelle', value: 'Fige l’URL en place via le panneau.' },
          { name: 'Définir un code précis', value: 'Change l’URL et la verrouille (popup).' },
          { name: 'Désactiver', value: 'Stoppe la protection.' },
        ),
  },
  config: {
    label: 'Configuration',
    emoji: '⚙️',
    description: 'Réglages via le bot',
    build: () =>
      new EmbedBuilder()
        .setColor(0xfaa61a)
        .setTitle('⚙️ Configuration')
        .setDescription(`Tout se règle dans \`${config.prefix}lock\` — aucune variable à part le token.`)
        .addFields(
          { name: '🔒 Vanity verrouillée', value: config.code ? `\`${config.code}\`` : '—', inline: true },
          { name: '⚔️ Sanction', value: `\`${config.punishment}\``, inline: true },
          { name: '📋 Salon de logs', value: config.logChannelId ? `<#${config.logChannelId}>` : '—', inline: true },
          { name: '👥 Whitelist', value: config.whitelist.length ? `${config.whitelist.length} membre(s)` : 'vide', inline: true },
          { name: '🔤 Préfixe', value: `\`${config.prefix}\``, inline: true },
          { name: '🛡️ Serveur protégé', value: config.guildId ? `\`${config.guildId}\`` : 'non défini', inline: true },
        ),
  },
  infos: {
    label: 'Infos',
    emoji: '📊',
    description: 'Commandes & état',
    build: () =>
      new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle('📊 Infos')
        .addFields(
          { name: `${config.prefix}help`, value: 'Affiche ce panneau (owner).' },
          { name: `${config.prefix}lock`, value: 'Panneau de configuration (owner).' },
          { name: `${config.prefix}owner`, value: 'Gérer les co-owners (propriétaire du bot).' },
          { name: 'Latence WebSocket', value: `${Math.max(0, Math.round(client.ws.ping))} ms`, inline: true },
          { name: 'Uptime', value: formatUptime(client.uptime), inline: true },
        )
        .setFooter({ text: 'LockURL Bot' }),
  },
};

function buildHelpMessage(categoryKey = 'home') {
  const cat = HELP_CATEGORIES[categoryKey] ?? HELP_CATEGORIES.home;
  const menu = new StringSelectMenuBuilder()
    .setCustomId('help_menu')
    .setPlaceholder('📚 Choisis une catégorie…')
    .addOptions(
      Object.entries(HELP_CATEGORIES).map(([key, c]) => ({
        label: c.label,
        value: key,
        description: c.description,
        emoji: c.emoji,
        default: key === categoryKey,
      })),
    );
  return { embeds: [cat.build()], components: [new ActionRowBuilder().addComponents(menu)] };
}

// ============================================================
//  PANNEAU  %lock  (configuration, in-channel, owner only)
// ============================================================
const backRow = () =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('lock_back').setLabel('← Retour').setStyle(ButtonStyle.Secondary),
  );

function buildLockPanel(note) {
  const embed = new EmbedBuilder()
    .setColor(config.code ? 0xff3b30 : 0x99aab5)
    .setTitle('🔒 Panneau de configuration')
    .addFields(
      { name: 'État', value: config.code ? '🟢 Verrou **ACTIF**' : '⚪ Inactif', inline: true },
      { name: 'Code', value: config.code ? `\`${config.code}\`` : '—', inline: true },
      { name: 'Sanction', value: `\`${config.punishment}\``, inline: true },
      { name: 'Logs', value: config.logChannelId ? `<#${config.logChannelId}>` : '—', inline: true },
      { name: 'Whitelist', value: config.whitelist.length ? `${config.whitelist.length} membre(s)` : 'vide', inline: true },
      { name: 'Préfixe', value: `\`${config.prefix}\``, inline: true },
    )
    .setFooter({ text: 'Choisis une action ci-dessous' });
  if (note) embed.setDescription(note);

  const menu = new StringSelectMenuBuilder()
    .setCustomId('lock_action')
    .setPlaceholder('⚙️ Que veux-tu faire ?')
    .addOptions(
      { label: 'Verrouiller la vanity actuelle', value: 'lock_current', emoji: '🔒', description: 'Fige l’URL en place' },
      { label: 'Définir un code précis', value: 'set_code', emoji: '✏️', description: 'Change l’URL et la verrouille' },
      { label: 'Désactiver le verrou', value: 'unlock', emoji: '🔓', description: 'Stoppe la protection' },
      { label: 'Changer la sanction', value: 'change_punish', emoji: '⚔️', description: 'derank / kick / ban / none' },
      { label: 'Définir le salon de logs', value: 'set_log', emoji: '📋', description: 'Où envoyer les alertes' },
      { label: 'Gérer la whitelist', value: 'manage_wl', emoji: '👥', description: 'Membres autorisés' },
      { label: 'Changer le préfixe', value: 'set_prefix', emoji: '🔤', description: 'Par défaut : %' },
      { label: 'Rafraîchir', value: 'refresh', emoji: '🔄', description: 'Recharger l’état' },
    );
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] };
}

function buildPunishPanel() {
  const embed = new EmbedBuilder()
    .setColor(0xfaa61a)
    .setTitle('⚔️ Sanction de l’auteur')
    .setDescription(`Actuelle : \`${config.punishment}\``);
  const menu = new StringSelectMenuBuilder()
    .setCustomId('lock_punish')
    .setPlaceholder('Choisis la sanction…')
    .addOptions(
      { label: 'Derank (retirer tous les rôles)', value: 'derank', emoji: '🧹', default: config.punishment === 'derank' },
      { label: 'Kick (expulser)', value: 'kick', emoji: '👢', default: config.punishment === 'kick' },
      { label: 'Ban (bannir)', value: 'ban', emoji: '🔨', default: config.punishment === 'ban' },
      { label: 'Aucune', value: 'none', emoji: '🚫', default: config.punishment === 'none' },
    );
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu), backRow()] };
}

function buildLogPanel() {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('📋 Salon de logs')
    .setDescription(
      (config.logChannelId ? `Actuel : <#${config.logChannelId}>\n\n` : '') +
        'Sélectionne le salon où envoyer les alertes de vol.',
    );
  const menu = new ChannelSelectMenuBuilder()
    .setCustomId('lock_set_log')
    .setPlaceholder('Choisis un salon…')
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu), backRow()] };
}

function buildWhitelistPanel() {
  const list = config.whitelist.length ? config.whitelist.map((i) => `<@${i}>`).join(', ') : 'vide';
  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('👥 Whitelist')
    .setDescription(
      `Membres autorisés à changer la vanity **sans sanction**.\nActuels : ${list}\n\n` +
        'Sélectionne les membres (la sélection **remplace** la liste). Choisis 0 pour vider.',
    );
  const menu = new UserSelectMenuBuilder()
    .setCustomId('lock_wl')
    .setPlaceholder('Choisis les membres…')
    .setMinValues(0)
    .setMaxValues(25);
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu), backRow()] };
}

// ============================================================
//  DISPATCHER des commandes préfixe  (in-channel, owner only)
// ============================================================
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild || !message.content) return;
  const prefix = config.prefix || '%';
  if (!message.content.startsWith(prefix)) return;

  const parts = message.content.slice(prefix.length).trim().split(/\s+/);
  const name = parts[0]?.toLowerCase();
  if (name !== 'help' && name !== 'lock' && name !== 'owner') return;
  if (!isOwner(message.author.id)) return; // silencieux pour les autres

  // --- %owner : gérer les co-owners (réservé au propriétaire de l'app) ---
  if (name === 'owner') {
    if (!isPrimaryOwner(message.author.id)) {
      return message.reply('⛔ Seul le propriétaire du bot peut gérer les owners.').catch(() => {});
    }
    const sub = parts[1]?.toLowerCase();
    const raw = parts[2] || '';
    const targetId = raw.replace(/[<@!>]/g, ''); // accepte une mention ou un ID brut

    if (sub === 'add') {
      if (!/^\d{17,20}$/.test(targetId)) {
        return message.reply(`Usage : \`${prefix}owner add @membre\` (ou son ID).`).catch(() => {});
      }
      if (OWNER_IDS.has(targetId)) {
        return message.reply('ℹ️ Ce membre est déjà propriétaire du bot.').catch(() => {});
      }
      if (!config.extraOwners.includes(targetId)) {
        config.extraOwners.push(targetId);
        saveConfig();
      }
      return message.reply(`✅ <@${targetId}> peut désormais utiliser les commandes.`).catch(() => {});
    }

    if (sub === 'remove' || sub === 'rem' || sub === 'del') {
      config.extraOwners = config.extraOwners.filter((i) => i !== targetId);
      saveConfig();
      return message.reply(`✅ <@${targetId}> n’est plus co-owner.`).catch(() => {});
    }

    // %owner list (par défaut)
    const primary = [...OWNER_IDS].map((i) => `<@${i}> (propriétaire)`).join('\n') || '—';
    const extras = config.extraOwners.map((i) => `<@${i}>`).join('\n') || 'aucun';
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('👑 Owners')
      .addFields(
        { name: 'Propriétaire(s) du bot', value: primary },
        { name: 'Co-owners ajoutés', value: extras },
      )
      .setFooter({ text: `${prefix}owner add @membre  •  ${prefix}owner remove @membre` });
    return message.reply({ embeds: [embed] }).catch(() => {});
  }

  if (name === 'help') {
    if (!config.guildId) {
      config.guildId = message.guild.id;
      saveConfig();
    }
    return message.reply(buildHelpMessage('home')).catch(() => {});
  }

  // %lock : on (re)définit le serveur protégé sur celui-ci
  if (config.guildId !== message.guild.id) {
    config.guildId = message.guild.id;
    saveConfig();
  }
  return message.reply(buildLockPanel()).catch(() => {});
});

// ============================================================
//  INTERACTIONS (menus, popups, boutons) — owner only
// ============================================================
const OUR_IDS = [
  'help_menu',
  'lock_action',
  'lock_punish',
  'lock_set_log',
  'lock_wl',
  'lock_back',
  'lock_set_code_modal',
  'lock_set_prefix_modal',
];

client.on('interactionCreate', async (interaction) => {
  const id = interaction.customId;
  if (!id || !OUR_IDS.includes(id)) return;

  if (!isOwner(interaction.user.id)) {
    return interaction.reply({ content: '⛔ Réservé à l’owner du bot.', ephemeral: true });
  }

  // --- Aide ---
  if (id === 'help_menu') return interaction.update(buildHelpMessage(interaction.values[0]));

  // --- Retour ---
  if (id === 'lock_back') return interaction.update(buildLockPanel());

  // --- Menu principal ---
  if (id === 'lock_action') {
    const action = interaction.values[0];

    if (action === 'refresh') return interaction.update(buildLockPanel());

    if (action === 'unlock') {
      config.code = null;
      saveConfig();
      return interaction.update(buildLockPanel('🔓 Verrou désactivé.'));
    }

    if (action === 'change_punish') return interaction.update(buildPunishPanel());
    if (action === 'set_log') return interaction.update(buildLogPanel());
    if (action === 'manage_wl') return interaction.update(buildWhitelistPanel());

    if (action === 'lock_current') {
      try {
        const guild = interaction.guild ?? (await client.guilds.fetch(config.guildId));
        const data = await guild.fetchVanityData();
        if (!data.code) return interaction.update(buildLockPanel('❌ Aucune vanity définie sur le serveur.'));
        config.code = data.code;
        config.guildId = guild.id;
        saveConfig();
        return interaction.update(buildLockPanel(`🔒 Verrouillé sur la vanity actuelle : \`${data.code}\``));
      } catch {
        return interaction.update(buildLockPanel('❌ Lecture de la vanity impossible (Boost niveau 3 ?).'));
      }
    }

    if (action === 'set_code') {
      const modal = new ModalBuilder()
        .setCustomId('lock_set_code_modal')
        .setTitle('Définir le code vanity')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('code')
              .setLabel('Code (après discord.gg/)')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('ex: riche')
              .setRequired(true)
              .setMaxLength(50),
          ),
        );
      return interaction.showModal(modal);
    }

    if (action === 'set_prefix') {
      const modal = new ModalBuilder()
        .setCustomId('lock_set_prefix_modal')
        .setTitle('Changer le préfixe')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('prefix')
              .setLabel('Nouveau préfixe (1 à 5 caractères)')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('%')
              .setRequired(true)
              .setMaxLength(5),
          ),
        );
      return interaction.showModal(modal);
    }
    return;
  }

  // --- Sous-menu sanction ---
  if (id === 'lock_punish') {
    config.punishment = interaction.values[0];
    saveConfig();
    return interaction.update(buildLockPanel(`⚔️ Sanction réglée sur \`${config.punishment}\`.`));
  }

  // --- Salon de logs ---
  if (id === 'lock_set_log') {
    config.logChannelId = interaction.values[0];
    saveConfig();
    return interaction.update(buildLockPanel(`📋 Salon de logs : <#${config.logChannelId}>`));
  }

  // --- Whitelist ---
  if (id === 'lock_wl') {
    config.whitelist = interaction.values;
    saveConfig();
    const list = config.whitelist.length ? config.whitelist.map((i) => `<@${i}>`).join(', ') : 'vide';
    return interaction.update(buildLockPanel(`👥 Whitelist mise à jour : ${list}`));
  }

  // --- Popup : code vanity ---
  if (id === 'lock_set_code_modal') {
    const code = interaction.fields.getTextInputValue('code').trim();
    try {
      const guild = interaction.guild ?? (await client.guilds.fetch(config.guildId));
      await setGuildVanity(guild, code);
      config.code = code;
      config.guildId = guild.id;
      saveConfig();
      return interaction.update(buildLockPanel(`✅ Vanity définie et verrouillée sur \`${code}\`.`));
    } catch {
      return interaction.update(buildLockPanel(`❌ Impossible de définir \`${code}\` (déjà pris, invalide, ou rate-limit).`));
    }
  }

  // --- Popup : préfixe ---
  if (id === 'lock_set_prefix_modal') {
    const p = interaction.fields.getTextInputValue('prefix').trim();
    if (!p || /\s/.test(p)) {
      return interaction.update(buildLockPanel('❌ Préfixe invalide (pas d’espaces).'));
    }
    config.prefix = p;
    saveConfig();
    return interaction.update(buildLockPanel(`🔤 Préfixe changé en \`${p}\`. Utilise désormais \`${p}lock\`.`));
  }
});

// ============================================================
//  READY
// ============================================================
client.once('ready', async () => {
  console.log(`✅ Connecté : ${client.user.tag}`);

  // Détection automatique de l'owner du bot (compte ou équipe propriétaire).
  try {
    const app = await client.application.fetch();
    OWNER_IDS = new Set();
    if (app.owner) {
      if (app.owner.members) {
        // Équipe : tous les membres de l'équipe sont owners
        app.owner.members.forEach((m) => OWNER_IDS.add(m.user?.id ?? m.id));
      } else {
        OWNER_IDS.add(app.owner.id);
      }
    }
    console.log(`👑 Owner(s) du bot : ${[...OWNER_IDS].join(', ') || 'inconnu'}`);
  } catch (e) {
    console.error('❌ Détection de l’owner échouée :', e.message);
  }
  if (OWNER_IDS.size === 0) {
    console.warn('⚠️  Owner introuvable : les commandes ne répondront à personne.');
  }

  // Pré-charge le bot dans le cache du serveur protégé (sanction instantanée)
  // et vérifie qu'il a bien la permission de réécrire le vanity.
  if (config.guildId) {
    try {
      const guild = await client.guilds.fetch(config.guildId);
      const me = await guild.members.fetchMe();
      if (!me.permissions.has(PermissionFlagsBits.ManageGuild)) {
        console.warn(
          '⚠️  ATTENTION : le bot n’a PAS la permission "Gérer le serveur" — il pourra sanctionner mais PAS remettre le vanity !',
        );
      }
    } catch {
      /* ignore */
    }
  }

  console.log(
    config.code
      ? `🔒 Verrou actif sur "${config.code}" (serveur ${config.guildId})`
      : `ℹ️  Aucun verrou. Tape ${config.prefix}lock sur ton serveur pour configurer.`,
  );
});

client.login(TOKEN);
