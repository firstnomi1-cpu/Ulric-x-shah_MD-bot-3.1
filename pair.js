/**
 * Ulric-X MD V11 - WhatsApp Multi-User Connection Manager
 *
 * Connection system PRESERVED (same config as working reference).
 *
 * FIXES:
 * 1. registered=true detection in creds.update → mark linked + assign owner
 * 2. Connected SMS fires on connection.open with retry (3s, 5s)
 * 3. 515 handling: retry with same session (max 5, 10s delay)
 * 4. Pairing lock: ignore close events during 5-min window
 * 5. All handlers attached to retry sockets
 */
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const chalk = require('chalk');
const baileys = require('@whiskeysockets/baileys');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = baileys;

const config = require('./config');
const store  = require('./lib/store');
const status = require('./lib/status');
const session = require('./lib/session');
const owner   = require('./lib/owner');

const connections = new Map();
const pendingPairs = new Map();
const heartbeats = new Map();
const connectedMsgSent = new Set(); // Track which users already received connected SMS

/**
 * Send CONNECTED message with retry logic.
 * Attempt 1 → wait 3s → Attempt 2 → wait 5s → give up
 */
async function sendConnectedMessage(jid, sock, attempt = 1) {
  if (connectedMsgSent.has(jid)) return; // Already sent
  const verified = require('./lib/verifiedReply');
  const handler = require('./handler');

  try {
    // Attempt to send image + connected text
    await verified.sendVerified(sock, jid, {
      image: { url: config.BOT_LOGO },
      caption: config.BOT_CONNECTED_MSG || '✅ Bot Connected',
      contextInfo: verified.verifiedContext()
    });
    connectedMsgSent.add(jid);
    session.logEvent('CONNECTED_MSG_SENT', jid, { attempt });
    console.log(chalk.green(`[CONNECTED] ✅ Message sent to ${jid} (attempt ${attempt})`));

    // Wait 1.5s then send welcome
    await new Promise(r => setTimeout(r, 1500));
    try {
      await verified.sendVerified(sock, jid, {
        text: `👋 Welcome to ${config.BOT_NAME}!\n\nType .menu to see all ${handler.getTotalCommands()} commands.\nType .allmenu for the full list.\n\n> ${config.BOT_FOOTER}`
      });
      session.logEvent('WELCOME_MSG_SENT', jid);
    } catch {}

  } catch (e) {
    console.error(chalk.red(`[CONNECTED] Attempt ${attempt} failed for ${jid}: ${e.message}`));
    session.logEvent('CONNECTED_MSG_FAILED', jid, { attempt, error: e.message });

    if (attempt < 3) {
      const delay = attempt === 1 ? 3000 : 5000;
      setTimeout(() => sendConnectedMessage(jid, sock, attempt + 1), delay);
    } else {
      // Final fallback: plain text
      try {
        await sock.sendMessage(jid, { text: config.BOT_CONNECTED_MSG || '✅ Bot Connected' });
        connectedMsgSent.add(jid);
        session.logEvent('CONNECTED_MSG_SENT_FALLBACK', jid);
        console.log(chalk.yellow(`[CONNECTED] Fallback text sent to ${jid}`));
      } catch (e2) {
        console.error(chalk.red(`[CONNECTED] All attempts failed for ${jid}: ${e2.message}`));
      }
    }
  }
}

/**
 * Attach ALL event handlers to a socket.
 * Used for both initial socket and 515 retry sockets.
 */
function attachHandlers(sock, jid, sessionPath, opts = {}) {
  const handler = require('./handler');
  const { state, saveCreds } = opts;

  let everConnected = opts.everConnected || false;
  let pairCode = opts.pairCode || null;
  let pairingLock = opts.pairingLock || false;
  let retry515Count = opts.retry515Count || 0;
  let registered = opts.registered || false;

  // creds.update
  if (saveCreds) {
    sock.ev.on('creds.update', () => {
      try { saveCreds(); } catch (e) {}
      const saveCount = (sock._saveCount || 0) + 1;
      sock._saveCount = saveCount;
      if (saveCount <= 3) {
        session.logEvent('CREDS_UPDATED', jid, {
          saveCount,
          registered: state?.creds?.registered || false,
          hasMe: !!(state?.creds?.me)
        });
      }
      // Detect registration
      const wasRegistered = registered;
      if (state?.creds?.registered) {
        registered = true;
      }
      if (!wasRegistered && registered) {
        session.logEvent('REGISTERED', jid, { saveCount });
        console.log(chalk.green(`[PAIR] 📋 Device REGISTERED for ${jid}`));

        // Mark linked + assign owner + save user (but DON'T send connected msg yet)
        session.markLinked(jid, { pairedVia: 'code' });
        session.logEvent('SESSION_LINKED', jid, { triggeredBy: 'registered' });

        const wasAssigned = owner.assignOwner(jid, { pairedVia: 'code' });
        if (wasAssigned) {
          session.logEvent('OWNER_ASSIGNED', jid, { number: jid.split('@')[0] });
        }

        store.addUser(jid, {
          pairedAt: Date.now(),
          country: getCountryFromNumber(jid.split('@')[0]),
          isOwner: owner.isOwner(jid)
        });
        status.setStatus(jid, 'connected');
      }
    });
  }

  // connection.update
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      everConnected = true;
      pairingLock = false;
      connections.set(jid, { sock, status: 'open', lastSeen: Date.now() });
      console.log(chalk.green(`[PAIR] ✅ CONNECTED: ${jid}`));
      status.setStatus(jid, 'connected');
      session.logEvent('CONNECTION_OPENED', jid);

      // Ensure linked + owner (may already be done in creds.update)
      session.markLinked(jid, { pairedVia: 'code' });
      session.resetFailCount(jid);
      if (owner.assignOwner(jid, { pairedVia: 'code' })) {
        session.logEvent('OWNER_ASSIGNED', jid, { number: jid.split('@')[0] });
      }
      store.addUser(jid, {
        pairedAt: Date.now(),
        country: getCountryFromNumber(jid.split('@')[0]),
        isOwner: owner.isOwner(jid)
      });

      // ═══════════════════════════════════════════════════════════════
      // CONNECTED SMS: Send now that socket is OPEN (ready to send).
      // Uses retry logic (attempt 1 → 3s → attempt 2 → 5s).
      // ═══════════════════════════════════════════════════════════════
      session.logEvent('CONNECTED_TRIGGERED', jid);
      sendConnectedMessage(jid, sock).catch(() => {});

      // Move from pending to permanent
      const pending = pendingPairs.get(jid);
      if (pending) {
        heartbeats.set(jid, pending.heartbeat);
        pendingPairs.delete(jid);
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(chalk.yellow(`[PAIR] Closed ${jid} (code=${statusCode})`));
      session.logEvent('CONNECTION_CLOSED', jid, { statusCode, everConnected });

      try { clearInterval(opts.heartbeat); } catch (e) {}
      const hb = heartbeats.get(jid);
      if (hb) { clearInterval(hb); heartbeats.delete(jid); }

      // Pairing lock: ignore close events during 5-min pairing window
      if (pairingLock && pairCode && !everConnected) {
        console.log(chalk.cyan(`[PAIR] Pairing lock active for ${jid}. Ignoring close (code ${statusCode}).`));

        // 515 retry: recreate socket with SAME creds (don't destroy session!)
        if (statusCode === 515 && retry515Count < 5) {
          retry515Count++;
          console.log(chalk.yellow(`[PAIR] 515 retry ${retry515Count}/5 for ${jid} in 10s...`));
          session.logEvent('RECONNECT_ATTEMPT_515', jid, { retry: retry515Count });

          setTimeout(async () => {
            try {
              try { sock.end(); } catch (e) {}
              const { state: ns, saveCreds: nsc } = await useMultiFileAuthState(sessionPath);
              const { version: nv } = await fetchLatestBaileysVersion();

              const newSock = makeWASocket({
                version: nv,
                logger: pino({ level: 'silent' }),
                auth: ns,
                printQRInTerminal: false,
                connectTimeoutMs: 30000,
                defaultQueryTimeoutMs: 30000,
                keepAliveIntervalMs: 30000,
              });

              const newHeartbeat = setInterval(() => {
                try {
                  if (newSock.ws && newSock.ws.readyState === 1) {
                    newSock.sendPresenceUpdate('available');
                  }
                } catch (e) {}
              }, 60000);

              // Attach ALL handlers to retry socket
              attachHandlers(newSock, jid, sessionPath, {
                state: ns,
                saveCreds: nsc,
                heartbeat: newHeartbeat,
                everConnected,
                pairCode,
                pairingLock,
                retry515Count,
                registered
              });

              console.log(chalk.green(`[PAIR] 515 retry socket created for ${jid}`));
            } catch (e) {
              console.error(chalk.red(`[PAIR] 515 retry failed: ${e.message}`));
            }
          }, 10000);
        }
        return; // Don't proceed to normal close handling
      }

      if (everConnected) {
        connections.set(jid, { sock, status: 'reconnecting', lastSeen: Date.now() });
        const result = session.recordReconnectFailure(jid, 3);
        if (result.deleted) {
          console.log(chalk.red(`[PAIR] Session destroyed after ${result.failCount} failures: ${jid}`));
          connections.delete(jid);
        } else {
          setTimeout(() => startConnection(jid).catch(e => console.error(e.message)), 5000);
        }
      } else if (!pairCode) {
        status.setStatus(jid, 'failed', { error: `Connection closed (code ${statusCode})` });
        pendingPairs.delete(jid);
        const validation = session.validateSession(jid);
        if (!validation.valid) {
          session.destroySession(jid);
        }
      }
    }
  });

  // messages.upsert — THE CRITICAL HANDLER for commands
  sock.ev.on('messages.upsert', async ({ messages }) => {
    try {
      await handler.onMessage(sock, messages[0]);
    } catch (e) {
      console.error(chalk.red(`[MSG] Error: ${e.message}`));
    }
  });

  // messages.update — for anti-delete/anti-edit
  sock.ev.on('messages.update', async (updates) => {
    try {
      await handler.onMessagesUpdate(sock, updates);
    } catch (e) {}
  });

  // group-participants.update
  sock.ev.on('group-participants.update', async (ev) => {
    try {
      await handler.onGroupUpdate(sock, ev);
    } catch (e) {}
  });

  return { everConnected, pairCode, pairingLock, retry515Count, registered };
}

/**
 * Generate pair code for a phone number.
 * Connection config is EXACTLY same as working reference.
 */
async function generatePairCode(phoneNumber) {
  const clean = String(phoneNumber).replace(/\D/g, '');

  if (clean.length < 7 || clean.length > 15) {
    throw new Error('Invalid phone number length (need 7-15 digits)');
  }
  if (clean.startsWith('0')) {
    throw new Error('Remove leading 0, use country code (e.g. 923xxx)');
  }

  const jid = clean + '@s.whatsapp.net';
  const sessionPath = path.join(config.SESSIONS_DIR, jid);

  if (fs.existsSync(path.join(sessionPath, 'creds.json'))) {
    console.log(chalk.blue(`[PAIR] ${jid} already paired, reconnecting...`));
    status.setStatus(jid, 'connected');
    startConnection(jid).catch(e => console.error(e.message));
    throw new Error('Already paired. Reconnecting. Send .menu to your WhatsApp.');
  }

  if (status.isPairingInProgress(jid)) {
    const s = status.getStatus(jid);
    if (s.code) return { code: s.code, jid, expiresAt: s.expiresAt, existing: true };
    throw new Error('Pairing already in progress. Please wait.');
  }

  if (store.getUsers().length >= config.MAX_PAIR_USERS) {
    throw new Error('Pairing limit reached.');
  }

  status.setStatus(jid, 'connecting');
  session.logEvent('PAIR_REQUESTED', jid, { number: clean });

  try {
    fs.mkdirSync(sessionPath, { recursive: true });

    // ═══════════════════════════════════════════════════════════════
    // SAME config as working single-user reference (NO browser field)
    // ═══════════════════════════════════════════════════════════════
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      auth: state,
      printQRInTerminal: false,
      connectTimeoutMs: 30000,
      defaultQueryTimeoutMs: 30000,
      keepAliveIntervalMs: 30000,
    });

    const heartbeat = setInterval(() => {
      try {
        if (sock.ws && sock.ws.readyState === 1) {
          sock.sendPresenceUpdate('available');
        }
      } catch (e) {}
    }, 60000);

    // Attach ALL handlers
    let handlerState = attachHandlers(sock, jid, sessionPath, {
      state,
      saveCreds,
      heartbeat,
      everConnected: false,
      pairCode: null,
      pairingLock: false,
      retry515Count: 0,
      registered: false
    });

    // Wait 5 seconds (same as reference)
    await new Promise(r => setTimeout(r, 5000));

    if (state.creds.registered) {
      throw new Error('Already registered.');
    }

    status.setStatus(jid, 'requesting');

    // Request pair code
    const code = await sock.requestPairingCode(clean);
    const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
    handlerState.pairCode = formatted;
    handlerState.pairingLock = true;

    console.log(chalk.green(`\n========================================`));
    console.log(chalk.green(`   YOUR PAIRING CODE: ${formatted}`));
    console.log(chalk.green(`   For: ${clean}`));
    console.log(chalk.green(`========================================\n`));
    session.logEvent('PAIR_CODE_GENERATED', jid, { code: formatted });
    session.logEvent('PAIRING_LOCK_ACTIVATED', jid, { duration: '5min' });

    const expiresAt = Date.now() + 5 * 60 * 1000;
    status.setStatus(jid, 'code_generated', { code: formatted, expiresAt });

    pendingPairs.set(jid, { sock, heartbeat, expiresAt });

    // Auto cleanup after 5 min
    setTimeout(() => {
      if (pendingPairs.has(jid) && !connections.has(jid)) {
        try { clearInterval(heartbeat); } catch (e) {}
        try { sock.end(); } catch (e) {}
        pendingPairs.delete(jid);
        if (!store.isPaired(jid)) {
          status.setStatus(jid, 'expired');
          const validation = session.validateSession(jid);
          if (!validation.valid) {
            session.destroySession(jid);
          }
        }
      }
    }, 5 * 60 * 1000);

    return { code: formatted, rawCode: formatted.replace(/-/g, ''), jid, expiresAt };

  } catch (error) {
    console.error(chalk.red(`[PAIR] Error: ${error.message}`));
    status.setStatus(jid, 'failed', { error: error.message });
    throw error;
  }
}

/**
 * Start connection for already-paired user (on boot or reconnect).
 */
async function startConnection(jid) {
  const sessionPath = path.join(config.SESSIONS_DIR, jid);

  // Validate session
  const validation = session.validateSession(jid);
  if (!validation.valid) {
    console.log(chalk.red(`[CONN] Invalid session for ${jid}: ${validation.reason}`));
    session.destroySession(jid);
    session.logEvent('SESSION_REJECTED', jid, { reason: validation.reason });
    return null;
  }
  session.logEvent('SESSION_LOADED', jid, { reason: validation.reason });

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      auth: state,
      printQRInTerminal: false,
      connectTimeoutMs: 30000,
      defaultQueryTimeoutMs: 30000,
      keepAliveIntervalMs: 30000,
    });

    connections.set(jid, { sock, status: 'connecting', lastSeen: Date.now() });

    const heartbeat = setInterval(() => {
      try {
        if (sock.ws && sock.ws.readyState === 1) {
          sock.sendPresenceUpdate('available');
        }
      } catch (e) {}
    }, 60000);

    // Attach handlers (for reconnects, connected SMS already sent)
    attachHandlers(sock, jid, sessionPath, {
      state,
      saveCreds,
      heartbeat,
      everConnected: false,
      pairCode: null,
      pairingLock: false,
      retry515Count: 0,
      registered: state.creds?.registered || false
    });

    return sock;
  } catch (e) {
    console.error(chalk.red(`[CONN] Failed ${jid}: ${e.message}`));
    return null;
  }
}

function unpairUser(jid, deleteSessionFlag = true) {
  const conn = connections.get(jid);
  if (conn?.sock) { try { conn.sock.end(); } catch (e) {} }
  const pending = pendingPairs.get(jid);
  if (pending) { try { clearInterval(pending.heartbeat); } catch (e) {} try { pending.sock.end(); } catch (e) {} pendingPairs.delete(jid); }
  const hb = heartbeats.get(jid);
  if (hb) { clearInterval(hb); heartbeats.delete(jid); }

  connections.delete(jid);
  status.clearStatus(jid);
  store.removeUser(jid);
  connectedMsgSent.delete(jid);

  if (deleteSessionFlag) {
    session.destroySession(jid);
  }
  return true;
}

async function autoLoadAllPaired(onProgress) {
  const entries = fs.existsSync(config.SESSIONS_DIR)
    ? fs.readdirSync(config.SESSIONS_DIR, { withFileTypes: true })
    : [];
  const allDirs = entries
    .filter(d => d.isDirectory() && d.name.endsWith('@s.whatsapp.net'))
    .map(d => d.name);

  const validDirs = [];
  for (const jid of allDirs) {
    const v = session.validateSession(jid);
    if (v.valid) validDirs.push(jid);
    else session.destroySession(jid);
  }

  console.log(`[AUTOLOAD] ${validDirs.length} valid session(s)`);

  const ownerInfo = owner.getOwnerInfo();
  if (ownerInfo) {
    console.log(chalk.green(`[AUTOLOAD] Owner: ${ownerInfo.jid}`));
  }

  for (let i = 0; i < validDirs.length; i++) {
    const jid = validDirs[i];
    try {
      await startConnection(jid);
      if (onProgress) onProgress(i + 1, validDirs.length, jid);
      await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
      console.error(chalk.red(`[AUTOLOAD] Failed ${jid}: ${e.message}`));
    }
  }
}

async function broadcastAll(text) {
  const targets = [];
  for (const [jid, info] of connections.entries()) {
    if (info.status !== 'open') continue;
    try {
      await info.sock.sendMessage(jid, { text });
      targets.push(jid);
    } catch (e) {}
  }
  return targets;
}

async function broadcastOwnerGroups(text) {
  const ownerConn = connections.get(owner.getOwnerJid());
  if (!ownerConn || ownerConn.status !== 'open') return [];
  const targets = [];
  const groups = await ownerConn.sock.groupFetchAllWhitelist?.().catch(() => []) || [];
  for (const g of groups) {
    try { await ownerConn.sock.sendMessage(g.id, { text }); targets.push(g.id); } catch (e) {}
  }
  return targets;
}

function getCountryFromNumber(num) {
  const { getCountry } = require('./lib/utils');
  return getCountry(num);
}

function getConnection(jid) { return connections.get(jid); }
function getAllConnections() { return Array.from(connections.values()); }

function gracefulShutdown() {
  for (const [jid, info] of connections.entries()) {
    try { info.sock.end(); } catch (e) {}
  }
  for (const [jid, p] of pendingPairs.entries()) {
    try { clearInterval(p.heartbeat); } catch (e) {}
    try { p.sock.end(); } catch (e) {}
  }
  for (const [jid, hb] of heartbeats.entries()) {
    try { clearInterval(hb); } catch (e) {}
  }
}

process.on('SIGINT', () => { gracefulShutdown(); process.exit(0); });
process.on('SIGTERM', () => { gracefulShutdown(); process.exit(0); });

module.exports = {
  generatePairCode,
  startConnection,
  unpairUser,
  getConnection,
  getAllConnections,
  autoLoadAllPaired,
  broadcastAll,
  broadcastOwnerGroups
};
