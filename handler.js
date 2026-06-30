/**
 * Ulric-X MD V13.1 - NEVER SILENT Command Handler
 *
 * RULES:
 * 1. Accept ONLY prefixes: . and /
 * 2. NEVER ignore any command silently
 * 3. Unknown command → suggest closest matches (max 3)
 * 4. Empty prefix → "Type a command"
 * 5. Wrong usage → show correct syntax
 * 6. Private mode → only owner commands
 * 7. Invalid prefix → ignore (only . and / work)
 */
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const config = require('./config');
const store  = require('./lib/store');
const utils  = require('./lib/utils');
const menu   = require('./lib/menu');
const ownerMod = require('./lib/owner');
const session = require('./lib/session');
const messageStore = require('./lib/messageStore');
const antiSystem = require('./lib/antiSystem');
const verified = require('./lib/verifiedReply');
const watchdog = require('./lib/watchdog');
const normalizer = require('./lib/normalizer');

const commands = new Map();
const categories = new Map();
let totalCount = 0;
let privateMode = false; // Private mode state

// ─── Levenshtein Distance for closest command suggestions ───────
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  return d[m][n];
}

function suggestCommands(input) {
  const all = Array.from(commands.keys());
  const inputLen = input.length;
  const inputLower = input.toLowerCase();
  const scored = all.map(name => {
    const nameLower = name.toLowerCase();
    let dist = levenshtein(inputLower, nameLower);
    // Bonus: if the command starts with the same letter, reduce distance
    if (nameLower[0] === inputLower[0]) dist -= 0.5;
    // Bonus: if input is a prefix of command, reduce distance
    if (nameLower.startsWith(inputLower)) dist -= 1;
    // Bonus: if command is a prefix of input, reduce distance
    if (inputLower.startsWith(nameLower)) dist -= 1;
    return { name, dist, lenDiff: Math.abs(name.length - inputLen) };
  });
  // Sort by: adjusted distance first, then length similarity
  scored.sort((a, b) => {
    if (a.dist !== b.dist) return a.dist - b.dist;
    return a.lenDiff - b.lenDiff;
  });
  // Return top 3 with original distance <= 4 (reasonable suggestions)
  return scored.filter(s => {
    const origDist = levenshtein(input, s.name);
    return origDist <= 4 && origDist > 0;
  }).slice(0, 3).map(s => s.name);
}

// ─── Commands that require arguments ────────────────────────────
const REQUIRES_ARGS = ['ai', 'ytmp3', 'ytmp4', 'tiktok', 'instagram', 'facebook',
  'twitter', 'sticker', 'take', 'weather', 'qr', 'translate', 'lyrics',
  'binary', 'morse', 'fancy', 'repeat', 'google', 'bing', 'duckduckgo',
  'wiki', 'movie', 'tvshow', 'book', 'recipe', 'define', 'synonym',
  'antonym', 'rhyme', 'urban', ' spotify', 'apk', 'github'];

function loadCommands() {
  const dir = path.join(__dirname, 'commands');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
  let total = 0;
  for (const f of files) {
    try {
      delete require.cache[path.join(dir, f)];
      const mod = require(path.join(dir, f));
      if (!Array.isArray(mod)) continue;
      for (const cmd of mod) {
        if (!cmd || !cmd.name || typeof cmd.handler !== 'function') continue;
        const safeFn = watchdog.safeHandler(cmd.handler);
        const safeCmd = { ...cmd, handler: safeFn };
        const names = [cmd.name, ...(cmd.alias || [])].map(s => String(s).toLowerCase());
        for (const n of names) { if (!commands.has(n)) commands.set(n, safeCmd); }
        const cat = cmd.category || 'misc';
        if (!categories.has(cat)) categories.set(cat, []);
        categories.get(cat).push(safeCmd);
        total++;
      }
    } catch (e) {
      console.error(chalk.red(`[CMD LOAD] Failed ${f}: ${e.message}`));
    }
  }
  totalCount = total;
  console.log(`[CMD] Loaded ${total} commands across ${categories.size} categories.`);
  return { total, categories: categories.size };
}

function getCommandsByCategory(cat) { return categories.get(cat) || []; }
function getCommand(name) { return commands.get(name.toLowerCase()); }
function getTotalCommands() { return totalCount; }
function getAllCategories() { return Array.from(categories.keys()); }

// ─── Fallback body extraction ───────────────────────────────────
function extractBodyFallback(message) {
  if (!message) return '';
  try {
    const type = Object.keys(message)[0];
    if (!type) return '';
    if (type === 'conversation') return message.conversation || '';
    if (type === 'extendedTextMessage') return message.extendedTextMessage?.text || '';
    if (type === 'imageMessage') return message.imageMessage?.caption || '';
    if (type === 'videoMessage') return message.videoMessage?.caption || '';
    if (type === 'buttonsResponseMessage') return message.buttonsResponseMessage?.selectedButtonId || '';
    if (type === 'listResponseMessage') return message.listResponseMessage?.singleSelectReply?.selectedRowId || '';
    if (type === 'ephemeralMessage' && message.ephemeralMessage?.message) {
      const inner = message.ephemeralMessage.message;
      const innerType = Object.keys(inner)[0];
      if (innerType === 'conversation') return inner.conversation || '';
      if (innerType === 'extendedTextMessage') return inner.extendedTextMessage?.text || '';
      if (innerType === 'imageMessage') return inner.imageMessage?.caption || '';
      if (innerType === 'videoMessage') return inner.videoMessage?.caption || '';
    }
    if (type === 'viewOnceMessage' && message.viewOnceMessage?.message) {
      const inner = message.viewOnceMessage.message;
      const innerType = Object.keys(inner)[0];
      if (innerType === 'conversation') return inner.conversation || '';
      if (innerType === 'extendedTextMessage') return inner.extendedTextMessage?.text || '';
    }
  } catch (e) {}
  return '';
}

// ─── Build Context ──────────────────────────────────────────────
async function buildContext(sock, m) {
  if (!m || !m.message || !m.key) return null;
  const jid = m.key.remoteJid;
  if (!jid) return null;

  const sender = m.key.participant || m.key.remoteJid || '';
  const senderNumber = sender.split('@')[0].split(':')[0];
  const isGroup = jid.endsWith('@g.us');

  let groupMetadata = null, groupAdmins = [];
  if (isGroup) {
    try { groupMetadata = await sock.groupMetadata(jid); groupAdmins = utils.getGroupAdmins(groupMetadata.participants); } catch {}
  }

  const isOwner = ownerMod.isOwner(sender) || (sender === config.BOT_OWNER_JID) || (senderNumber === config.BOT_OWNER_NUM);
  const isAdmin = isOwner || store.isAdmin(sender);
  const isPremiumUser = store.isPremium(sender);
  const isBotAdmin = isGroup && groupAdmins.some(a => a === sock.user?.id || a.includes(sock.user?.id?.split(':')[0] || ''));
  const isBanned = store.isBanned(sender);
  const pushname = m.pushName || senderNumber;

  // Body extraction (3-tier)
  let body = '';
  try { body = normalizer.extractBody(m.message) || ''; } catch (e) {}
  if (!body) body = extractBodyFallback(m.message);
  if (!body && m.message) {
    try {
      const raw = JSON.stringify(m.message);
      const match = raw.match(/[.\/]([a-z]+)/i);
      if (match) body = match[0];
    } catch {}
  }

  // Prefix detection: ONLY . and /
  let prefix = null;
  let isCmd = false;
  if (body.startsWith('.') && body.length > 1) { prefix = '.'; isCmd = true; }
  else if (body.startsWith('/') && body.length > 1) { prefix = '/'; isCmd = true; }

  let command = '', args = [], text = '', q = '';
  if (isCmd) {
    const withoutPrefix = body.slice(prefix.length).trim();
    const parts = withoutPrefix.split(/\s+/).filter(Boolean);
    command = (parts[0] || '').toLowerCase();
    args = parts.slice(1);
    text = args.join(' ');
    q = text;
  }

  // Quoted message
  let quoted = null;
  try {
    const realType = normalizer.getRealContentType(m.message);
    const ctxInfo = realType ? m.message[realType]?.contextInfo : m.message?.extendedTextMessage?.contextInfo;
    if (ctxInfo?.quotedMessage) {
      const qMsg = ctxInfo.quotedMessage;
      quoted = {
        text: normalizer.extractBody(qMsg) || extractBodyFallback(qMsg) || '',
        type: normalizer.getRealContentType(qMsg) || Object.keys(qMsg)[0],
        sender: ctxInfo.participant || '',
        key: { remoteJid: jid, fromMe: (ctxInfo.participant === sock.user?.id), id: ctxInfo.stanzaId || '' }
      };
      if (quoted.text) q = quoted.text;
    }
  } catch {}

  // Reply helpers (VERIFIED WhatsApp badge)
  const reply = async (txt, opts = {}) => {
    if (typeof txt !== 'string') txt = String(txt ?? '');
    return verified.sendVerified(sock, jid, { text: txt, mentions: utils.parseMention(txt), ...opts }, { quoted: m });
  };
  const replyImg = async (url, caption = '', opts = {}) => verified.sendVerified(sock, jid, { image: { url }, caption, ...opts }, { quoted: m });
  const replyAudio = async (url, opts = {}) => verified.sendVerified(sock, jid, { audio: { url }, mimetype: 'audio/mpeg', ...opts }, { quoted: m });
  const replySticker = async (buffer, opts = {}) => sock.sendMessage(jid, { sticker: buffer, ...opts }, { quoted: m });
  const react = async (emoji) => { try { await sock.sendMessage(jid, { react: { text: emoji || '✅', key: m.key } }); } catch {} };

  const downloadQuoted = async () => {
    if (!quoted) return null;
    try { return await utils.downloadMediaMessage({ message: { [quoted.type]: { ...quoted } } }, sock); } catch { return null; }
  };
  const downloadMsg = async () => { try { return await utils.downloadMediaMessage(m, sock); } catch { return null; } };

  return {
    sock, m, jid, from: jid, sender, senderNumber, isGroup,
    isOwner, isAdmin, isPremium: isPremiumUser, isBotAdmin, isBanned,
    reply, replyImg, replyAudio, replySticker, react,
    args, q, text, command, prefix, body, quoted, pushname,
    downloadQuoted, downloadMsg, groupMetadata, groupAdmins,
    store, lib: utils, menu, config,
    antiSystem, messageStore, verified
  };
}

// ─── ON MESSAGE — NEVER SILENT ──────────────────────────────────
async function onMessage(sock, m) {
  if (!m || !m.message) return;

  try {
    watchdog.trackMessage();
    try { messageStore.storeMessage(m.key.remoteJid, m.key, m.message); } catch {}

    const ctx = await buildContext(sock, m).catch(e => {
      console.error(chalk.red(`[CTX] Failed: ${e.message}`));
      return null;
    });
    if (!ctx) return;

    if (m.key.remoteJid === 'status@broadcast') return;

    // Log every message
    console.log(chalk.gray(`[MSG] jid=${ctx.jid} sender=${ctx.senderNumber} body="${ctx.body.slice(0, 50)}" isCmd=${ctx.isCmd}`));

    if (!ctx.isCmd) return; // Not a command → ignore (don't reply to normal messages)

    // ═══ PRIVATE MODE CHECK ═══
    if (privateMode && !ctx.isOwner) {
      return ctx.reply(`━━━━━━━━━━━━━━
🔒 𝐏𝐑𝐈𝐕𝐀𝐓𝐄 𝐌𝐎𝐃𝐄
━━━━━━━━━━━━━━

Go take permission from your father before using this bot, kid.

Only Owner Commands Enabled.

Owner:
${config.BOT_OWNER}

━━━━━━━━━━━━━━`);
    }

    // ═══ BAN CHECK ═══
    if (ctx.isBanned) {
      return ctx.reply('❌ You are banned from using this bot.');
    }

    // ═══ EMPTY PREFIX CHECK (e.g. user sent just "." or "/") ═══
    if (!ctx.command || ctx.command === '') {
      return ctx.reply(`━━━━━━━━━━━━━━
📝 𝐓𝐲𝐩𝐞 𝐚 𝐜𝐨𝐦𝐦𝐚𝐧𝐝
━━━━━━━━━━━━━━

Examples:
${ctx.prefix}menu
${ctx.prefix}ping

━━━━━━━━━━━━━━

${config.BOT_FOOTER}`);
    }

    // ═══ INCREMENT COMMAND COUNT ═══
    try {
      const sockUserJid = sock.user?.id?.split(':')[0] + '@s.whatsapp.net';
      store.incCommandCount(sockUserJid);
    } catch {}

    // ═══ FIND COMMAND ═══
    const cmd = getCommand(ctx.command);

    if (!cmd) {
      // ═══ UNKNOWN COMMAND → SUGGEST CLOSEST ═══
      const suggestions = suggestCommands(ctx.command);
      let suggestionText = '';
      if (suggestions.length > 0) {
        suggestionText = '\nClosest Commands:\n';
        for (const s of suggestions) {
          suggestionText += `• ${ctx.prefix}${s}\n`;
        }
      }

      console.log(chalk.yellow(`[CMD] Unknown: ${ctx.command} | Suggestions: ${suggestions.join(', ')}`));

      return ctx.reply(`━━━━━━━━━━━━━━
❌ 𝐔𝐧𝐤𝐧𝐨𝐰𝐧 𝐂𝐨𝐦𝐦𝐚𝐧𝐝
━━━━━━━━━━━━━━

You typed:
${ctx.prefix}${ctx.command}

Try:
${ctx.prefix}menu
${ctx.prefix}help${suggestionText}
━━━━━━━━━━━━━━

${config.BOT_FOOTER}`);
    }

    // ═══ OWNER-ONLY CHECK ═══
    if (cmd.category === 'owner' && !ctx.isOwner) {
      return ctx.reply('❌ Owner only command');
    }

    // ═══ WRONG USAGE CHECK (command requires args but none given) ═══
    if (REQUIRES_ARGS.includes(ctx.command) && ctx.args.length === 0 && !ctx.quoted) {
      const usage = cmd.use || `${ctx.prefix}${ctx.command} <input>`;
      const example = cmd.example || `${ctx.prefix}${ctx.command} hello`;
      const desc = cmd.desc || 'See menu for details';

      return ctx.reply(`━━━━━━━━━━━━━━
⚠️ 𝐈𝐧𝐜𝐨𝐫𝐫𝐞𝐜𝐭 𝐔𝐬𝐚𝐠𝐞
━━━━━━━━━━━━━━

Correct:
${usage}

Example:
${example}

${desc}

━━━━━━━━━━━━━━

${config.BOT_FOOTER}`);
    }

    // ═══ EXECUTE COMMAND ═══
    console.log(chalk.green(`[CMD] Executing: ${ctx.command}`));
    await cmd.handler(ctx);
    console.log(chalk.green(`[CMD] Done: ${ctx.command}`));

  } catch (e) {
    console.error(chalk.red(`[CMD FAIL] ${e.message}`));
    console.error(chalk.red(e.stack));
    try {
      await sock.sendMessage(m.key?.remoteJid, { text: '⚠️ Error: ' + e.message.slice(0, 100) });
    } catch {}
  }
}

async function onMessagesUpdate(sock, updates) {
  try { await antiSystem.handleMessagesUpdate(sock, updates); } catch (e) {}
}

async function onGroupUpdate(sock, ev) {}

// ─── Private mode control (for owner commands) ──────────────────
function setPrivateMode(enabled) { privateMode = !!enabled; }
function getPrivateMode() { return privateMode; }

module.exports = {
  loadCommands, getCommandsByCategory, getCommand, getTotalCommands, getAllCategories,
  buildContext, onMessage, onGroupUpdate, onMessagesUpdate,
  setPrivateMode, getPrivateMode, suggestCommands
};
