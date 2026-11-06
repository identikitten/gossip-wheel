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

function pickPrize() {
  if (SEQUENTIAL_TEST) {
    const prize = prizes[nextTestPrize % prizes.length];
    nextTestPrize += 1;
    return prize;
  }
  let roll = crypto.randomInt(1000000000) / 1000000000 *
    prizes.reduce((sum, prize) => sum + prize.weight, 0);
  for (const prize of prizes) {
    roll -= prize.weight;
    if (roll < 0) return prize;
  }
  return prizes[prizes.length - 1];
}

function messageFor(prize, session) {
  switch (prize.id) {
    case 'gossip':
    case 'gossip2': return randomItem([...content.gossipPool, ...releasedGossip], 'There is no approved gossip to share yet.');
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
      && ['sacrifice', 'notification'].includes(entry.kind))
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
  if (activeToken || currentSpin || !kioskSocket) return;
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

io.on('connection', (socket) => {
  socket.on('register-kiosk', () => {
    // The exhibition screen has a permanent URL; no changing pairing codes.
    kioskSocket = socket.id;
    socket.data.role = 'kiosk';
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

  socket.on('request-spin', (_payload = {}, reply = () => {}) => {
    const session = sessions.get(socket.data.token);
    if (!session || session.socketId !== socket.id || session.phase !== 'active' || activeToken !== session.token)
      return reply({ ok: false, error: 'It is not your turn.' });
    if (!kioskSocket || currentSpin || session.credits < 1)
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
          const items = yesterdaysGossip();
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
