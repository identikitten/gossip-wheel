// Spin the Gossip Wheel: one shared kiosk, many phones, one active turn at a time.
// Run locally: npm install && npm start
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);
app.use(express.static(path.join(__dirname, 'public')));

const SPIN_MS = 5000;
const TURN_TIMEOUT_MS = 45000; // A visitor must press Spin within 45 seconds.
const RECONNECT_GRACE_MS = 20000; // Brief Wi-Fi interruptions do not lose a turn.
// Set KIOSK_PASSWORD privately in Railway Variables. Never commit it to GitHub.
const KIOSK_PASSWORD = process.env.KIOSK_PASSWORD || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const TEST_PASSWORD = process.env.TEST_PASSWORD || '';
const DOCENT_PASSWORD = process.env.DOCENT_PASSWORD || '';
const docentFailures = new Map(); // per-visitor throttling, resets on server restart
const DOCENT_MAX_FAILURES = 5;
const DOCENT_LOCK_MS = 5 * 60 * 1000;
function securePasswordMatch(value, expectedValue) {
  if (!expectedValue || typeof value !== 'string') return false;
  const a = Buffer.from(value, 'utf8'), b = Buffer.from(expectedValue, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function validKioskPassword(value) {
  if (!KIOSK_PASSWORD || typeof value !== 'string') return false;
  const received = Buffer.from(value, 'utf8');
  const expected = Buffer.from(KIOSK_PASSWORD, 'utf8');
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}
const prizes = [
  {
    "id": "gossip",
    "label": "Random gossip",
    "weight": 8.5
  },
  {
    "id": "free",
    "label": "Free spin",
    "weight": 10
  },
  {
    "id": "balloon",
    "label": "Murmurs and Whispers",
    "weight": 13
  },
  {
    "id": "judgement",
    "label": "Oops",
    "weight": 9
  },
  {
    "id": "ohno",
    "label": "Oh no",
    "weight": 7
  },
  {
    "id": "notification",
    "label": "Talking heads",
    "weight": 10
  },
  {
    "id": "jackpot",
    "label": "Jackpot",
    "weight": 0.1
  },
  {
    "id": "lore",
    "label": "Gossip lore",
    "weight": 7.935
  },
  {
    "id": "gossip2",
    "label": "Random gossip",
    "weight": 8.5
  },
  {
    "id": "questions",
    "label": "???",
    "weight": 8
  },
  {
    "id": "refund",
    "label": "Get your money back",
    "weight": 1
  },
  {
    "id": "sacrifice",
    "label": "Sacrificial lamb",
    "weight": 16.965
  }
];

// Test mode: serve each prize in wheel order, then start again.
// Production mode keeps the weighted probabilities above unchanged.
const SEQUENTIAL_TEST = process.env.SEQUENTIAL_TEST === '1';
let nextTestPrize = 0;

const content = JSON.parse(fs.readFileSync(path.join(__dirname, 'content.json'), 'utf8'));
// Railway: set DATA_DIR=/data and mount a persistent volume at /data.
// Locally, files continue to be saved in the project directory.
const dataDir = process.env.DATA_DIR || __dirname;
fs.mkdirSync(dataDir, { recursive: true });
const submissionFile = path.join(dataDir, 'submissions.jsonl');
const moderationFile = path.join(dataDir, 'moderation.json');
const firstJackpotFile = path.join(dataDir, 'first-jackpot.json');
const answerFile = path.join(dataDir, 'answers.jsonl'); // ??? responses are not gossip

// One physical wheel. Phone sessions are indexed by unguessable tokens.
const sessions = new Map();
const queue = [];
let activeToken = null;
let kioskSocket = null;
let spinTimer = null;
let turnTimer = null;
let currentSpin = null;

function randomItem(items, fallback) {
  return Array.isArray(items) && items.length
    ? items[crypto.randomInt(items.length)] : fallback;
}

function firstJackpot() {
  try {
    const data = JSON.parse(fs.readFileSync(firstJackpotFile, 'utf8'));
    return data && typeof data.text === 'string' && data.text.trim() && data.date === todayKey() ? data : null;
  } catch (_) { return null; }
}
function specialJackpotAvailable() {
  return !!firstJackpot() && !persistent.jackpotDecisions[todayKey()];
}
function pickPrize() {
  if (SEQUENTIAL_TEST) {
    const prize = prizes[nextTestPrize % prizes.length];
    nextTestPrize += 1;
    return prize;
  }
  // Jackpot is available only with five approved submissions from yesterday,
  // and cannot be awarded again on the same exhibition-local day.
  const jackpotReady = (specialJackpotAvailable() || yesterdaysGossip().length >= 5) &&
    !persistent.jackpotDecisions[todayKey()];
  const eligiblePrizes = prizes.filter(prize => prize.id !== 'jackpot' || jackpotReady);
  let roll = crypto.randomInt(1000000000) / 1000000000 *
    eligiblePrizes.reduce((sum, prize) => sum + prize.weight, 0);
  for (const prize of eligiblePrizes) {
    roll -= prize.weight;
    if (roll < 0) return prize;
  }
  return eligiblePrizes[eligiblePrizes.length - 1];
}

function messageFor(prize, session) {
  switch (prize.id) {
    case 'gossip':
    case 'gossip2': return randomItem([...content.gossipPool, ...releasedGossip, ...approvedVisitorGossip()], 'There is no approved gossip to share yet.');
    case 'free': return 'You won another free spin.';
    case 'balloon': return 'Can you hear the faint rumors?';
    case 'judgement': return 'A friend overheard you gossiping about them. You’ve lost a little bit of their trust, sorry.';
    case 'ohno': return 'A piece of gossip involving you reached you and it feels like your actions were taken out of context. You feel deflated and upset. Sorry.';
    case 'notification': return 'Your turn to feed the belly of the beast! Please leave a piece of gossip here (what have you heard lately at work, school, your neighborhood? Who’s doing what to whom? Or who’s doing what to you?)\nThis gossip will now circulate in the wheel’s gossip pool.';
    case 'sacrifice': return 'It’s your turn to be the subject of gossip now. Recall a time when you’ve been the subject of gossip, what did people say about you?';
    case 'jackpot': return '.݁₊ ⊹ . ݁JACKPOT! . ⊹ ₊\nYou’ve won access to all the gossip submitted yesterday. You also have the power to either release it to the gossip pool for others to read, or keep it to yourself.';
    case 'lore': return randomItem(content.gossipLore, 'More gossip lore coming soon.');
    case 'questions': return randomItem(content.questions, 'What place does gossip have in your life?');
    case 'refund': return 'You get your money back! It’s as if you were never here.\nShow this to a docent to get your human dollar back.';
  }
}

// Today's gossip is a snapshot of submissions, excluding ??? answers.
// Submissions remain unapproved until an organizer reviews them.
const stateFile = path.join(dataDir, 'prize-state.json');
let persistent = { releasedGossip: [], jackpotDecisions: {} };
try { persistent = { ...persistent, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; } catch (_) {}
const releasedGossip = persistent.releasedGossip;
let moderation = {};
try { moderation = JSON.parse(fs.readFileSync(moderationFile, 'utf8')); } catch (_) {}
function saveModeration() {
  const temp = moderationFile + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(moderation, null, 2), { mode: 0o600 });
  fs.renameSync(temp, moderationFile);
}
function submissions() {
  if (!fs.existsSync(submissionFile)) return [];
  return fs.readFileSync(submissionFile, 'utf8').split('\n').filter(Boolean)
    .flatMap(line => { try { return [JSON.parse(line)]; } catch (_) { return []; } });
}
function decisionFor(entry) { return moderation[entry.id] || (entry.approved ? 'approved' : 'pending'); }
function keptJackpotIds() {
  const ids = new Set();
  for (const decision of Object.values(persistent.jackpotDecisions || {})) {
    if (decision.status === 'keep') for (const item of decision.items || []) ids.add(item.id);
  }
  return ids;
}
function approvedVisitorGossip() {
  const kept = keptJackpotIds();
  return submissions().filter(entry =>
    ['sacrifice','notification'].includes(entry.kind) &&
    decisionFor(entry) === 'approved' && !kept.has(entry.id) &&
    // Yesterday's Jackpot collection is withheld until its winner releases it.
    !Object.values(persistent.jackpotDecisions || {}).some(d =>
      d.status !== 'release' && (d.items || []).some(item => item.id === entry.id))
  ).map(entry => entry.text);
}
function saveState() {
  const tmp = stateFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(persistent, null, 2));
  fs.renameSync(tmp, stateFile);
}
function todayKey() { return new Date().toLocaleDateString('en-CA'); }
function yesterdayKey() { const d = new Date(); d.setDate(d.getDate() - 1); return d.toLocaleDateString('en-CA'); }
function yesterdaysGossip() {
  if (!fs.existsSync(submissionFile)) return [];
  return fs.readFileSync(submissionFile, 'utf8').split('\n').filter(Boolean)
    .flatMap(line => { try { return [JSON.parse(line)]; } catch (_) { return []; } })
    .filter(entry => entry.submittedAt && new Date(entry.submittedAt).toLocaleDateString('en-CA') === yesterdayKey()
      && ['sacrifice', 'notification'].includes(entry.kind)
      && decisionFor(entry) === 'approved')
    .map(entry => ({ id: entry.id || crypto.createHash('sha256').update(entry.submittedAt + entry.text).digest('hex'), text: entry.text }));
}

function send(session, event, data) {
  if (session.socketId) io.to(session.socketId).emit(event, data);
}

function snapshot(session) {
  return {
    phase: session.phase,
    credits: session.credits,
    result: session.result,
    pendingSubmission: session.pendingSubmission,
    submitted: session.submitted,
    pendingKinds: session.pendingKinds,
    jackpot: session.jackpot,
    position: session.phase === 'waiting' ? queue.indexOf(session.token) + 1 : 0
  };
}

function updateQueue() {
  queue.forEach((token, index) => {
    const session = sessions.get(token);
    if (session) send(session, 'queue-update', { position: index + 1, waiting: queue.length });
  });
  if (kioskSocket) io.to(kioskSocket).emit('queue-status', {
    waiting: queue.length,
    busy: activeToken !== null
  });
}

function clearTurnTimer() {
  if (turnTimer) clearTimeout(turnTimer);
  turnTimer = null;
}

function scheduleTurnTimeout(session) {
  clearTurnTimer();
  turnTimer = setTimeout(() => {
    if (activeToken === session.token && session.phase === 'active' && !currentSpin) {
      endTurn(session, 'Your turn timed out before spinning.');
    }
  }, TURN_TIMEOUT_MS);
}

function activateNext() {
  if (activeToken || currentSpin || testSpinInProgress || !kioskSocket) return;
  while (queue.length) {
    const token = queue.shift();
    const session = sessions.get(token);
    if (!session || session.phase !== 'waiting') continue;
    activeToken = token;
    session.phase = 'active';
    session.credits = 1;
    send(session, 'session-state', snapshot(session));
    scheduleTurnTimeout(session);
    if (kioskSocket) io.to(kioskSocket).emit('visitor-connected');
    break;
  }
  updateQueue();
}

function endTurn(session, notice = '') {
  if (activeToken !== session.token) return;
  clearTurnTimer();
  activeToken = null;
  session.credits = 0;
  session.phase = 'finished';
  send(session, 'session-state', { ...snapshot(session), notice });
  if (kioskSocket) io.to(kioskSocket).emit('visitor-disconnected');
  activateNext();
}

let testSpinInProgress = false;
function authorized(socket, role) { return socket.data.role === role; }
io.on('connection', (socket) => {
  socket.on('admin-login', ({ password } = {}, reply = () => {}) => {
    if (!securePasswordMatch(password, ADMIN_PASSWORD)) return reply({ ok: false, error: 'Incorrect admin password.' });
    if (socket.data.role && socket.data.role !== 'admin') return reply({ ok: false, error: 'Already registered as another role.' });
    socket.data.role = 'admin';
    reply({ ok: true });
  });
  socket.on('admin-special-jackpot', ({ text, date } = {}, reply = () => {}) => {
    if (!authorized(socket, 'admin')) return reply({ ok: false, error: 'Unauthorized.' });
    if (typeof text !== 'string' || !text.trim() || text.length > 30000 ||
        typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date))
      return reply({ ok: false, error: 'Enter a story and a valid date.' });
    if (persistent.jackpotDecisions[date])
      return reply({ ok: false, error: 'A Jackpot has already been awarded or reserved for that date.' });
    try {
      const tmp = firstJackpotFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ text: text.trim(), date }), { mode: 0o600 });
      fs.renameSync(tmp, firstJackpotFile);
      reply({ ok: true });
    } catch (error) { console.error(error); reply({ ok: false, error: 'Could not save story.' }); }
  });
  socket.on('admin-list', (_payload = {}, reply = () => {}) => {
    if (!authorized(socket, 'admin')) return reply({ ok: false, error: 'Unauthorized.' });
    reply({ ok: true, submissions: submissions().map(entry => ({
      id: entry.id, submittedAt: entry.submittedAt, kind: entry.kind,
      text: entry.text, status: decisionFor(entry),
      withheldByJackpot: keptJackpotIds().has(entry.id) ||
        Object.values(persistent.jackpotDecisions || {}).some(d => d.status !== 'release' && (d.items || []).some(i => i.id === entry.id))
    })).reverse(), answers: fs.existsSync(answerFile)
      ? fs.readFileSync(answerFile,'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch (_) { return []; } }).reverse()
      : [] });
  });
  socket.on('admin-review', ({ id, status } = {}, reply = () => {}) => {
    if (!authorized(socket, 'admin')) return reply({ ok: false, error: 'Unauthorized.' });
    if (!['approved', 'rejected'].includes(status)) return reply({ ok: false, error: 'Invalid decision.' });
    if (!submissions().some(entry => entry.id === id)) return reply({ ok: false, error: 'Submission not found.' });
    try {
      moderation[id] = status;
      saveModeration();
      reply({ ok: true });
    } catch (error) {
      console.error(error);
      reply({ ok: false, error: 'Could not save moderation decision.' });
    }
  });
  socket.on('test-login', ({ password } = {}, reply = () => {}) => {
    if (!securePasswordMatch(password, TEST_PASSWORD)) return reply({ ok: false, error: 'Incorrect test password.' });
    if (socket.data.role && socket.data.role !== 'tester') return reply({ ok: false, error: 'Already registered as another role.' });
    socket.data.role = 'tester';
    reply({ ok: true });
  });
  socket.on('test-spin', ({ prizeId } = {}, reply = () => {}) => {
    if (!authorized(socket, 'tester')) return reply({ ok: false, error: 'Unauthorized.' });
    const prize = prizes.find(p => p.id === prizeId);
    if (!prize) return reply({ ok: false, error: 'Unknown prize.' });
    if (!kioskSocket) return reply({ ok: false, error: 'Exhibition wheel is not connected.' });
    if (currentSpin || testSpinInProgress)
      return reply({ ok: false, error: 'A spin is already in progress. Try again in a moment.' });
    testSpinInProgress = true;
    const id = crypto.randomUUID();
    reply({ ok: true });
    io.to(kioskSocket).emit('spin-started', { id, prizeId: prize.id });
    setTimeout(() => {
      io.to(kioskSocket).emit('spin-finished', { id, label: prize.label });
      socket.emit('test-result', { prizeId: prize.id, label: prize.label,
        message: prize.id === 'jackpot'
          ? messageFor(prize, {})
          : ['notification','sacrifice','questions'].includes(prize.id)
            ? 'Simulation only — no submission form or information is saved.'
            : prize.id === 'gossip' || prize.id === 'gossip2'
              ? 'Random gossip (simulation)'
              : messageFor(prize, {}) });
      testSpinInProgress = false;
      activateNext();
    }, SPIN_MS);
  });
  socket.on('register-kiosk', ({ password } = {}, reply = () => {}) => {
    // Only the authorized exhibition computer may become the kiosk.
    if (!validKioskPassword(password)) {
      return reply({ ok: false, error: 'Incorrect password or KIOSK_PASSWORD is not configured.' });
    }
    if (socket.data.role && socket.data.role !== 'kiosk') {
      return reply({ ok: false, error: 'This connection is already a visitor.' });
    }
    // Never allow a second browser to displace a connected exhibition wheel.
    if (kioskSocket && kioskSocket !== socket.id && io.sockets.sockets.has(kioskSocket)) {
      return reply({ ok: false, error: 'The exhibition wheel is already connected.' });
    }
    kioskSocket = socket.id;
    socket.data.role = 'kiosk';
    reply({ ok: true });
    socket.emit('kiosk-ready');
    updateQueue();
    activateNext();
  });

  socket.on('join-queue', ({ token } = {}, reply = () => {}) => {
    if (socket.data.role) return reply({ ok: false, error: 'Already connected.' });
    let session = typeof token === 'string' ? sessions.get(token) : null;
    if (!session) {
      token = crypto.randomBytes(24).toString('hex');
      session = {
        token, socketId: null, phase: 'waiting', credits: 0,
        result: null, pendingSubmission: false, submitted: false,
        pendingKinds: [], jackpot: null,
        disconnectTimer: null
      };
      sessions.set(token, session);
      queue.push(token);
    }
    if (session.disconnectTimer) clearTimeout(session.disconnectTimer);
    session.disconnectTimer = null;
    // A new connection for the same token supersedes the previous socket.
    if (session.socketId && session.socketId !== socket.id) {
      io.to(session.socketId).emit('session-replaced');
      const oldSocket = io.sockets.sockets.get(session.socketId);
      if (oldSocket) oldSocket.data.token = null;
    }
    session.socketId = socket.id;
    socket.data.role = 'phone';
    socket.data.token = token;
    reply({ ok: true, token, state: snapshot(session) });
    updateQueue();
    activateNext();
  });

  // Local testing: allow a finished visitor to rejoin without a new browser.
  // Disabled by default in production: set ALLOW_TEST_REPLAY=1 locally.
  socket.on('test-play-again', (_payload = {}, reply = () => {}) => {
    if (process.env.ALLOW_TEST_REPLAY !== '1' && !SEQUENTIAL_TEST)
      return reply({ ok: false, error: 'Test replay is disabled.' });
    const session = sessions.get(socket.data.token);
    if (!session || session.socketId !== socket.id || session.phase !== 'finished')
      return reply({ ok: false, error: 'Finish your current turn first.' });
    session.phase = 'waiting';
    session.credits = 0;
    session.result = null;
    // Keep pending submissions and jackpot choices available after a test replay.
    queue.push(session.token);
    reply({ ok: true });
    send(session, 'session-state', snapshot(session));
    updateQueue();
    activateNext();
  });

  // A docent enters a shared code on a finished visitor's phone after payment.
  // This code is reusable by staff; each successful redemption grants only one
  // return to the END of the queue. Never send the code back to the browser.
  socket.on('redeem-docent-code', ({ code } = {}, reply = () => {}) => {
    const session = sessions.get(socket.data.token);
    if (!session || session.socketId !== socket.id || session.phase !== 'finished')
      return reply({ ok: false, error: 'Finish your current turn first.' });
    if (session.pendingKinds.length || (session.jackpot && !session.jackpot.choice))
      return reply({ ok: false, error: 'Please complete your prize before playing again.' });
    const attempts = docentFailures.get(session.token) || { count: 0, until: 0 };
    if (attempts.until > Date.now())
      return reply({ ok: false, error: 'Too many attempts. Please ask the docent to try again in a few minutes.' });
    if (!securePasswordMatch(code, DOCENT_PASSWORD)) {
      attempts.count += 1;
      if (attempts.count >= DOCENT_MAX_FAILURES) {
        attempts.until = Date.now() + DOCENT_LOCK_MS;
        attempts.count = 0;
      }
      docentFailures.set(session.token, attempts);
      return reply({ ok: false, error: 'Incorrect code.' });
    }
    docentFailures.delete(session.token);
    session.phase = 'waiting';
    session.credits = 0;
    session.result = null;
    session.pendingSubmission = false;
    session.submitted = false;
    session.pendingKinds = [];
    session.jackpot = null;
    queue.push(session.token);
    reply({ ok: true });
    send(session, 'session-state', snapshot(session));
    updateQueue();
    activateNext();
  });

  socket.on('request-spin', (_payload = {}, reply = () => {}) => {
    const session = sessions.get(socket.data.token);
    if (!session || session.socketId !== socket.id || session.phase !== 'active' || activeToken !== session.token)
      return reply({ ok: false, error: 'It is not your turn.' });
    if (!kioskSocket || currentSpin || testSpinInProgress || session.credits < 1)
      return reply({ ok: false, error: 'The wheel is not ready.' });
    clearTurnTimer();
    session.credits -= 1;
    session.phase = 'spinning';
    const prize = pickPrize();
    const spin = { id: crypto.randomUUID(), token: session.token, prize };
    currentSpin = spin;
    reply({ ok: true });
    io.to(kioskSocket).emit('spin-started', { id: spin.id, prizeId: prize.id });
    send(session, 'spin-started', { id: spin.id });
    spinTimer = setTimeout(() => {
      if (currentSpin !== spin) return;
      currentSpin = null;
      spinTimer = null;
      if (prize.id === 'free') session.credits += 1;
      if (['sacrifice', 'notification', 'questions'].includes(prize.id)) {
        session.pendingKinds.push(prize.id);
        session.pendingSubmission = true;
        session.submitted = false;
      }
      if (prize.id === 'jackpot') {
        const key = todayKey();
        const existing = persistent.jackpotDecisions[key];
        if (!existing) {
          const special = firstJackpot();
          const items = special ? [{ id: 'special-jackpot-' + key, text: special.text }] : yesterdaysGossip();
          session.jackpot = { key, items, choice: null };
          persistent.jackpotDecisions[key] = { status: 'reserved', token: session.token, items };
          saveState();
        }
      }
      session.result = { prizeId: prize.id, label: prize.label, message: messageFor(prize, session) };
      send(session, 'spin-finished', { ...session.result, credits: session.credits });
      if (kioskSocket) io.to(kioskSocket).emit('spin-finished', { id: spin.id, label: prize.label });
      if (session.credits > 0) {
        session.phase = 'active';
        send(session, 'session-state', snapshot(session));
        scheduleTurnTimeout(session);
      } else {
        endTurn(session);
      }
    }, SPIN_MS);
  });

  socket.on('submit-gossip', ({ text, kind } = {}, reply = () => {}) => {
    const session = sessions.get(socket.data.token);
    if (!session || session.socketId !== socket.id || !session.pendingKinds.includes(kind))
      return reply({ ok: false, error: 'There is no pending submission for this prize.' });
    if (typeof text !== 'string' || !text.trim() || text.length > 2000)
      return reply({ ok: false, error: 'Enter up to 2,000 characters.' });
    try {
      const isAnswer = kind === 'questions';
      fs.appendFileSync(isAnswer ? answerFile : submissionFile, JSON.stringify({
        id: crypto.randomUUID(), submittedAt: new Date().toISOString(), kind,
        text: text.trim(), ...(isAnswer ? {} : { approved: false })
      }) + '\n', { mode: 0o600 });
      session.pendingKinds = session.pendingKinds.filter(item => item !== kind);
      session.pendingSubmission = session.pendingKinds.length > 0;
      session.submitted = true;
      reply({ ok: true });
      send(session, 'session-state', snapshot(session));
    } catch (error) {
      console.error(error);
      reply({ ok: false, error: 'Could not save your submission. Please retry.' });
    }
  });

  socket.on('jackpot-choice', ({ choice } = {}, reply = () => {}) => {
    const session = sessions.get(socket.data.token);
    if (!session || session.socketId !== socket.id || !session.jackpot || session.jackpot.choice)
      return reply({ ok: false, error: 'No jackpot decision is pending.' });
    if (!['release', 'keep'].includes(choice)) return reply({ ok: false, error: 'Invalid choice.' });
    const { key, items } = session.jackpot;
    const saved = persistent.jackpotDecisions[key];
    if (!saved || saved.status !== 'reserved' || saved.token !== session.token)
      return reply({ ok: false, error: 'This secret is no longer available.' });
    session.jackpot.choice = choice;
    saved.status = choice;
    // Release means eligible for moderation, not immediate public display.
    // Keep means exclude the snapshot from the wheel; preserve the records for review.
    if (choice === 'release') saved.awaitingModeration = items.map(item => item.id);
    saveState();
    reply({ ok: true });
    send(session, 'session-state', snapshot(session));
  });

  // Docent can mark a refund claimed via a private local command (see README).
  // Do not trust the visitor's phone to self-redeem a claim.
  socket.on('disconnect', () => {
    if (socket.data.role === 'kiosk' && kioskSocket === socket.id) {
      kioskSocket = null;
      // The active turn is preserved; new spins wait for kiosk reconnection.
      updateQueue();
    }
    const session = sessions.get(socket.data.token);
    if (!session || session.socketId !== socket.id) return;
    session.socketId = null;
    // Completed results remain available on reconnect; active turn has a grace period.
    if (session.phase === 'waiting') {
      session.disconnectTimer = setTimeout(() => {
        if (session.socketId || session.phase !== 'waiting') return;
        const index = queue.indexOf(session.token);
        if (index !== -1) queue.splice(index, 1);
        session.phase = 'finished';
        updateQueue();
        activateNext();
      }, 120000);
    }
    if (session.phase === 'active' || session.phase === 'spinning') {
      session.disconnectTimer = setTimeout(() => {
        if (!session.socketId && activeToken === session.token && !currentSpin) {
          endTurn(session, 'Your turn ended after disconnection.');
        }
      }, RECONNECT_GRACE_MS);
    }
  });
});

const port = Number(process.env.PORT || 3000);
httpServer.listen(port, '0.0.0.0', () => console.log(`Spin the Gossip Wheel listening on http://localhost:${port}`));
