import { logger } from './src/log.js';
import fs from 'fs';
console.log('Setup complete1');

import { readFile } from 'fs/promises';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';

// import db from './src/db-loader.js';
console.log('Setup complete1');

import fio from './src/file-io.js';

import stream, { responseLifecycleEmitter } from './src/stream.js';
import bodyParser from 'body-parser';
import socket from './socket-old.js';


const wsPort = 8181

const writeFileAsync = promisify(fs.writeFile);
const existsAsync = promisify(fs.exists);
console.log('Setup complete1');
const localApp = express();
localApp.use(cors()); // Enable CORS for local app
localApp.use(bodyParser.json());
localApp.use(express.static('public'));
console.log('Setup complete2');
let selectedAPI = 'Default'

//MARK: Console Coloring
const color = {
    byNum: (mess, fgNum) => {
        mess = mess || '';
        fgNum = fgNum === undefined ? 31 : fgNum;
        return '\u001b[' + fgNum + 'm' + mess + '\u001b[39m';
    },
    black: (mess) => color.byNum(mess, 30),
    red: (mess) => color.byNum(mess, 31),
    green: (mess) => color.byNum(mess, 32),
    yellow: (mess) => color.byNum(mess, 33),
    blue: (mess) => color.byNum(mess, 34),
    magenta: (mess) => color.byNum(mess, 35),
    cyan: (mess) => color.byNum(mess, 36),
    white: (mess) => color.byNum(mess, 37),
};

const usernameColors = [
    '#FF8A8A',  // Light Red
    '#FFC17E',  // Light Orange
    '#FFEC8A',  // Light Yellow
    '#6AFF9E',  // Light Green
    '#6ABEFF',  // Light Blue
    '#C46AFF',  // Light Purple
    '#FF6AE4',  // Light Magenta
    '#FF6A9C',  // Light Pink
    '#FF5C5C',  // Red
    '#FFB54C',  // Orange
    '#FFED4C',  // Yellow
    '#4CFF69',  // Green
    '#4CCAFF',  // Blue
    '#AD4CFF',  // Purple
    '#FF4CC3',  // Magenta
    '#FF4C86',  // Pink
];

let modKey = ''
let hostKey = ''


fio.releaseLock()
api.getAPIDefaults()
//populate array with all cards on server start
//mostly to make SQL recognize them all
//previously we waited for a user to connect to do this


// Configuration
let engineMode = 'TC'

// ================= Multi-Character Queue State (Room-Scoped) =================
// Room-scoped queue state: Map<roomId, { queue, active, current }>
// roomId of null/undefined represents global queue
const roomQueues = new Map();

function getQueueState(roomId = null) {
    const key = roomId || 'global';
    if (!roomQueues.has(key)) {
        roomQueues.set(key, {
            queue: [],
            active: false,
            current: null
        });
    }
    return roomQueues.get(key);
}

function broadcastQueueState(roomId = null) {
    const state = getQueueState(roomId);
    const payload = {
        type: 'responseQueueUpdate',
        active: state.active,
        current: state.current ? { value: state.current.value, displayName: state.current.displayName } : null,
        remaining: state.queue.map(c => ({ value: c.value, displayName: c.displayName })),
        roomId: roomId
    };
    logger.info(`[Queue] Broadcast state for room ${roomId || 'global'}: active=${payload.active} current=${payload.current?.displayName || 'none'} remaining=${payload.remaining.map(r => r.displayName).join(', ')}`);

    if (roomId) {
        broadcastToRoom(roomId, payload);
    } else {
        broadcast(payload);
    }
}

function migrateSelectedCharactersIfNeeded(liveConfig) {
    if (!liveConfig?.promptConfig) return;
    const pc = liveConfig.promptConfig;
    if (!pc.selectedCharacters || !Array.isArray(pc.selectedCharacters) || pc.selectedCharacters.length === 0) {
        // Build from legacy single selection
        const value = pc.selectedCharacter;
        if (value) {
            const displayName = pc.selectedCharacterDisplayName || value;
            pc.selectedCharacters = [{ value, displayName, isMuted: false }];
        } else {
            pc.selectedCharacters = [];
        }
    }
    // Ensure legacy fields mirror first non-muted character (or first if all muted)
    const first = pc.selectedCharacters.find(c => !c.isMuted) || pc.selectedCharacters[0];
    if (first) {
        pc.selectedCharacter = first.value;
        pc.selectedCharacterDisplayName = first.displayName;
    }
}
console.log('Setup complete3');
// Build ordered queue based on latest user message content & mute states
function buildResponseQueue(trigger, context, liveConfig, options = {}) {
    const pc = liveConfig.promptConfig;
    migrateSelectedCharactersIfNeeded(liveConfig);
    const chars = Array.isArray(pc.selectedCharacters) ? pc.selectedCharacters : [];

    if (trigger === 'force' || trigger === 'regenerate') {
        if (context?.character) return [context.character];
        return [];
    }

    // Filter out muted
    const active = chars.filter(c => !c.isMuted && c.value && c.value !== 'None');
    if (active.length === 0) return [];

    const rawMessage = (context?.latestUserMessageText || '').trim();
    // Active character display names (lowercase) for fast membership tests
    const activeDisplaySet = new Set(active.map(c => (c.displayName || '').toLowerCase()));
    const message = rawMessage.toLowerCase();
    // If instructed to force a specific character to the front (e.g., continuation), do so
    const forceFirstDisplayName = options.forceFirstDisplayName?.trim();
    if (forceFirstDisplayName) {
        const first = active.find(c => (c.displayName || '').trim() === forceFirstDisplayName);
        const rest = active.filter(c => (c.displayName || '').trim() !== forceFirstDisplayName);
        const ordered = first ? [first].concat(shuffle(rest)) : shuffle(active.slice());
        logger.info(`[Queue] Forced first responder: ${forceFirstDisplayName}. Order: ${ordered.map(c => c.displayName).join(' -> ')}`);
        return ordered;
    }

    if (!message) {
        logger.info('[Queue] No latestUserMessageText provided; falling back to pure shuffle.');
        return shuffle(active.slice());
    }
    logger.info(`[Queue] Building ordered queue from message: "${rawMessage}"`);

    // Match ordering: characters whose names appear first (by regex word-ish match), others random
    const matched = [];
    const unmatched = [];
    active.forEach(c => {
        const name = (c.displayName || '').trim();
        if (!name) { unmatched.push(c); return; }
        const escaped = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Allow exact word or simple possessive (Bob or Bob's)
        const pattern = new RegExp(`(^|[^a-z0-9_])(${escaped})(?:'s)?(?=$|[^a-z0-9_])`, 'i');
        const match = message.match(pattern);
        if (match) {
            const idx = match.index + (match[1] ? match[1].length : 0); // account for leading boundary capture
            matched.push({ idx, c });
            logger.info(`[Queue][Match] ${name} at index ${idx}`);
        } else {
            unmatched.push(c);
        }
    });
    matched.sort((a, b) => a.idx - b.idx);
    const ordered = matched.map(m => m.c);
    const shuffledUnmatched = shuffle(unmatched);
    const finalOrder = ordered.concat(shuffledUnmatched);
    logger.info(`[Queue] Ordered result: ${finalOrder.map(c => c.displayName).join(' -> ')}`);
    return finalOrder;
}

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

async function startQueueProcessing(parsedMessage, user, selectedAPI, hordeKey, engineMode, liveConfig, roomId = null) {
    const state = getQueueState(roomId);
    if (state.active) return; // already processing
    state.active = true;
    logger.info(`[Queue] Starting queue for room ${roomId || 'global'} with ${state.queue.length} characters.`);
    broadcastQueueState(roomId);
    processNextInQueue(parsedMessage, user, selectedAPI, hordeKey, engineMode, liveConfig, roomId);
}

async function processNextInQueue(parsedMessage, user, selectedAPI, hordeKey, engineMode, liveConfig, roomId = null) {
    const state = getQueueState(roomId);
    if (state.queue.length === 0) {
        state.active = false;
        state.current = null;
        logger.info(`[Queue] Queue exhausted for room ${roomId || 'global'}.`);
        broadcastQueueState(roomId);
        return;
    }
    state.current = state.queue.shift();
    logger.info(`[Queue] Processing next responder for room ${roomId || 'global'}: ${state.current.displayName}. Remaining after this: ${state.queue.length}`);
    broadcastQueueState(roomId);
    // Apply legacy single-character fields for downstream API functions (with validation)
    liveConfig.promptConfig.selectedCharacter = state.current.value;
    liveConfig.promptConfig.selectedCharacterDisplayName = state.current.displayName;
    const stillActive = (liveConfig.promptConfig.selectedCharacters || []).some(c => c.value === state.current.value);
    if (!stillActive) {
        const fallback = (liveConfig.promptConfig.selectedCharacters || []).find(c => c.value && c.value !== 'None');
        logger.warn(`[Queue] Current responder ${state.current.displayName} no longer active; falling back to ${fallback?.displayName || 'NONE'}`);
        if (fallback) {
            liveConfig.promptConfig.selectedCharacter = fallback.value;
            liveConfig.promptConfig.selectedCharacterDisplayName = fallback.displayName;
            state.current = fallback; // keep consistency
        } else {
            logger.warn('[Queue] No fallback available; aborting queue processing.');
            state.active = false;
            state.current = null;
            broadcastQueueState(roomId);
            return;
        }
    }
    // Ensure username for macro replacement (no silent generic fallback)
    if (!parsedMessage.username) {
        parsedMessage.username = await resolveUsernameHint(parsedMessage, user) || null;
        if (!parsedMessage.username) logger.warn('[UsernameResolve] Queue step: unable to resolve username; {{user}} macros may be blank.');
    }

    // Trigger existing single-character pipeline
    // shouldContinue should only apply to the very first character in a continuation chain
    const shouldContinueForThis = !!parsedMessage.__continueFirstOnly;
    parsedMessage.__continueFirstOnly = false; // clear for subsequent responders
    await stream.handleResponse(
        { ...parsedMessage, chatID: 'AIChat' }, selectedAPI, hordeKey,
        engineMode, user, liveConfig, shouldContinueForThis, parsedMessage.sessionID
    );
}

// Listen for completion from stream.js to continue queue
responseLifecycleEmitter.on('responseComplete', async (context) => {
    // Context should include roomId to identify which queue to process
    const roomId = context?.roomId || null;
    const state = getQueueState(roomId);
    if (!state.active) return;
    // slight delay to avoid tight loop
    setTimeout(() => {
        const queueContext = queueContexts.get(roomId || 'global');
        if (queueContext) {
            processNextInQueue(
                queueContext.parsedMessage,
                queueContext.user,
                queueContext.selectedAPI,
                queueContext.hordeKey,
                queueContext.engineMode,
                queueContext.liveConfig,
                roomId
            );
        }
    }, 25);
});

// Room-scoped queue context storage: Map<roomId, { parsedMessage, user, ... }>
const queueContexts = new Map();

function captureQueueContext(parsedMessage, user, selectedAPI, hordeKey, engineMode, liveConfig, roomId = null) {
    const key = roomId || 'global';
    queueContexts.set(key, {
        parsedMessage,
        user,
        selectedAPI,
        hordeKey,
        engineMode,
        liveConfig
    });
}
console.log('Setup complete4');
//MARK: requestAIResponse
async function handleRequestAIResponse(parsedMessage, user, selectedAPI, hordeKey, engineMode, liveConfig, ws) {
    // ROOM ISOLATION: If in a room, use room's character config
    // Get roomId from WebSocket connection first, fallback to message
    const roomId = getWsRoom(ws) || parsedMessage?.roomId;
    if (roomId) {
        logger.info(`[handleRequestAIResponse] Getting config for room ${roomId}`);
        const roomConfig = await getRoomConfig(roomId);
        // Override global config with room's character settings
        liveConfig.promptConfig.selectedCharacter = roomConfig.promptConfig.selectedCharacter;
        liveConfig.promptConfig.selectedCharacterDisplayName = roomConfig.promptConfig.selectedCharacterDisplayName;
        liveConfig.promptConfig.selectedCharacters = roomConfig.promptConfig.selectedCharacters;
        logger.info(`[Room] Using room ${roomId} character: ${liveConfig.promptConfig.selectedCharacterDisplayName}`, {
            selectedCharacters: liveConfig.promptConfig.selectedCharacters
        });
    }

    migrateSelectedCharactersIfNeeded(liveConfig);
    const trigger = parsedMessage.trigger || 'auto';
    const isManualOrContinue = trigger === 'manual';
    // Ensure username present for macro replacement (no generic fallback)
    if (!parsedMessage.username) {
        parsedMessage.username = await resolveUsernameHint(parsedMessage, user) || null;
        if (!parsedMessage.username) logger.warn('[UsernameResolve] Initial request: username unresolved for trigger', trigger);
    }
    const context = {
        character: parsedMessage.character,
        latestUserMessageText: parsedMessage.latestUserMessageText || '',
        latestUserMessageID: parsedMessage.latestUserMessageID || parsedMessage.mesID
    };

    // Fallback: if no latestUserMessageText provided (e.g., trigger came from userChat or system), attempt retrieval
    if (!context.latestUserMessageText) {
        context.latestUserMessageText = await getMostRecentUserMessageText(roomId);
        if (context.latestUserMessageText) {
            logger.info('[Queue] Fallback populated latestUserMessageText from history.');
        }
    }

    const state = getQueueState(roomId);
    if (state.active && trigger !== 'force' && trigger !== 'regenerate') {
        ws && ws.send && ws.send(JSON.stringify({ type: 'queueSuppressed', reason: 'queue_active' }));
        logger.info(`[Queue] Suppressed new trigger while queue active for room ${roomId || 'global'}.`);
        return;
    }

    const allMuted = (liveConfig.promptConfig.selectedCharacters || []).filter(c => c.value && c.value !== 'None').every(c => c.isMuted);
    if ((trigger !== 'force' && trigger !== 'regenerate') && allMuted) {
        logger.info('[Queue] All characters muted; ignoring requestAIResponse.');
        return;
    }

    if (trigger === 'force' || trigger === 'regenerate') {
        const ch = context.character;
        if (!ch || !ch.value) {
            logger.warn('[Queue] Force/regenerate request missing character');
            return;
        }
        liveConfig.promptConfig.selectedCharacter = ch.value;
        liveConfig.promptConfig.selectedCharacterDisplayName = ch.displayName;
        captureQueueContext(parsedMessage, user, selectedAPI, hordeKey, engineMode, liveConfig, roomId);
        logger.info(`[Queue] Direct ${trigger} response for ${ch.displayName}`);
        await stream.handleResponse(
            { ...parsedMessage, chatID: 'AIChat', roomId }, selectedAPI, hordeKey,
            engineMode, user, liveConfig, false, parsedMessage.sessionID
        );
        return;
    }

    // Continuation behavior: if last chat message was by a specific active AI character, force them first
    if (isManualOrContinue) {
        try {
            // Pass roomId to read room-specific chat
            let [aiData] = await db.readAIChat(null, roomId);
            const arr = JSON.parse(aiData);
            const last = arr[arr.length - 1];
            if (last?.entity === 'AI' && last?.username) {
                const aiName = last.username; // displayName stored in chat history
                // only force if that character is currently active and not muted
                const active = (liveConfig.promptConfig.selectedCharacters || []).filter(c => !c.isMuted && c.value && c.value !== 'None');
                const found = active.find(c => (c.displayName || '').trim() === aiName.trim());
                if (found) {
                    state.queue = buildResponseQueue(trigger, context, liveConfig, { forceFirstDisplayName: aiName });
                    // Mark that only the first responder should continue
                    parsedMessage.__continueFirstOnly = true;
                } else {
                    state.queue = buildResponseQueue(trigger, context, liveConfig);
                }
            } else {
                state.queue = buildResponseQueue(trigger, context, liveConfig);
            }
        } catch (e) {
            logger.debug('[Queue] Continue inspection failed, defaulting queue:', e.message);
            state.queue = buildResponseQueue(trigger, context, liveConfig);
        }
    } else {
        state.queue = buildResponseQueue(trigger, context, liveConfig);
    }
    if (state.queue.length === 0) {
        logger.info('[Queue] No characters to enqueue (none selected or all muted).');
        return;
    }
    captureQueueContext(parsedMessage, user, selectedAPI, hordeKey, engineMode, liveConfig, roomId);
    await startQueueProcessing(parsedMessage, user, selectedAPI, hordeKey, engineMode, liveConfig, roomId);
}

async function getLastUserMessageUsername(roomId = null) {
    // Scan AIChat (entity === 'user') for last human user entry
    try {
        let [data] = await db.readAIChat(null, roomId);
        const arr = JSON.parse(data);
        for (let i = arr.length - 1; i >= 0; i--) {
            if (arr[i].entity === 'user' && arr[i].username && arr[i].username !== 'Unknown') return arr[i].username;
        }
    } catch (e) {
        logger.debug('[UsernameResolve] AIChat scan failed:', e.message);
    }
    return null;
}

async function getMostRecentUserMessageText(roomId = null) {
    // Try AIChat first (since AI triggers rely on that chain), then userChat
    try {
        let [aiData] = await db.readAIChat(null, roomId);
        const arr = JSON.parse(aiData);
        for (let i = arr.length - 1; i >= 0; i--) {
            if (arr[i].entity === 'user' && arr[i].content) return (arr[i].content || '').replace(/<[^>]+>/g, '').trim();
        }
    } catch (e) {
        logger.debug('[Queue] getMostRecentUserMessageText AIChat scan failed:', e.message);
    }
    try {
        // TODO: pass roomId to readUserChat when room-scoped
        let [userData] = await db.readUserChat();
        const arr2 = JSON.parse(userData);
        for (let i = arr2.length - 1; i >= 0; i--) {
            if (arr2[i].content) return (arr2[i].content || '').replace(/<[^>]+>/g, '').trim();
        }
    } catch (e) {
        logger.debug('[Queue] getMostRecentUserMessageText userChat scan failed:', e.message);
    }
    return '';
}

async function getLastUserChatUsername() {
    // Scan userChat history for last message username
    try {
        let [data] = await db.readUserChat();
        const arr = JSON.parse(data);
        for (let i = arr.length - 1; i >= 0; i--) {
            if (arr[i].username && arr[i].username !== 'Unknown') return arr[i].username;
        }
    } catch (e) {
        logger.debug('[UsernameResolve] userChat scan failed:', e.message);
    }
    return null;
}

async function resolveUsernameHint(parsedMessage, user) {
    if (parsedMessage?.username) return parsedMessage.username;
    if (user?.username) return user.username;
    const uc = await getLastUserChatUsername();
    if (uc) return uc;
    const ai = await getLastUserMessageUsername();
    return ai;
}
console.log('Setup complete5');
import dbRouter from './src/db_routes.js'; // Import the new router

//MARK: Routes

// Mount the DB router at /api/db
// This provides:
//   /api/db/universal/:table
//   /api/db/users
//   /api/db/aichats
//   ... and all other tables


localApp.listen(wsPort, () => {
    logger.info(`[Server] Local server listening on port ${wsPort}`);
});

console.log('Setup complete6');
// socket.startServer(localApp);
export default {
    localApp,
    hostKey,
    modKey
}
