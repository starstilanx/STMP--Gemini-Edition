import http from 'http';
import fs from 'fs';
import { readFile } from 'fs/promises';
import { watch } from 'fs';
import { promisify } from 'util';
import WebSocket from 'ws';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

import db from './src/db.js';
import fio from './src/file-io.js';
import api from './src/api-calls.js';
import converter from './src/purify.js';
import stream, { responseLifecycleEmitter } from './src/stream.js';
import { logger } from './src/log.js';
//import $ from 'jquery';

const writeFileAsync = promisify(fs.writeFile);
const existsAsync = promisify(fs.exists);

const localApp = express();
const remoteApp = express();
const mobileApp = express(); // NEW
localApp.use(express.static('public'));
remoteApp.use(express.static('public'));
mobileApp.use(express.static('public')); // NEW

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

let cardList

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const secretsPath = path.join(__dirname, 'secrets.json');
let engineMode = 'TC'

// ================= Multi-Character Queue State (New) =================
// In-memory queue of pending character responses; elements: { value, displayName }
let responseQueue = [];
let queueActive = false; // indicates queue processing in progress
let currentResponder = null; // the character currently generating a response

function broadcastQueueState() {
    const payload = {
        type: 'responseQueueUpdate',
        active: queueActive,
        current: currentResponder ? { value: currentResponder.value, displayName: currentResponder.displayName } : null,
        remaining: responseQueue.map(c => ({ value: c.value, displayName: c.displayName }))
    };
    logger.info(`[Queue] Broadcast state: active=${payload.active} current=${payload.current?.displayName || 'none'} remaining=${payload.remaining.map(r=>r.displayName).join(', ')}`);
    broadcast(payload);
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
        logger.info(`[Queue] Forced first responder: ${forceFirstDisplayName}. Order: ${ordered.map(c=>c.displayName).join(' -> ')}`);
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
    logger.info(`[Queue] Ordered result: ${finalOrder.map(c=>c.displayName).join(' -> ')}`);
    return finalOrder;
}

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

async function startQueueProcessing(parsedMessage, user, selectedAPI, hordeKey, engineMode, liveConfig) {
    if (queueActive) return; // already processing
    queueActive = true;
    logger.info(`[Queue] Starting queue with ${responseQueue.length} characters.`);
    broadcastQueueState();
    processNextInQueue(parsedMessage, user, selectedAPI, hordeKey, engineMode, liveConfig);
}

async function processNextInQueue(parsedMessage, user, selectedAPI, hordeKey, engineMode, liveConfig) {
    if (responseQueue.length === 0) {
        queueActive = false;
        currentResponder = null;
        logger.info('[Queue] Queue exhausted.');
        broadcastQueueState();
        return;
    }
    currentResponder = responseQueue.shift();
    logger.info(`[Queue] Processing next responder: ${currentResponder.displayName}. Remaining after this: ${responseQueue.length}`);
    broadcastQueueState();
    // Apply legacy single-character fields for downstream API functions (with validation)
    liveConfig.promptConfig.selectedCharacter = currentResponder.value;
    liveConfig.promptConfig.selectedCharacterDisplayName = currentResponder.displayName;
    const stillActive = (liveConfig.promptConfig.selectedCharacters||[]).some(c => c.value === currentResponder.value);
    if (!stillActive) {
        const fallback = (liveConfig.promptConfig.selectedCharacters||[]).find(c => c.value && c.value !== 'None');
        logger.warn(`[Queue] Current responder ${currentResponder.displayName} no longer active; falling back to ${fallback?.displayName || 'NONE'}`);
        if (fallback) {
            liveConfig.promptConfig.selectedCharacter = fallback.value;
            liveConfig.promptConfig.selectedCharacterDisplayName = fallback.displayName;
            currentResponder = fallback; // keep consistency
        } else {
            logger.warn('[Queue] No fallback available; aborting queue processing.');
            queueActive = false;
            currentResponder = null;
            broadcastQueueState();
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
        engineMode, user, liveConfig, shouldContinueForThis
    );
}

// Listen for completion from stream.js to continue queue
responseLifecycleEmitter.on('responseComplete', async () => {
    if (!queueActive) return;
    // slight delay to avoid tight loop
    setTimeout(() => {
        processNextInQueue(lastParsedMessageForQueue, lastUserForQueue, lastSelectedAPIForQueue, lastHordeKeyForQueue, lastEngineModeForQueue, lastLiveConfigForQueue);
    }, 25);
});

// Keep last context to reuse between queue steps
let lastParsedMessageForQueue = null;
let lastUserForQueue = null;
let lastSelectedAPIForQueue = null;
let lastHordeKeyForQueue = null;
let lastEngineModeForQueue = null;
let lastLiveConfigForQueue = null;

function captureQueueContext(parsedMessage, user, selectedAPI, hordeKey, engineMode, liveConfig) {
    lastParsedMessageForQueue = parsedMessage;
    lastUserForQueue = user;
    lastSelectedAPIForQueue = selectedAPI;
    lastHordeKeyForQueue = hordeKey;
    lastEngineModeForQueue = engineMode;
    lastLiveConfigForQueue = liveConfig;
}

//MARK: requestAIResponse
async function handleRequestAIResponse(parsedMessage, user, selectedAPI, hordeKey, engineMode, liveConfig, ws) {
    // ROOM ISOLATION: If in a room, use room's character config
    const roomId = parsedMessage?.roomId;
    if (roomId) {
        const roomConfig = await getRoomConfig(roomId);
        if (roomConfig && roomConfig.selectedCharacter) {
            // Override global config with room's character
            liveConfig.promptConfig.selectedCharacter = roomConfig.selectedCharacter;
            liveConfig.promptConfig.selectedCharacterDisplayName = roomConfig.selectedCharacterDisplayName || roomConfig.selectedCharacter;
            // If room has selectedCharacters array, use that
            if (roomConfig.selectedCharacters && roomConfig.selectedCharacters.length > 0) {
                liveConfig.promptConfig.selectedCharacters = roomConfig.selectedCharacters;
            }
            logger.info(`[Room] Using room ${roomId} character: ${liveConfig.promptConfig.selectedCharacterDisplayName}`);
        }
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

    if (queueActive && trigger !== 'force' && trigger !== 'regenerate') {
        ws && ws.send && ws.send(JSON.stringify({ type: 'queueSuppressed', reason: 'queue_active' }));
        logger.info('[Queue] Suppressed new trigger while queue active.');
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
        captureQueueContext(parsedMessage, user, selectedAPI, hordeKey, engineMode, liveConfig);
        logger.info(`[Queue] Direct ${trigger} response for ${ch.displayName}`);
        await stream.handleResponse(
            { ...parsedMessage, chatID: 'AIChat' }, selectedAPI, hordeKey,
            engineMode, user, liveConfig, false
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
                const active = (liveConfig.promptConfig.selectedCharacters||[]).filter(c => !c.isMuted && c.value && c.value !== 'None');
                const found = active.find(c => (c.displayName||'').trim() === aiName.trim());
                if (found) {
                    responseQueue = buildResponseQueue(trigger, context, liveConfig, { forceFirstDisplayName: aiName });
                    // Mark that only the first responder should continue
                    parsedMessage.__continueFirstOnly = true;
                } else {
                    responseQueue = buildResponseQueue(trigger, context, liveConfig);
                }
            } else {
                responseQueue = buildResponseQueue(trigger, context, liveConfig);
            }
        } catch (e) {
            logger.debug('[Queue] Continue inspection failed, defaulting queue:', e.message);
            responseQueue = buildResponseQueue(trigger, context, liveConfig);
        }
    } else {
        responseQueue = buildResponseQueue(trigger, context, liveConfig);
    }
    if (responseQueue.length === 0) {
        logger.info('[Queue] No characters to enqueue (none selected or all muted).');
        return;
    }
    captureQueueContext(parsedMessage, user, selectedAPI, hordeKey, engineMode, liveConfig);
    await startQueueProcessing(parsedMessage, user, selectedAPI, hordeKey, engineMode, liveConfig);
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
            if (arr[i].entity === 'user' && arr[i].content) return (arr[i].content || '').replace(/<[^>]+>/g,'').trim();
        }
    } catch (e) {
        logger.debug('[Queue] getMostRecentUserMessageText AIChat scan failed:', e.message);
    }
    try {
        // TODO: pass roomId to readUserChat when room-scoped
        let [userData] = await db.readUserChat();
        const arr2 = JSON.parse(userData);
        for (let i = arr2.length - 1; i >= 0; i--) {
            if (arr2[i].content) return (arr2[i].content || '').replace(/<[^>]+>/g,'').trim();
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

//MARK: Routes
localApp.get('/', async (req, res) => {
    const filePath = path.join(__dirname, 'public/client.html');
    try {
        const data = await readFile(filePath, 'utf8');
        res.status(200).send(data);
    } catch (err) {
        logger.error('Error loading client HTML:', err);
        res.status(500).send('Error loading the client HTML file');
    }
});

remoteApp.get('/', async (req, res) => {
    const filePath = path.join(__dirname, 'public/client.html');
    try {
        const data = await readFile(filePath, 'utf8');
        res.status(200).send(data);
    } catch (err) {
        logger.error('Error loading client HTML:', err);
        res.status(500).send('Error loading the client HTML file');
    }
});

mobileApp.get('/', async (req, res) => {
    const filePath = path.join(__dirname, 'public/mobile.html');
    try {
        const data = await readFile(filePath, 'utf8');
        res.status(200).send(data);
    } catch (err) {
        logger.error('Error loading mobile HTML:', err);
        res.status(500).send('Error loading the mobile HTML file');
    }
});

//MARK: setup WS

// Handle 404 Not Found
localApp.use((req, res) => {
    res.status(404).send('Not found');
});

remoteApp.use((req, res) => {
    res.status(404).send('Not found');
});

mobileApp.use((req, res) => {
    res.status(404).send('Not found');
});

const localServer = http.createServer(localApp);
const guestServer = http.createServer(remoteApp);
const mobileServer = http.createServer(mobileApp); // NEW

// Create both HTTP servers
const wsPort = 8181; //WS for host
const wssPort = 8182; //WSS for guests
const mobilePort = 8183; // NEW

// Create a WebSocket server
const wsServer = new WebSocket.Server({ server: localServer });
const wssServer = new WebSocket.Server({ server: guestServer });
const wsMobileServer = new WebSocket.Server({ server: mobileServer }); // NEW
wsServer.setMaxListeners(0);
wssServer.setMaxListeners(0);
wsMobileServer.setMaxListeners(0); // NEW

// Arrays to store connected clients of each server
var clientsObject = [];
var connectedUsers = [];
var hostUUID

//default values

var liveConfig, liveAPI, secretsObj, TCAPIkey, hordeKey

// ============================================================================
// ROOM STATE MANAGEMENT - Critical for message isolation
// ============================================================================

// Map roomId -> Set of WebSocket objects in that room
const roomsState = new Map();

// WeakMap ws -> roomId (track which room each connection is in)
const wsToRoom = new WeakMap();

// WeakMap ws -> userId (track which user each connection belongs to)
const wsToUser = new WeakMap();

// Map roomId -> room config object (per-room settings)
const roomConfigs = new Map();

// Import GLOBAL_ROOM_ID for fallback
const { GLOBAL_ROOM_ID } = db;

/**
 * Get the room ID for a WebSocket connection
 * @param {WebSocket} ws - WebSocket connection
 * @returns {string|null} Room ID or null if not in a room
 */
function getWsRoom(ws) {
    return wsToRoom.get(ws) || null;
}

/**
 * Get the user ID for a WebSocket connection
 * @param {WebSocket} ws - WebSocket connection
 * @returns {string|null} User ID or null
 */
function getWsUser(ws) {
    return wsToUser.get(ws) || null;
}

/**
 * Associate a WebSocket with a room
 * @param {WebSocket} ws - WebSocket connection
 * @param {string} roomId - Room ID to join
 * @param {string} userId - User ID
 */
function setWsRoom(ws, roomId, userId) {
    // Remove from previous room first
    const prevRoom = wsToRoom.get(ws);
    if (prevRoom && roomsState.has(prevRoom)) {
        roomsState.get(prevRoom).delete(ws);
        logger.info(`[Room] User ${userId} left room ${prevRoom}`);
    }
    
    // Add to new room
    wsToRoom.set(ws, roomId);
    wsToUser.set(ws, userId);
    
    if (!roomsState.has(roomId)) {
        roomsState.set(roomId, new Set());
    }
    roomsState.get(roomId).add(ws);
    
    // Verify the mapping was set
    const verifyRoom = wsToRoom.get(ws);
    logger.info(`[Room] User ${userId} joined room ${roomId}. Verified wsToRoom: ${verifyRoom}`);
}

/**
 * Remove a WebSocket from its current room (on disconnect)
 * @param {WebSocket} ws - WebSocket connection
 */
function removeWsFromRoom(ws) {
    const roomId = wsToRoom.get(ws);
    const userId = wsToUser.get(ws);
    
    if (roomId && roomsState.has(roomId)) {
        roomsState.get(roomId).delete(ws);
        logger.info(`[Room] User ${userId} left room ${roomId}`);
    }
    
    // WeakMap entries will be garbage collected automatically
}

/**
 * Get all WebSocket connections in a room
 * @param {string} roomId - Room ID
 * @returns {Set<WebSocket>} Set of WebSocket connections
 */
function getRoomConnections(roomId) {
    return roomsState.get(roomId) || new Set();
}

/**
 * Get or create room configuration
 * @param {string} roomId - Room ID
 * @returns {object} Room configuration
 */
async function getRoomConfig(roomId) {
    if (roomConfigs.has(roomId)) {
        return roomConfigs.get(roomId);
    }
    
    // Load from database
    const room = await db.getRoomById(roomId);
    if (room && room.settings) {
        roomConfigs.set(roomId, room.settings);
        return room.settings;
    }
    
    // Return empty config if room not found
    return {};
}

/**
 * Update room configuration
 * @param {string} roomId - Room ID
 * @param {object} config - New configuration
 */
async function setRoomConfig(roomId, config) {
    roomConfigs.set(roomId, config);
    await db.updateRoomSettings(roomId, { settings: config });
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function generateServerKeys() {

    // Generate a 16-byte hex string for the host key
    hostKey = crypto.randomBytes(16).toString('hex');

    // Generate a 16-byte hex string for the mod key
    modKey = crypto.randomBytes(16).toString('hex');

    if (fs.existsSync(secretsPath)) {
        secretsObj = JSON.parse(fs.readFileSync(secretsPath, { encoding: 'utf8' }));
        if (secretsObj.hostKey !== undefined && secretsObj.hostKey !== '') {
            hostKey = secretsObj.hostKey
        }
        if (secretsObj.modKey !== undefined && secretsObj.modKey !== '') {
            modKey = secretsObj.modKey
        }
    }

    return [hostKey, modKey]
}

//MARK:initFiles
async function initFiles() {
    const configPath = 'config.json';
    const secretsPath = 'secrets.json';

    // Default values for config.json
    const defaultConfig = {
        promptConfig: {
            engineMode: 'TC',
            responseLength: "200",
            contextSize: "2048",
            isAutoResponse: true,
            isStreaming: true,
            cardList: {},
            selectedCharacter: 'public/characters/CodingSensei.png',
            selectedCharacterDisplayName: 'Coding Sensei',
            samplerPresetList: {},
            selectedSamplerPreset: "public/api-presets/TC-Deterministic.json",
            instructList: {},
            selectedInstruct: "public/instructFormats/None.json",
            systemPrompt: '',
            killSystemPrompt: false,
            D4AN: '',
            D4CharDefs: false,
            killD4AN: false,
            D1JB: '',
            killD1JB: false,
            D0PostHistory: '',
            killD0PH: false,
            responsePrefill: '',
            killResponsePrefill: false,
            APIList: {},
            selectedAPI: "Default",
        },
        APIConfig: {
            name: "Default",
            endpoint: "localhost:5000",
            key: "",
            type: "TC",
            claude: false,
            created_at: "",
            last_used_at: ""
        },
        crowdControl: {
            AIChatDelay: "2",
            userChatDelay: "2",
            allowImages: true,
            guestInputPermissionState: true, //true = guests can input, false = guests cannot input
        }
    };

    //MARK: mainInit
    async function mainInit() {
        const instructSequences = await fio.readFile(defaultConfig.promptConfig.selectedInstruct);
        defaultConfig.instructSequences = instructSequences;

        const samplerData = await fio.readFile(defaultConfig.promptConfig.selectedSamplerPreset);
        defaultConfig.samplers = samplerData;

        defaultConfig.selectedCharacterDisplayName = 'Coding Sensei';

        // Default values for secrets.json
        const defaultSecrets = {
            api_key: 'YourAPIKey',
            authString: 'YourAuthString',
            horde_key: '0000000000',
        };

        // Check and create config.json if it doesn't exist
        if (!(await existsAsync(configPath))) {
            logger.warn('Creating config.json with default values...');
            await writeFileAsync(configPath, JSON.stringify(defaultConfig, null, 2));
            logger.info('config.json created.');
            liveConfig = await fio.readConfig();
        } else {
            logger.info('Loading liveConfig from config.json...');
            liveConfig = await fio.readConfig();
        }

        // Check and create secrets.json if it doesn't exist
        if (!(await existsAsync(secretsPath))) {
            logger.warn('Creating secrets.json with default values...');
            await writeFileAsync(secretsPath, JSON.stringify(defaultSecrets, null, 2));
            logger.warn('secrets.json created, please update it with real credentials now and restart the server.');
        }

        cardList = await fio.getCardList();
        logger.debug(cardList);

        if (!liveConfig?.promptConfig?.selectedCharacter || liveConfig?.promptConfig?.selectedCharacter === '') {
            logger.warn('No selected character found in config.json, getting the latest...');
            let latestCharacter = await db.getLatestCharacter();
            logger.debug(latestCharacter);
            if (!latestCharacter) {
                // For first runs they will have no character in the DB yet
                logger.warn('Database had no character in it! Adding Coding Sensei..');
                await db.upsertChar('Coding Sensei', 'Coding Sensei', 'green');
                latestCharacter = await db.getLatestCharacter();
                logger.warn('Latest Character is now ', latestCharacter);
            }

            liveConfig.promptConfig.selectedCharacter = latestCharacter.char_id;
            liveConfig.promptConfig.selectedCharacterDisplayName = latestCharacter.displayname; // For hosts
            liveConfig.selectedCharacterDisplayName = latestCharacter.displayname; // For guest
            logger.info('Writing character info to liveConfig and config.json');
            await fio.writeConfig(liveConfig, 'promptConfig.selectedCharacter', latestCharacter.char_id);
            await fio.writeConfig(liveConfig, 'promptConfig.selectedCharacterDisplayName', latestCharacter.displayname);
            await fio.writeConfig(liveConfig, 'selectedCharacterDisplayName', latestCharacter.displayname);
        }

        secretsObj = JSON.parse(fs.readFileSync('secrets.json', { encoding: 'utf8' }));
        // TCAPIkey = secretsObj.api_key
        hordeKey = secretsObj?.horde_key;
        logger.info('File initialization complete!');
    }

    await mainInit();
    
    // Ensure global room exists and migrate legacy sessions
    logger.info('Ensuring global room and migrating legacy data...');
    await db.createDefaultGlobalRoom();
    await db.migrateExistingDataToGlobalRoom();
    
    let [hostKey, modKey] = generateServerKeys();

    console.log('')
    console.log('')
    console.log('')
    logger.info('Starting SillyTavern MultiPlayer...')

    // Start the server
    localServer.listen(wsPort, '0.0.0.0', () => {
        logger.info('===========================');
        logger.info(`Host Server: ${color.yellow(`http://localhost:${wsPort}/`)}`);
        logger.info('===========================');
    });

    guestServer.listen(wssPort, '0.0.0.0', () => {
        logger.info(`Guest Server: ${color.yellow(`http://localhost:${wssPort}/`)}`);
        logger.info(`Run ${color.yellow('Remote-Link.cmd')} to make a Cloudflare tunnel for remote Guests.`);
        logger.info('===========================');
    });

    mobileServer.listen(mobilePort, '0.0.0.0', () => {
        logger.info(`Mobile Server: ${color.yellow(`http://localhost:${mobilePort}/`)}`);
        logger.info('===========================');
    });

    logger.info(`${color.yellow(`Host Key: ${hostKey}`)}`);
    logger.info(`${color.yellow(`Mod Key: ${modKey}`)}`);
}

// Create default directories
fio.createDirectoryIfNotExist("./public/api-presets");
fio.createDirectoryIfNotExist("./public/characters");
fio.createDirectoryIfNotExist("./public/instruct");

await initFiles();

// Handle incoming WebSocket connections for Host Server
wsServer.on('connection', (ws, request) => {
    handleConnections(ws, 'host', request);
});

// Handle incoming WebSocket connections for Guest Server
// Handle incoming WebSocket connections for Guest Server
wssServer.on('connection', (ws, request) => {
    handleConnections(ws, 'guest', request);
});

// Handle incoming WebSocket connections for Mobile Server
wsMobileServer.on('connection', (ws, request) => {
    handleConnections(ws, 'guest', request);
});

//MARK: broadcast
const unloggedMessageTypes = [ // These message types will not be logged. Add more types as needed
    'streamedAIResponse',
    'pastChatsList',
    'hostStateChange',
    'guestStateChange', //uncomment any of these to see them in the console
    'chatUpdate',
    'userChatUpdate',
    'heartbeat',
    'pastChatToLoad',
    'userList',
];

export async function broadcast(message, role = 'all') {
    try {
        const clientUUIDs = Object.keys(clientsObject);

        const shouldReport = !unloggedMessageTypes.includes(message.type);

        if (shouldReport) {
            logger.info(`Broadcasting "${message.type}" to ${role !== 'all' ? ` users with role "${role}".` : `all ${clientUUIDs.length}  users.`}`);
        }

        const sentTo = [];
        const failedTo = [];
        const missingUsers = [];
        for (const clientUUID of clientUUIDs) {
            const client = clientsObject[clientUUID];
            const socket = client.socket;

            // Skip closed or invalid sockets
            if (!socket || socket.readyState !== WebSocket.OPEN) {
                continue;
            }

            // Check role if not broadcasting to all
            if (role !== 'all') {
                try {
                    const user = await db.getUser(clientUUID);
                    if (user.role !== role) {
                        continue;
                    }
                } catch (dbError) {
                    missingUsers.push(client.username || clientUUID);
                    logger.error(`Failed to get user ${clientUUID} for role check:`, dbError);
                    continue;
                }
            }

            // Send message
            try {
                socket.send(JSON.stringify(message));
                sentTo.push(client.username || clientUUID);
            } catch (sendError) {
                failedTo.push(client.username || clientUUID);
                logger.error(`Failed to send message to ${client.username || clientUUID}:`, sendError);
            }
        }

        // Log successful sends (configurable)
        if (sentTo.length > 0 && shouldReport) {
            logger.info(`Sent "${message.type}" message to: ${sentTo.join(', ')}`);
        }

        // Log failed sends (configurable)
        if (failedTo.length > 0) {
            logger.info(`Failed to send "${message.type}" message to: ${failedTo.join(', ')}`);
        }

        // Log missing users (configurable)
        if (missingUsers.length > 0) {
            logger.info(`Missing user info for: ${missingUsers.join(', ')}`);
        }

        if (shouldReport) {
            logger.info('Message details:', message);
        }


        return { sentTo, totalClients: clientUUIDs.length };
    } catch (error) {
        logger.error('Broadcast error:', error);
        throw error;
    }
}

/**
 * ROOM-SCOPED BROADCAST - Critical for preventing global sync contamination
 * Send a message only to WebSocket connections in a specific room
 * @param {string} roomId - Room ID to broadcast to
 * @param {object} message - Message object to send
 * @param {string} role - Optional role filter ('all', 'host', etc.)
 * @returns {Promise<object>} Result with sentTo and totalClients
 */
export async function broadcastToRoom(roomId, message, role = 'all') {
    if (!roomId) {
        logger.error('[broadcastToRoom] CRITICAL: Called without roomId! This would cause global sync.');
        return { sentTo: [], totalClients: 0 };
    }
    
    const connections = getRoomConnections(roomId);
    if (connections.size === 0) {
        logger.debug(`[broadcastToRoom] No connections in room ${roomId}`);
        return { sentTo: [], totalClients: 0 };
    }
    
    const shouldReport = !unloggedMessageTypes.includes(message.type);
    
    if (shouldReport) {
        logger.info(`[Room ${roomId}] Broadcasting "${message.type}" to ${connections.size} users`);
    }
    
    const sentTo = [];
    const failedTo = [];
    
    for (const ws of connections) {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            continue;
        }
        
        // Role filtering if needed
        if (role !== 'all') {
            const userId = getWsUser(ws);
            if (userId) {
                try {
                    const user = await db.getUser(userId);
                    if (user && user.role !== role) {
                        continue;
                    }
                } catch (e) {
                    logger.debug(`[broadcastToRoom] Role check failed for user:`, e.message);
                    continue;
                }
            }
        }
        
        try {
            ws.send(JSON.stringify(message));
            const userId = getWsUser(ws);
            sentTo.push(userId || 'unknown');
        } catch (sendError) {
            const userId = getWsUser(ws);
            failedTo.push(userId || 'unknown');
            logger.error(`[broadcastToRoom] Failed to send to user:`, sendError);
        }
    }
    
    if (shouldReport && sentTo.length > 0) {
        logger.info(`[Room ${roomId}] Sent "${message.type}" to: ${sentTo.join(', ')}`);
    }
    
    if (failedTo.length > 0) {
        logger.warn(`[Room ${roomId}] Failed to send to: ${failedTo.join(', ')}`);
    }
    
    return { sentTo, totalClients: connections.size };
}

/**
 * Require room context middleware - validates roomId before processing
 * Use this wrapper for message handlers that MUST be room-scoped
 * @param {WebSocket} ws - WebSocket connection
 * @param {object} data - Parsed message data
 * @param {Function} handler - Async handler function(ws, data, roomId)
 * @returns {Promise<boolean>} True if handler was executed, false if blocked
 */
async function requireRoom(ws, data, handler) {
    const roomId = getWsRoom(ws);
    
    if (!roomId) {
        logger.warn(`[requireRoom] Blocked message type "${data.type}" - no room context`);
        ws.send(JSON.stringify({
            type: 'error',
            message: 'You must join a room before performing this action',
            originalType: data.type
        }));
        return false;
    }
    
    // Validate user is actually in the room
    const userId = getWsUser(ws);
    if (userId) {
        const inRoom = await db.isUserInRoom(roomId, userId);
        if (!inRoom) {
            logger.warn(`[requireRoom] User ${userId} not in room ${roomId}`);
            ws.send(JSON.stringify({
                type: 'error',
                message: 'You are not a member of this room',
                originalType: data.type
            }));
            return false;
        }
    }
    
    try {
        await handler(ws, data, roomId);
        return true;
    } catch (err) {
        logger.error(`[requireRoom] Handler error:`, err);
        return false;
    }
}

// Broadcast the updated array of connected usernames to all clients
//gets its own function because sent so often.
//TODO: could probably have 'userListMessage' split into a global and just use broadcast() instead
async function broadcastUserList() {
    const userListMessage = {
        type: 'userList',
        userList: connectedUsers
    };
    broadcast(userListMessage);
    logger.debug(`[UserList BroadCast]:`);
    logger.debug(connectedUsers);
}

//MARK: removeLastAIChatMsg
async function removeLastAIChatMessage() {
    let activeSessionID = await db.removeLastAIChatMessage()
    let [AIChatJSON, sessionID] = await db.readAIChat();
    let jsonArray = JSON.parse(AIChatJSON)
    let chatUpdateMessage = {
        type: 'chatUpdate',
        chatHistory: markdownifyChatHistoriesArray(jsonArray),
        sessionID: sessionID
    }
    logger.info('sending AI Chat Update instruction to clients at the end of removeLastAIChatMessage')
    broadcast(chatUpdateMessage);
    return activeSessionID
}

async function removeAnyAIChatMessage(parsedMessage) {
    const result = await db.deleteAIChatMessage(parsedMessage.mesID)
    if (result === 'ok') {
        logger.info(`Message ${parsedMessage.mesID} was deleted`);
        let [AIChatJSON, sessionID] = await db.readAIChat();
        let jsonArray = JSON.parse(AIChatJSON)
        let chatUpdateMessage = {
            type: 'chatUpdate',
            chatHistory: markdownifyChatHistoriesArray(jsonArray),
            sessionID
        }
        logger.info('sending AI Chat Update instruction to clients at the end of removeAnyAIChatMessage')
        broadcast(chatUpdateMessage);
    }
}

async function removeAnyUserChatMessage(parsedMessage) {
    const result = await db.deleteUserChatMessage(parsedMessage.mesID)
    if (result === 'ok') {
        logger.info(`Message ${parsedMessage.mesID} was deleted`);
        let [chatJSON, sessionID] = await db.readUserChat();
        let jsonArray = JSON.parse(chatJSON)
        let chatUpdateMessage = {
            type: 'userChatUpdate',
            chatHistory: markdownifyChatHistoriesArray(jsonArray),
            sessionID
        }
        logger.info('sending AI Chat Update instruction to clients')
        broadcast(chatUpdateMessage);
    }
}

async function saveAndClearChat(type, roomId = null) {
    if (type === 'AIChat') {
        let newSessionID = await db.newSession(roomId);
        await db.setActiveChat(newSessionID, roomId);
        return newSessionID
    }
    else if (type === 'userChat') {
        await db.newUserChatSession(roomId);
    }
    else {
        logger.warn('Unknown chat type. Not saving chat history. This should never happen.');
    }
}

function duplicateNameToValue(array) {
    return array.map((obj) => ({ ...obj, value: obj.name }));
}

//logger.debug(liveConfig)
//MARK: getValFromConfigFile
async function getValueFromConfigFile(key) {
    try {
        //logger.warn('configdata: ', configdata);

        let configdata = await fio.readConfig()
        //logger.warn('configdata parsed: ', configdata.crowdControl);
        const soughtData = key.split('.').reduce((obj, k) => {
            if (obj && typeof obj === 'object') {
                return obj[k];
            }
            return undefined;
        }, configdata);
        //logger.info('[getValueFromConfigFile] key:', key, 'soughtData:', soughtData);
        return soughtData;
    } catch (err) {
        logger.error('Error reading config.json:', err);
        return null;
    }
}

export let purifier = converter.createConverter((await getValueFromConfigFile('crowdControl.allowImages')));

watch('config.json', async (eventType, filename) => {

    const allowImages = await getValueFromConfigFile('crowdControl.allowImages');
    if (eventType === 'change') {
        try {
            //logger.debug('allowImages for purifier:', allowImages);
            purifier = converter.createConverter(allowImages ?? true); // Fallback to true if null
        } catch (err) {
            logger.error('Error updating purifier:', err);
        }
    }
});

const activeClearChatTimers = {}; // key = target, value = timeout ID

// Track connections per IP
const ipConnectionMap = new Map();
const MAX_CONNECTIONS_PER_IP = 5; // Adjust this limit as needed

//MARK: handleConnections()
async function handleConnections(ws, type, request) {

    const clientIP = request.headers['x-forwarded-for']?.split(',')[0]?.trim() || request.socket.remoteAddress;
    logger.info(`Connection attempt from IP: ${clientIP}`);

    // Check IP connection limit
    const currentConnections = ipConnectionMap.get(clientIP) || 0;
    if (currentConnections >= MAX_CONNECTIONS_PER_IP) {
        logger.warn(`Connection rejected: IP ${clientIP} exceeded ${MAX_CONNECTIONS_PER_IP} connections`);
        ws.close(1008, `Too many connections from this IP. Maximum allowed: ${MAX_CONNECTIONS_PER_IP}`);
        return;
    }

    // Increment connection count for this IP
    ipConnectionMap.set(clientIP, currentConnections + 1);
    logger.info(`IP ${clientIP} now has ${currentConnections + 1} active connections`);

    const urlParams = new URLSearchParams(request.url.split('?')[1]);
    const encodedUsername = urlParams.get('username');
    const decodedUsername = decodeURIComponent(encodedUsername || '').trim();


    //USE THESE WHEN REFERRING TO THE USER
    let uuid = urlParams.get('uuid');
    let thisUserColor, thisUserUsername, thisUserRole;
    //USE THESE WHEN REFERRING TO THE USER


    if (!uuid) {
        uuid = uuidv4();
        logger.info(`Client connected without UUID. Assigned new UUID: ${uuid}`);
    } else {
        logger.info(`Client connected with UUID: ${uuid}`);
    }

    if (!decodedUsername) {
        logger.warn('No valid username provided. Connection rejected.');
        ws.close();
        return;
    }

    let user = await db.getUser(uuid); //this will not populate for new users

    if (user) {
        thisUserColor = user.username_color;
        thisUserUsername = user.username;
        thisUserRole = user.role;
    } else { //make new values for new users
        thisUserColor = usernameColors[Math.floor(Math.random() * usernameColors.length)];
        thisUserUsername = decodedUsername;
        thisUserRole = type;

        await db.upsertUser(uuid, thisUserUsername, thisUserColor); //register them
        await db.upsertUserRole(uuid, thisUserRole); //register their role
        logger.info(`New user registered: ${thisUserUsername} (${uuid}), color: ${thisUserColor}, role: ${thisUserRole}`);
        
        // Initialize user object for closure access
        user = {
            user_id: uuid,
            username: thisUserUsername,
            username_color: thisUserColor,
            role: thisUserRole,
            persona: ''
        };
    }

    clientsObject[uuid] = {
        socket: ws,
        color: thisUserColor,
        role: thisUserRole,
        username: thisUserUsername,
        persona: user?.persona || '' // ADD THIS
    };

    updateConnectedUsers();

    logger.info(`User connected: ${thisUserUsername} (${uuid})`);
    logger.trace({
        user: clientsObject[uuid],
        connectedUsers,
        clientsObject
    });

    // Load required data
    const [instructList, samplerPresetList, [AIChatJSON, AISessionID], [userChatJSON, sessionID]] = await Promise.all([
        await fio.getInstructList(),
        await fio.getSamplerPresetList(),
        await db.readAIChat(),
        await db.readUserChat()
    ]);

    const baseMessage = {
        clientUUID: uuid,
        type: thisUserRole === 'host' ? 'connectionConfirmed' : 'guestConnectionConfirmed',
        chatHistory: markdownifyChatHistoriesArray(userChatJSON),
        sessionID,
        AIChatHistory: markdownifyChatHistoriesArray(AIChatJSON),
        AIChatSessionID: AISessionID,
        color: thisUserColor,
        role: thisUserRole,
        selectedCharacterDisplayName: liveConfig.promptConfig?.selectedCharacterDisplayName,
        userList: connectedUsers,
        /*         liveConfig: {
                    crowdControl: {
                        userChatDelay: liveConfig?.crowdControl?.userChatDelay || "2",
                        AIChatDelay: liveConfig?.crowdControl?.AIChatDelay || "2",
                        allowImages: liveConfig?.crowdControl?.allowImages || false,
                        guestInputPermissionState: liveConfig?.crowdControl?.guestInputPermissionState || true
        
                    }
                }, */
        crowdControl: liveConfig.crowdControl,
        selectedModelForGuestDisplay: liveConfig.APIConfig.selectedModel
    };

    if (thisUserRole === 'host') {
        hostUUID = uuid;

        cardList = await fio.getCardList() //get a fresh card list on each new host connection

        let [apis, APIConfig] = await Promise.all([
            await db.getAPIs().then(duplicateNameToValue),
            await db.getAPI(liveConfig.promptConfig.selectedAPI)
        ]);

        // Correct fallback logic: only set to Default if APIConfig is missing or the named API doesn't exist
        if (!APIConfig || APIConfig.name === undefined) {
            liveConfig.promptConfig.selectedAPI = 'Default';
            APIConfig = await db.getAPI('Default');
        } else if (APIConfig.name !== liveConfig.promptConfig.selectedAPI) {
            // If the retrieved APIConfig does not match the stored selectedAPI, verify existence
            const maybe = await db.getAPI(liveConfig.promptConfig.selectedAPI);
            if (!maybe) {
                liveConfig.promptConfig.selectedAPI = 'Default';
                APIConfig = await db.getAPI('Default');
            } else {
                APIConfig = maybe; // realign to requested one
            }
        }

    // Keep in-memory APIConfig synchronized with DB result (ensures fields like useTokenizer are present)
    liveConfig.APIConfig = APIConfig;
    await fio.writeConfig(liveConfig);

        baseMessage.liveConfig = {
            promptConfig: {
                ...liveConfig.promptConfig,
                cardList,
                instructList,
                samplerPresetList,
                APIList: apis
            },
            APIConfig,
            crowdControl: liveConfig.crowdControl
        };
    }

    await broadcastUserList();
    logger.info('Sending initial message to client:', thisUserUsername);
    ws.send(JSON.stringify(baseMessage));

    function updateConnectedUsers() {
        const userList = Object.values(clientsObject).map(client => ({
            username: client.username,
            color: client.color,
            role: client.role,
            persona: client.persona // ADD THIS
        }));
        connectedUsers = userList;
    }

    //MARK: WS Msg handling
    // Handle incoming messages from clients
    ws.on('message', async function (message) {

        logger.trace(`--- MESSAGE IN`)
        // Parse the incoming message as JSON
        let parsedMessage;

        try {
            parsedMessage = JSON.parse(message);

            let shouldReport = !unloggedMessageTypes.includes(parsedMessage.type);
            if (shouldReport) {
                logger.info(`Received ${parsedMessage.type} message from ${thisUserUsername}`);
                logger.debug(parsedMessage);
            }

            const senderUUID = parsedMessage.UUID
            let userColor = await db.getUserColor(senderUUID)
            let thisClientObj = clientsObject[parsedMessage.UUID];

            //If there is no UUID, then this is a new client and we need to add it to clientsObject
            if (!thisClientObj) {
                thisClientObj = {
                    username: '',
                    color: '',
                    role: '',
                };
                clientsObject[parsedMessage.UUID] = thisClientObj;
            }

            // Handle persona updates from any user
            if (parsedMessage.type === 'updatePersona') {
                logger.info(`Updating persona for ${thisUserUsername}`);
                await db.upsertUser(senderUUID, thisUserUsername, userColor, parsedMessage.persona);
                // Update local memory
                if (clientsObject[parsedMessage.UUID]) {
                    clientsObject[parsedMessage.UUID].persona = parsedMessage.persona;
                }
                // Update closure variable
                if (user) user.persona = parsedMessage.persona;
                updateConnectedUsers();
                await broadcastUserList();
                return;
            }

            //first check if the sender is host, and if so, process possible host commands
            if (thisUserRole === 'host') {
                if (parsedMessage.type === 'clientStateChange') {
                    logger.info('Received updated liveConfig from Host client...')

                    logger.info('Checking APIList for changes..')
                    await checkAPIListChanges(liveConfig, parsedMessage)

                    logger.info('writing liveConfig to file')
                    liveConfig = parsedMessage.value
                    // After processing API list changes, refresh APIConfig and APIList from DB to avoid dropping fields (e.g., useTokenizer)
                    try {
                        const selected = liveConfig?.promptConfig?.selectedAPI || 'Default';
                        const refreshed = await db.getAPI(selected);
                        if (refreshed) {
                            liveConfig.APIConfig = refreshed;
                        }
                        liveConfig.promptConfig.APIList = await db.getAPIs();
                    } catch (e) {
                        logger.warn('Failed to refresh APIConfig/APIList after clientStateChange:', e.message);
                    }
                    // Migrate / validate multi-character schema
                    migrateSelectedCharactersIfNeeded(liveConfig)
                    await fio.writeConfig(liveConfig)
                    logger.info('broadcasting new liveconfig to all hosts')
                    let hostStateChangeMessage = {
                        type: 'hostStateChange',
                        value: liveConfig
                    }
                    await broadcast(hostStateChangeMessage, 'host');

                    let guestStateMessage = {
                        type: "guestStateChange",
                        state: {
                            selectedCharacter: liveConfig.promptConfig.selectedCharacterDisplayName,
                            userChatDelay: liveConfig.crowdControl.userChatDelay,
                            AIChatDelay: liveConfig.crowdControl.AIChatDelay,
                            allowImages: liveConfig.crowdControl.allowImages,
                            selectedModelForGuestDisplay: liveConfig.APIConfig.selectedModel
                        }

                    }
                    await broadcast(guestStateMessage, 'guest');
                    return
                }
                else if (parsedMessage.type === 'requestAIResponse') {
                    await handleRequestAIResponse(parsedMessage, user, selectedAPI, hordeKey, engineMode, liveConfig, ws);
                    return;
                }
                else if (parsedMessage.type === 'modelSelect') {
                    const selectedModel = parsedMessage.value;
                    logger.info(`Changing selected model for ${liveConfig.APIConfig.name} to ${selectedModel}..`)
                    liveConfig.APIConfig.selectedModel = selectedModel;
                    await db.upsertAPI(liveConfig.APIConfig);
                    liveConfig.promptConfig.APIList = await db.getAPIs();
                    await fio.writeConfig(liveConfig);
                    const settingChangeMessage = {
                        type: 'hostStateChange',
                        value: liveConfig
                    };
                    const selectedModelForGuestDisplay = {
                        type: 'modelChangeForGuests',
                        selectedModelForGuestDisplay: selectedModel

                    }
                    await broadcast(selectedModelForGuestDisplay, 'guest');
                    await broadcast(settingChangeMessage, 'host');
                    return;
                }
                else if (parsedMessage.type === 'testNewAPI') {
                    let result = await api.testAPI(parsedMessage.api, liveConfig)
                    logger.info(result)
                    let testAPIResult = {
                        type: 'testAPIResult',
                        result: result
                    }
                    //only send back to the user who is doing the test.
                    await ws.send(JSON.stringify(testAPIResult))
                    return
                }
                else if (parsedMessage.type === 'modelListRequest') {

                    if (liveConfig.promptConfig.engineMode !== 'horde') {
                        let modelList = await api.getModelList(parsedMessage.api, liveConfig);
                        let modelListResult = {};

                        if (typeof modelList === 'object') {
                            const prevCfg = liveConfig.APIConfig || {};
                            liveConfig.APIConfig = {
                                ...prevCfg,
                                ...parsedMessage.api,
                                modelList: modelList,
                                selectedModel: modelList[0],
                                // Preserve tokenizer/claude flags if client payload omitted them
                                useTokenizer: (typeof parsedMessage.api?.useTokenizer === 'boolean') ? parsedMessage.api.useTokenizer : !!prevCfg.useTokenizer,
                                claude: (typeof parsedMessage.api?.claude === 'boolean') ? parsedMessage.api.claude : !!prevCfg.claude,
                            };

                            await db.upsertAPI(liveConfig.APIConfig);
                            liveConfig.promptConfig.APIList = await db.getAPIs();
                            await fio.writeConfig(liveConfig);

                            modelListResult = {
                                type: 'hostStateChange',
                                value: liveConfig
                            };
                        } else {
                            modelListResult = {
                                type: 'modelListError',
                                value: 'ERROR'
                            };
                        }

                        await ws.send(JSON.stringify(modelListResult));
                        return
                    } else if (liveConfig.promptConfig.engineMode === 'horde') {
                        let modeChangeMessage = {
                            type: 'modeChange',
                            engineMode: engineMode,
                            hordeWorkerList: await api.getHordeModelList(hordeKey),
                        }
                        await broadcast(modeChangeMessage, 'host');
                        return
                    }
                }
                else if (parsedMessage.type === 'modelLoadRequest') {
                    const response = await api.tryLoadModel(parsedMessage.api, liveConfig, hordeKey);
                    const responseMessage = {
                        type: 'modelLoadResponse',
                        result: response,

                    };
                    return ws.send(JSON.stringify(responseMessage));
                }

                else if (parsedMessage.type === 'startClearChatTimer') {
                    logger.warn('recognized startClearChatTimer message');

                    const { target, secondsLeft } = parsedMessage;
                    
                    // Capture room context for use in timer callback
                    const timerRoomId = getWsRoom(ws);
                    const timerKey = timerRoomId ? `${target}:${timerRoomId}` : target;

                    // If there's already a timer for this target in this room, ignore
                    if (activeClearChatTimers[timerKey]) {
                        logger.warn(`Timer already active for ${timerKey}, ignoring new request.`);
                        return;
                    }

                    const responseMessage = {
                        type: 'startClearTimerResponse',
                        target,
                        roomId: timerRoomId
                    };
                    
                    // Broadcast to room or globally
                    if (timerRoomId) {
                        await broadcastToRoom(timerRoomId, responseMessage);
                    } else {
                        await broadcast(responseMessage);
                    }
                    logger.warn(`Broadcasted startClearTimerResponse for ${target} in room ${timerRoomId || 'global'}. Waiting ${secondsLeft}s...`);

                    // Start and store the timer
                    activeClearChatTimers[timerKey] = setTimeout(async () => {
                        logger.warn(`Time is up! Clearing chat for ${target} in room ${timerRoomId || 'global'}`);
                        delete activeClearChatTimers[timerKey];

                        if (target === '#AIChat') {
                            logger.warn(`Saving and clearing AIChat for room ${timerRoomId || 'global'}...`);
                            const newSessionID = await saveAndClearChat('AIChat', timerRoomId);
                            
                            // Broadcast clear to room or globally
                            const clearMsg = { type: 'clearAIChat', sessionID: newSessionID, roomId: timerRoomId };
                            if (timerRoomId) {
                                await broadcastToRoom(timerRoomId, clearMsg);
                            } else {
                                await broadcast(clearMsg);
                            }

                            // Get room config for characters (if in room) or global config
                            const configToUse = timerRoomId ? await getRoomConfig(timerRoomId) : liveConfig.promptConfig;
                            migrateSelectedCharactersIfNeeded(liveConfig);
                            const scArr = (configToUse.selectedCharacters || liveConfig.promptConfig.selectedCharacters || [])
                                .filter(c => c.value && c.value !== 'None' && !c.isMuted);
                            if (scArr.length === 0) {
                                logger.warn('[ClearAIChat] No active characters to seed first messages.');
                            }

                            for (const charEntry of scArr) {
                                try {
                                    const charFile = charEntry.value;
                                    const cardData = await fio.charaRead(charFile, 'png');
                                    const cardJSON = JSON.parse(cardData);
                                    const charName = cardJSON.name || charEntry.displayName || 'AI';
                                    const firstMesRaw = cardJSON.first_mes || '';
                                    const firstMes = api.replaceMacros(firstMesRaw, thisUserUsername, charName);

                                    // Persist message with room context
                                    await db.writeAIChatMessage(charName, charName, firstMes, 'AI', timerRoomId);

                                    // Query just-inserted row
                                    const dbRow = await (async () => {
                                        const [rowsJSON] = await db.readAIChat(newSessionID, timerRoomId);
                                        const rows = JSON.parse(rowsJSON);
                                        return rows[rows.length - 1];
                                    })();

                                    const outMessage = {
                                        type: 'chatMessage',
                                        chatID: 'AIChat',
                                        sessionID: dbRow?.sessionID || newSessionID,
                                        messageID: dbRow?.messageID || null,
                                        content: purifier.makeHtml(firstMes),
                                        username: charName,
                                        entity: 'AI',
                                        timestamp: dbRow?.timestamp || new Date().toISOString(),
                                        AIChatUserList: [{ username: charName, color: 'white', entity: 'AI', role: 'AI' }],
                                        roomId: timerRoomId
                                    };
                                    
                                    if (timerRoomId) {
                                        await broadcastToRoom(timerRoomId, outMessage);
                                    } else {
                                        await broadcast(outMessage);
                                    }
                                    logger.warn(`[ClearAIChat] Seeded first message for ${charName} in room ${timerRoomId || 'global'}`);
                                } catch (seedErr) {
                                    logger.error('[ClearAIChat] Error seeding first message for character slot:', charEntry, seedErr);
                                }
                            }
                        }

                        if (target === '#userChat') {
                            logger.warn(`Saving and clearing userChat for room ${timerRoomId || 'global'}...`);
                            await saveAndClearChat('userChat', timerRoomId);
                            const clearMsg = { type: 'clearChat', roomId: timerRoomId };
                            if (timerRoomId) {
                                await broadcastToRoom(timerRoomId, clearMsg);
                            } else {
                                await broadcast(clearMsg);
                            }
                        }

                    }, secondsLeft * 1000);

                    return;
                }

                else if (parsedMessage.type === 'cancelClearChatTimer') {
                    const { target } = parsedMessage;

                    // Cancel and remove the active timer if it exists
                    if (activeClearChatTimers[target]) {
                        clearTimeout(activeClearChatTimers[target]);
                        delete activeClearChatTimers[target];
                        logger.warn(`Canceled timer for ${target}`);
                    } else {
                        logger.warn(`No active timer found for ${target}`);
                    }

                    const responseMessage = {
                        type: 'cancelClearTimerResponse',
                        target,
                    };
                    await broadcast(responseMessage);
                    return;
                }

                else if (parsedMessage.type === 'deleteLast') {
                    await removeLastAIChatMessage()
                    return
                }
                else if (parsedMessage.type === 'changeCharacterRequest') {
                    const currentRoomId = getWsRoom(ws);
                    const changeCharMessage = {
                        type: 'changeCharacter',
                        char: parsedMessage.newChar,
                        charDisplayName: parsedMessage.newCharDisplayName,
                        roomId: currentRoomId
                    }

                    // Store character in room config, not global
                    if (currentRoomId) {
                        const roomConfig = await getRoomConfig(currentRoomId);
                        roomConfig.selectedCharacter = parsedMessage.newChar;
                        roomConfig.selectedCharacterDisplayName = parsedMessage.newCharDisplayName;
                        await setRoomConfig(currentRoomId, roomConfig);
                    } else {
                        // Fallback to global for backward compatibility
                        liveConfig.promptConfig.selectedCharacter = parsedMessage.newChar;
                        liveConfig.promptConfig.selectedCharacterDisplayName = parsedMessage.newCharDisplayName;
                        await fio.writeConfig(liveConfig);
                    }
                    
                    await db.upsertChar(parsedMessage.newChar, parsedMessage.newCharDisplayName, user.color);
                    
                    // Broadcast to room or globally
                    if (currentRoomId) {
                        await broadcastToRoom(currentRoomId, changeCharMessage, 'host');
                        await new Promise((resolve) => setTimeout(resolve, 0));
                        delete changeCharMessage.char;
                        changeCharMessage.type = 'changeCharacterDisplayName';
                        await broadcastToRoom(currentRoomId, changeCharMessage, 'guest');
                    } else {
                        await broadcast(changeCharMessage, 'host');
                        await new Promise((resolve) => setTimeout(resolve, 0));
                        delete changeCharMessage.char;
                        changeCharMessage.type = 'changeCharacterDisplayName';
                        await broadcast(changeCharMessage, 'guest');
                    }
                    return;
                }
                else if (parsedMessage.type === 'displayCharDefs') {
                    const charDefs = await fio.charaRead(parsedMessage.value)
                    //logger.warn(charDefs)
                    const charDefResponse = {
                        type: 'charDefsResponse',
                        content: charDefs
                    }
                    ws.send(JSON.stringify(charDefResponse))
                    return
                }

                else if (parsedMessage.type === 'charEditRequest') {
                    logger.debug(parsedMessage.newCharDefs)
                    fio.charaWrite(parsedMessage.char, parsedMessage.newCharDefs)
                    return
                }

                else if (parsedMessage.type === 'AIRetry') {
                    //MARK: AIRetry
                    if (thisUserRole !== 'host') {
                        logger.warn('Non-host attempted AIRetry; ignoring.');
                        return;
                    }
                    // Read the AIChat file
                    try {
                        // Fetch the original message BEFORE removal so we have its metadata
                        const originalRow = await db.getAIChatMessageRow(parsedMessage.mesID, parsedMessage.sessionID);
                        let activeSessionID = await removeLastAIChatMessage();

                        migrateSelectedCharactersIfNeeded(liveConfig);
                        const scArr = liveConfig.promptConfig.selectedCharacters || [];

                        let targetCharEntry = null;
                        if (originalRow) {
                            const uname = (originalRow.username || '').toLowerCase();
                            // 1. Direct displayName match
                            targetCharEntry = scArr.find(c => (c.displayName || '').toLowerCase() === uname) || null;
                            // 2. If no match, attempt match by stripping extension from value path
                            if (!targetCharEntry && uname) {
                                targetCharEntry = scArr.find(c => (c.value || '').toLowerCase().includes(uname));
                            }
                        }
                        // 3. Fallback: use first non-[None] entry
                        if (!targetCharEntry) {
                            targetCharEntry = scArr.find(c => c.value !== 'None') || scArr[0] || null;
                        }

                        if (!targetCharEntry) {
                            logger.warn('[AIRetry] Could not resolve character entry; aborting regenerate.');
                            return;
                        }

                        const originatingUser = originalRow?.originalSender || await getLastUserMessageUsername() || null;
                        if (!originatingUser) logger.warn('[UsernameResolve] AIRetry: could not resolve originating user; {{user}} may be blank.');
                        logger.info(`[AIRetry] Regenerating for character ${targetCharEntry.displayName} (${targetCharEntry.value}) triggered by user ${originatingUser}`);
                        await handleRequestAIResponse({
                            type: 'requestAIResponse',
                            trigger: 'regenerate',
                            character: { value: targetCharEntry.value, displayName: targetCharEntry.displayName },
                            mesID: parsedMessage.mesID,
                            latestUserMessageID: parsedMessage.mesID,
                            username: originatingUser
                        }, user, selectedAPI, hordeKey, engineMode, liveConfig, ws);
                        return
                    } catch (parseError) {
                        logger.error('JSON parse error during AI Retry:', parseError);
                        return;
                    }
                }

                else if (parsedMessage.type === 'continueFromMessage') {
                    // Explicit continuation of a specific AI message
                    if (thisUserRole !== 'host') {
                        logger.warn('Non-host attempted continueFromMessage; ignoring.');
                        return;
                    }
                    const targetMesID = parsedMessage.mesID;
                    const sessionID = parsedMessage.sessionID;
                    if (!targetMesID || !sessionID) {
                        logger.warn('[Continue] Missing mesID or sessionID');
                        return;
                    }

                    // Load target message to identify character and validate it's AI
                    const targetRow = await db.getAIChatMessageRow(targetMesID, sessionID);
                    if (!targetRow || targetRow.entity !== 'AI') {
                        logger.warn('[Continue] Target row not found or not AI; aborting.');
                        return;
                    }

                    // Identify character entry by displayName
                    migrateSelectedCharactersIfNeeded(liveConfig);
                    const scArr = liveConfig.promptConfig.selectedCharacters || [];
                    const targetDisplay = (targetRow.username || '').trim();
                    let targetEntry = scArr.find(c => (c.displayName || '').trim() === targetDisplay);
                    // If not found among active selections, search the full card list on disk
                    if (!targetEntry) {
                        try {
                            const cardList = await fio.getCardList();
                            const found = (cardList || []).find(c => (c.name || '').trim() === targetDisplay);
                            if (found) {
                                targetEntry = { value: found.value, displayName: found.name, isMuted: false };
                            }
                        } catch (e) {
                            logger.warn('[Continue] Failed to load card list while resolving character:', e.message);
                        }
                    }
                    if (!targetEntry) {
                        // Send a targeted prompt to the requesting host to allow continuation without defs
                        ws.send(JSON.stringify({
                            type: 'continueMissingCharDefs',
                            targetDisplay,
                            mesID: targetMesID,
                            sessionID
                        }));
                        return;
                    }

                    // Restrict the effective chat context to messages up to (and including) target message
                    // We'll pass a special flag and target ID through parsedMessage so downstream can adjust
                    const originatingUser = await getLastUserMessageUsername() || null;
                    const continueMsg = {
                        type: 'requestAIResponse',
                        trigger: 'manual',
                        character: { value: targetEntry.value, displayName: targetEntry.displayName },
                        username: originatingUser,
                        // Special continuation targeting metadata
                        continueTarget: { sessionID, mesID: targetMesID }
                    };

                    // Bypass full queue; directly invoke single-character pipeline with shouldContinue true
                    liveConfig.promptConfig.selectedCharacter = targetEntry.value;
                    liveConfig.promptConfig.selectedCharacterDisplayName = targetEntry.displayName;
                    await stream.handleResponse(
                        { ...continueMsg, chatID: 'AIChat' }, selectedAPI, hordeKey,
                        engineMode, user, liveConfig, true, sessionID
                    );
                    return;
                }

                else if (parsedMessage.type === 'continueFromMessageNoDefs') {
                    if (thisUserRole !== 'host') {
                        logger.warn('Non-host attempted continueFromMessageNoDefs; ignoring.');
                        return;
                    }
                    const targetMesID = parsedMessage.mesID;
                    const sessionID = parsedMessage.sessionID;
                    if (!targetMesID || !sessionID) {
                        logger.warn('[ContinueNoDefs] Missing mesID or sessionID');
                        return;
                    }
                    const targetRow = await db.getAIChatMessageRow(targetMesID, sessionID);
                    if (!targetRow || targetRow.entity !== 'AI') {
                        logger.warn('[ContinueNoDefs] Target row not found or not AI; aborting.');
                        return;
                    }
                    const targetDisplay = (targetRow.username || '').trim();

                    // Proceed without definitions: we still need a char display name for macros
                    liveConfig.promptConfig.selectedCharacter = 'None';
                    liveConfig.promptConfig.selectedCharacterDisplayName = targetDisplay;
                    const originatingUser = await getLastUserMessageUsername() || null;

                    const continueMsg = {
                        type: 'requestAIResponse',
                        trigger: 'manual',
                        character: { value: 'None', displayName: targetDisplay },
                        username: originatingUser,
                        continueTarget: { sessionID, mesID: targetMesID },
                        skipCharDefs: true,
                        overrideCharName: targetDisplay
                    };
                    await stream.handleResponse(
                        { ...continueMsg, chatID: 'AIChat' }, selectedAPI, hordeKey,
                        engineMode, user, liveConfig, true, sessionID
                    );
                    return;
                }

                //TODO: merge this into clientStateChange
                else if (parsedMessage.type === 'modeChange') {
                    let hordeWorkerList
                    engineMode = parsedMessage.newMode
                    let modeChangeMessage = {
                        type: 'modeChange',
                        engineMode: engineMode
                    }
                    liveConfig.promptConfig.engineMode = engineMode
                    await fio.writeConfig(liveConfig, 'promptConfig.engineMode', engineMode)
                    if (engineMode === 'horde') {
                        modeChangeMessage.hordeWorkerList = await api.getHordeModelList(hordeKey)
                    }
                    await broadcast(modeChangeMessage, 'host');
                    return
                }
                else if (parsedMessage.type === 'pastChatsRequest') {
                    // Get room context for filtering past chats
                    const currentRoomId = getWsRoom(ws);
                    logger.info(`[pastChatsRequest] Room context: ${currentRoomId || 'NONE (global)'}`);
                    
                    const pastChats = await db.getPastChats('ai', currentRoomId);
                    logger.info(`[pastChatsRequest] Found ${Object.keys(pastChats).length} past chats for room ${currentRoomId || 'global'}`);
                    
                    const pastChatsListMessage = {
                        type: 'pastChatsList',
                        pastChats: pastChats,
                        roomId: currentRoomId
                    }
                    // Only send to requesting user (or room members if host)
                    if (currentRoomId) {
                        await broadcastToRoom(currentRoomId, pastChatsListMessage, 'host');
                    } else {
                        await broadcast(pastChatsListMessage, 'host');
                    }
                    return
                }
                else if (parsedMessage.type === 'loadPastChat') {
                    const currentRoomId = getWsRoom(ws);
                    const requestedSessionId = parsedMessage.session;
                    
                    // Validate session belongs to current room (prevent cross-room access)
                    const sessionInfo = await db.getSessionRoom(requestedSessionId);
                    if (currentRoomId && sessionInfo && sessionInfo.room_id !== currentRoomId) {
                        logger.warn(`[loadPastChat] User tried to load session ${requestedSessionId} from different room`);
                        ws.send(JSON.stringify({
                            type: 'roomError',
                            message: 'Cannot load chat from a different room',
                            action: 'loadPastChat'
                        }));
                        return;
                    }
                    
                    const [pastChat, sessionID] = await db.readAIChat(requestedSessionId, currentRoomId);
                    await db.setActiveChat(sessionID, currentRoomId);
                    let jsonArray = JSON.parse(pastChat);
                    const pastChatsLoadMessage = {
                        type: 'pastChatToLoad',
                        pastChatHistory: markdownifyChatHistoriesArray(jsonArray),
                        sessionID: sessionID,
                        roomId: currentRoomId
                    };
                    // Broadcast only to room members
                    if (currentRoomId) {
                        await broadcastToRoom(currentRoomId, pastChatsLoadMessage);
                    } else {
                        await broadcast(pastChatsLoadMessage);
                    }
                    return;
                }
                else if (parsedMessage.type === 'pastChatDelete') {
                    const currentRoomId = getWsRoom(ws);
                    const sessionID = parsedMessage.sessionID;
                    
                    // Validate session belongs to current room
                    const sessionInfo = await db.getSessionRoom(sessionID);
                    if (currentRoomId && sessionInfo && sessionInfo.room_id !== currentRoomId) {
                        logger.warn(`[pastChatDelete] User tried to delete session ${sessionID} from different room`);
                        ws.send(JSON.stringify({
                            type: 'roomError',
                            message: 'Cannot delete chat from a different room',
                            action: 'pastChatDelete'
                        }));
                        return;
                    }
                    
                    let [result, wasActive] = await db.deletePastChat(sessionID);
                    logger.debug('Past Chat Deletion: ', result, wasActive);
                    if (result === 'ok') {
                        const pastChatsDeleteConfirmation = {
                            type: 'pastChatDeleted',
                            wasActive: wasActive,
                            roomId: currentRoomId
                        };
                        // Broadcast only to room
                        if (currentRoomId) {
                            await broadcastToRoom(currentRoomId, pastChatsDeleteConfirmation, 'host');
                        } else {
                            await broadcast(pastChatsDeleteConfirmation, 'host');
                        }
                        return;
                    } else {
                        return;
                    }
                }
                //MARK: message Delete
                else if (parsedMessage.type === 'messageDelete') {
                    logger.info('saw messageDelete request from host', parsedMessage)
                    let result

                    if (parsedMessage.deleteType == 'userChat') {
                        await removeAnyUserChatMessage(parsedMessage);
                        return
                    }


                    if (parsedMessage.deleteType == 'AIChat') {
                        await removeAnyAIChatMessage(parsedMessage);
                        return
                    }
                    return
                }
                else if (parsedMessage.type === 'messageContentRequest') {
                    const messageContent = await db.getMessage(parsedMessage.mesID, parsedMessage.sessionID)
                    if (!messageContent) {
                        logger.error('No message found for message ID:', parsedMessage.mesID);
                    }
                    //logger.info('saw messageContentRequest for: sessionID', parsedMessage.sessionID, 'and mesID', parsedMessage.mesID)
                    const messageContentResponse = {
                        type: 'messageContentResponse',
                        content: messageContent,
                        sessionID: parsedMessage.sessionID,
                        mesID: parsedMessage.mesID
                    }
                    ws.send(JSON.stringify(messageContentResponse), 'host')
                    return
                }
                else if (parsedMessage.type === 'messageEdit') {
                    //logger.info('saw messageEditRequest for: sessionID', parsedMessage.sessionID, 'and mesID', parsedMessage.mesID)
                    const mesID = parsedMessage.mesID
                    const sessionID = parsedMessage.sessionID
                    const newMessage = parsedMessage.newMessageContent

                    const result = await db.editMessage(sessionID, mesID, newMessage)
                    if (result === 'ok') {
                        const [pastChat, uselessSessionID] = await db.readAIChat(sessionID)
                        let jsonArray = JSON.parse(pastChat)
                        const pastChatsLoadMessage = {
                            type: 'pastChatToLoad',
                            pastChatHistory: markdownifyChatHistoriesArray(jsonArray),
                            sessionID: sessionID
                        }
                        await broadcast(pastChatsLoadMessage)
                        return
                    } else {
                        logger.error('could not update message with new edits')
                        return
                    }
                }
                else if (parsedMessage.type === 'hostToastRequest') {
                    const hostToastMessage = {
                        type: 'hostToastResponse',
                        content: purifier.makeHtml(parsedMessage.message),
                        username: thisUserUsername
                    }
                    await broadcast(hostToastMessage)
                    return

                }
                else if (parsedMessage.type === 'cardListRequest') {
                    cardList = await fio.getCardList()
                    logger.info('New Card List: ', cardList)
                    const cardListResponse = {
                        type: 'cardListResponse',
                        cardList: cardList
                    }
                    await broadcast(cardListResponse, 'host')
                    return
                }

                else if (parsedMessage.type === 'disableGuestInput') {
                    //logger.info('saw disableGuestInput request from host')
                    liveConfig.crowdControl.guestInputPermissionState = false
                    await fio.writeConfig(liveConfig, 'crowdControl.guestInputPermissionState', false)
                    const disableGuestInputMessage = {
                        type: 'toggleGuestInputState',
                        allowed: liveConfig.crowdControl.guestInputPermissionState
                    }
                    await broadcast(disableGuestInputMessage)
                    return
                }
                else if (parsedMessage.type === 'allowGuestInput') {
                    liveConfig.crowdControl.guestInputPermissionState = true
                    await fio.writeConfig(liveConfig, 'crowdControl.guestInputPermissionState', true)
                    //logger.info('saw allowGuestInput request from host')
                    const allowGuestInputMessage = {
                        type: 'toggleGuestInputState',
                        allowed: liveConfig.crowdControl.guestInputPermissionState
                    }
                    await broadcast(allowGuestInputMessage)
                    return
                }

                // ================================
                // LOREBOOK / WORLD INFO HANDLERS
                // ================================
                
                else if (parsedMessage.type === 'getLorebooksRequest') {
                    const lorebooks = await db.getLorebooks();
                    ws.send(JSON.stringify({
                        type: 'lorebooksResponse',
                        lorebooks: lorebooks
                    }));
                    return;
                }

                else if (parsedMessage.type === 'createLorebook') {
                    const { name, description } = parsedMessage;
                    const lorebook = await db.createLorebook(name || 'New Lorebook', description || '');
                    ws.send(JSON.stringify({
                        type: 'lorebookCreated',
                        lorebook: lorebook
                    }));
                    return;
                }

                else if (parsedMessage.type === 'updateLorebook') {
                    const { lorebookId, updates } = parsedMessage;
                    const lorebook = await db.updateLorebook(lorebookId, updates);
                    ws.send(JSON.stringify({
                        type: 'lorebookUpdated',
                        lorebook: lorebook
                    }));
                    return;
                }

                else if (parsedMessage.type === 'deleteLorebook') {
                    const { lorebookId } = parsedMessage;
                    await db.deleteLorebook(lorebookId);
                    ws.send(JSON.stringify({
                        type: 'lorebookDeleted',
                        lorebookId: lorebookId
                    }));
                    return;
                }

                else if (parsedMessage.type === 'getLorebookEntriesRequest') {
                    const { lorebookId } = parsedMessage;
                    const entries = await db.getLorebookEntries(lorebookId);
                    ws.send(JSON.stringify({
                        type: 'lorebookEntriesResponse',
                        lorebookId: lorebookId,
                        entries: entries
                    }));
                    return;
                }

                else if (parsedMessage.type === 'createLorebookEntry') {
                    const { lorebookId, entryData } = parsedMessage;
                    const entry = await db.createLorebookEntry(lorebookId, entryData);
                    ws.send(JSON.stringify({
                        type: 'lorebookEntryCreated',
                        entry: entry
                    }));
                    return;
                }

                else if (parsedMessage.type === 'updateLorebookEntry') {
                    const { entryId, updates } = parsedMessage;
                    const entry = await db.updateLorebookEntry(entryId, updates);
                    ws.send(JSON.stringify({
                        type: 'lorebookEntryUpdated',
                        entry: entry
                    }));
                    return;
                }

                else if (parsedMessage.type === 'deleteLorebookEntry') {
                    const { entryId } = parsedMessage;
                    await db.deleteLorebookEntry(entryId);
                    ws.send(JSON.stringify({
                        type: 'lorebookEntryDeleted',
                        entryId: entryId
                    }));
                    return;
                }
            }

            //process universal message types that all users can send
            //MARK: Universal WS Msgs
            
            // ================================
            // ROOM MANAGEMENT HANDLERS - Critical for message isolation
            // ================================
            
            if (parsedMessage.type === 'listRooms') {
                const rooms = await db.getAllActiveRooms();
                ws.send(JSON.stringify({
                    type: 'roomsList',
                    rooms: rooms.map(r => ({
                        room_id: r.room_id,
                        name: r.name,
                        description: r.description,
                        member_count: r.member_count,
                        member_names: r.member_names,
                        created_at: r.created_at
                    }))
                }));
                return;
            }
            
            else if (parsedMessage.type === 'createRoom') {
                const { name, description } = parsedMessage;
                
                if (!name || name.trim().length === 0) {
                    ws.send(JSON.stringify({
                        type: 'roomError',
                        message: 'Room name is required',
                        action: 'createRoom'
                    }));
                    return;
                }
                
                if (name.length > 50) {
                    ws.send(JSON.stringify({
                        type: 'roomError',
                        message: 'Room name must be 50 characters or less',
                        action: 'createRoom'
                    }));
                    return;
                }
                
                try {
                    const room = await db.createRoom(
                        name.trim(),
                        description || '',
                        uuid,
                        {} // Initial settings (empty, uses global defaults)
                    );
                    
                    // Associate this WebSocket with the new room
                    setWsRoom(ws, room.room_id, uuid);
                    
                    // Get room's active session for chat history
                    const sessionId = await db.getRoomActiveSession(room.room_id, 'ai');
                    
                    ws.send(JSON.stringify({
                        type: 'roomCreated',
                        room: room,
                        sessionId: sessionId
                    }));
                    
                    // Broadcast updated room list to everyone
                    const rooms = await db.getAllActiveRooms();
                    broadcast({
                        type: 'roomsList',
                        rooms: rooms.map(r => ({
                            room_id: r.room_id,
                            name: r.name,
                            description: r.description,
                            member_count: r.member_count,
                            member_names: r.member_names,
                            created_at: r.created_at
                        }))
                    });
                    
                    logger.info(`[Room] User ${clientsObject[uuid]?.username || uuid} created room "${name}"`);
                } catch (err) {
                    logger.error('[createRoom] Error:', err);
                    ws.send(JSON.stringify({
                        type: 'roomError',
                        message: 'Failed to create room',
                        action: 'createRoom'
                    }));
                }
                return;
            }
            
            else if (parsedMessage.type === 'joinRoom') {
                const { roomId } = parsedMessage;
                
                if (!roomId) {
                    ws.send(JSON.stringify({
                        type: 'roomError',
                        message: 'Room ID is required',
                        action: 'joinRoom'
                    }));
                    return;
                }
                
                try {
                    // Check room exists
                    const room = await db.getRoomById(roomId);
                    if (!room) {
                        ws.send(JSON.stringify({
                            type: 'roomError',
                            message: 'Room not found',
                            action: 'joinRoom'
                        }));
                        return;
                    }
                    
                    // Leave current room if in one
                    const currentRoom = getWsRoom(ws);
                    if (currentRoom) {
                        await db.removeRoomMember(currentRoom, uuid);
                        removeWsFromRoom(ws);
                        
                        // Notify old room members
                        broadcastToRoom(currentRoom, {
                            type: 'memberLeft',
                            userId: uuid,
                            username: thisUserUsername
                        });
                    }
                    
                    // Add to new room
                    await db.addRoomMember(roomId, uuid, 'member');
                    setWsRoom(ws, roomId, uuid);
                    
                    // Get room members
                    const members = await db.getRoomMembers(roomId);
                    
                    // Get room's chat history
                    const sessionId = await db.getRoomActiveSession(roomId, 'ai');
                    let chatHistory = [];
                    if (sessionId) {
                        const [chatData] = await db.readAIChat(sessionId);
                        chatHistory = JSON.parse(chatData || '[]');
                    }
                    
                    // Get room's user chat history
                    // TODO: Add room-scoped user chat reading
                    
                    // Get room config
                    const roomConfig = await getRoomConfig(roomId);
                    
                    // Get room's past chats for the control panel
                    const pastChats = await db.getPastChats('ai', roomId);
                    
                    ws.send(JSON.stringify({
                        type: 'roomJoined',
                        room: {
                            room_id: room.room_id,
                            name: room.name,
                            description: room.description,
                            settings: room.settings || {}
                        },
                        members: members.map(m => ({
                            user_id: m.user_id,
                            username: m.username,
                            username_color: m.username_color,
                            role: m.role
                        })),
                        chatHistory: markdownifyChatHistoriesArray(chatHistory),
                        sessionId: sessionId,
                        config: roomConfig,
                        pastChats: pastChats // Include room-specific past chats
                    }));
                    
                    // Notify other room members
                    broadcastToRoom(roomId, {
                        type: 'memberJoined',
                        userId: uuid,
                        username: thisUserUsername,
                        userColor: await db.getUserColor(uuid)
                    });
                    
                    // Update room list for everyone
                    const rooms = await db.getAllActiveRooms();
                    broadcast({
                        type: 'roomsList',
                        rooms: rooms.map(r => ({
                            room_id: r.room_id,
                            name: r.name,
                            description: r.description,
                            member_count: r.member_count,
                            member_names: r.member_names,
                            created_at: r.created_at
                        }))
                    });
                    
                    logger.info(`[Room] User ${thisUserUsername} joined room "${room.name}"`);
                } catch (err) {
                    logger.error('[joinRoom] Error:', err);
                    ws.send(JSON.stringify({
                        type: 'roomError',
                        message: 'Failed to join room',
                        action: 'joinRoom'
                    }));
                }
                return;
            }
            
            else if (parsedMessage.type === 'leaveRoom') {
                const currentRoom = getWsRoom(ws);
                
                if (!currentRoom) {
                    ws.send(JSON.stringify({
                        type: 'roomError',
                        message: 'Not currently in a room',
                        action: 'leaveRoom'
                    }));
                    return;
                }
                
                try {
                    // Leave the room
                    await db.removeRoomMember(currentRoom, uuid);
                    removeWsFromRoom(ws);
                    
                    ws.send(JSON.stringify({
                        type: 'roomLeft',
                        roomId: currentRoom
                    }));
                    
                    // Notify remaining room members
                    broadcastToRoom(currentRoom, {
                        type: 'memberLeft',
                        userId: uuid,
                        username: thisUserUsername
                    });
                    
                    // Update room list for everyone
                    const rooms = await db.getAllActiveRooms();
                    broadcast({
                        type: 'roomsList',
                        rooms: rooms.map(r => ({
                            room_id: r.room_id,
                            name: r.name,
                            description: r.description,
                            member_count: r.member_count,
                            member_names: r.member_names,
                            created_at: r.created_at
                        }))
                    });
                    
                    logger.info(`[Room] User ${thisUserUsername} left room ${currentRoom}`);
                } catch (err) {
                    logger.error('[leaveRoom] Error:', err);
                    ws.send(JSON.stringify({
                        type: 'roomError',
                        message: 'Failed to leave room',
                        action: 'leaveRoom'
                    }));
                }
                return;
            }
            
            else if (parsedMessage.type === 'roomSettingsUpdate') {
                const { settings } = parsedMessage;
                const currentRoom = getWsRoom(ws);
                
                if (!currentRoom) {
                    ws.send(JSON.stringify({
                        type: 'roomError',
                        message: 'Not currently in a room',
                        action: 'roomSettingsUpdate'
                    }));
                    return;
                }
                
                try {
                    // Check user has permission (creator or moderator)
                    const role = await db.getUserRoomRole(currentRoom, uuid);
                    if (role !== 'creator' && role !== 'moderator' && thisUserRole !== 'host') {
                        ws.send(JSON.stringify({
                            type: 'roomError',
                            message: 'You do not have permission to update room settings',
                            action: 'roomSettingsUpdate'
                        }));
                        return;
                    }
                    
                    await setRoomConfig(currentRoom, settings);
                    
                    // Broadcast to all room members
                    broadcastToRoom(currentRoom, {
                        type: 'roomSettingsChanged',
                        settings: settings
                    });
                    
                    logger.info(`[Room] Settings updated for room ${currentRoom} by ${thisUserUsername}`);
                } catch (err) {
                    logger.error('[roomSettingsUpdate] Error:', err);
                    ws.send(JSON.stringify({
                        type: 'roomError',
                        message: 'Failed to update room settings',
                        action: 'roomSettingsUpdate'
                    }));
                }
                return;
            }
            
            else if (parsedMessage.type === 'deleteRoom') {
                const { roomId } = parsedMessage;
                const targetRoom = roomId || getWsRoom(ws);
                
                if (!targetRoom) {
                    ws.send(JSON.stringify({
                        type: 'roomError',
                        message: 'No room specified',
                        action: 'deleteRoom'
                    }));
                    return;
                }
                
                try {
                    // Check user has permission (creator only, or host)
                    const role = await db.getUserRoomRole(targetRoom, uuid);
                    if (role !== 'creator' && thisUserRole !== 'host') {
                        ws.send(JSON.stringify({
                            type: 'roomError',
                            message: 'Only the room creator can delete a room',
                            action: 'deleteRoom'
                        }));
                        return;
                    }
                    
                    // Notify all room members before deletion
                    broadcastToRoom(targetRoom, {
                        type: 'roomDeleted',
                        roomId: targetRoom,
                        message: 'This room has been deleted'
                    });
                    
                    // Soft delete the room
                    await db.deleteRoom(targetRoom);
                    
                    // Clear room state
                    roomsState.delete(targetRoom);
                    roomConfigs.delete(targetRoom);
                    
                    // Update room list for everyone
                    const rooms = await db.getAllActiveRooms();
                    broadcast({
                        type: 'roomsList',
                        rooms: rooms.map(r => ({
                            room_id: r.room_id,
                            name: r.name,
                            description: r.description,
                            member_count: r.member_count,
                            member_names: r.member_names,
                            created_at: r.created_at
                        }))
                    });
                    
                    logger.info(`[Room] Room ${targetRoom} deleted by ${thisUserUsername}`);
                } catch (err) {
                    logger.error('[deleteRoom] Error:', err);
                    ws.send(JSON.stringify({
                        type: 'roomError',
                        message: 'Failed to delete room',
                        action: 'deleteRoom'
                    }));
                }
                return;
            }
            
            // ================================
            // USER AUTHENTICATION HANDLERS
            // ================================
            
            if (parsedMessage.type === 'checkUsername') {
                const available = await db.checkUsernameAvailable(parsedMessage.username);
                ws.send(JSON.stringify({
                    type: 'checkUsernameResponse',
                    username: parsedMessage.username,
                    available: available
                }));
                return;
            }

            else if (parsedMessage.type === 'registerUser') {
                const { username, password, email } = parsedMessage;
                
                // Validate input
                if (!username || username.length < 3 || username.length > 20) {
                    ws.send(JSON.stringify({
                        type: 'registerResponse',
                        success: false,
                        error: 'Username must be 3-20 characters'
                    }));
                    return;
                }
                if (!password || password.length < 6) {
                    ws.send(JSON.stringify({
                        type: 'registerResponse',
                        success: false,
                        error: 'Password must be at least 6 characters'
                    }));
                    return;
                }
                
                const result = await db.registerUser(username, password, email || null);
                ws.send(JSON.stringify({
                    type: 'registerResponse',
                    ...result
                }));
                return;
            }

            else if (parsedMessage.type === 'loginUser') {
                const { username, password } = parsedMessage;
                
                if (!username || !password) {
                    ws.send(JSON.stringify({
                        type: 'loginResponse',
                        success: false,
                        error: 'Username and password are required'
                    }));
                    return;
                }
                
                const result = await db.authenticateUser(username, password);
                ws.send(JSON.stringify({
                    type: 'loginResponse',
                    ...result
                }));
                return;
            }

            // Handle identity update after login (preserves session and host status)
            else if (parsedMessage.type === 'identityUpdate') {
                logger.info(`[identityUpdate] Updating identity for ${thisUserUsername}: new UUID ${parsedMessage.newUUID}`);
                
                // Update the client's UUID mapping
                const oldUUID = uuid;
                const newUUID = parsedMessage.newUUID;
                
                // Transfer client data to new UUID while preserving role
                if (clientsObject[oldUUID]) {
                    clientsObject[newUUID] = {
                        ...clientsObject[oldUUID],
                        username: parsedMessage.username
                    };
                    delete clientsObject[oldUUID];
                }
                
                // Update the closure variables
                uuid = newUUID;
                thisUserUsername = parsedMessage.username;
                
                // Update user in database, preserving their role
                await db.upsertUser(newUUID, parsedMessage.username, userColor, parsedMessage.persona || '');
                
                // Preserve host role if they were host
                if (thisUserRole === 'host') {
                    await db.upsertUserRole(newUUID, 'host');
                }
                
                updateConnectedUsers();
                await broadcastUserList();
                
                logger.info(`[identityUpdate] Identity updated successfully for ${parsedMessage.username}`);
                return;
            }

            if (parsedMessage.type === 'usernameChange') {

                //logger.info(parsedMessage)
                clientsObject[uuid].username = parsedMessage.newName;
                updateConnectedUsers()
                await db.upsertUser(parsedMessage.UUID, parsedMessage.newName, user.color ? user.color : thisClientObj.color, user?.persona || clientsObject[parsedMessage.UUID]?.persona || '')
                const nameChangeNotification = {
                    type: 'userChangedName',
                    content: `[System]: ${parsedMessage.oldName} >>> ${parsedMessage.newName} (@AI: ${parsedMessage.AIChatUsername})`
                }
                logger.debug('Broadcasting username change notification.')
                await broadcast(nameChangeNotification);
                await broadcastUserList()
            }
            else if (parsedMessage.type === "fileUpload") {
                const result = await fio.validateAndAcceptPNGUploads(parsedMessage);
                logger.info('file upload result: ', (result))
                if (result.status === 'error') {
                    const response = {
                        type: "fileUploadError",
                        message: result.response
                    }
                    await broadcast(response, 'host')
                    return
                }
                if (result.status === 'ok') {
                    const response = {
                        type: "fileUploadSuccess",
                        message: result.response,
                    }
                    //console.warn('file upload response: ', response)
                    await ws.send(JSON.stringify(response))
                    await broadcast(response, 'host')
                    return

                }
            }
            else if (parsedMessage.type === 'heartbeat') {
                let heartbeatResponse = {
                    type: 'heartbeatResponse',
                    value: 'pong!'
                }
                //only send back to the user who is doing the test.
                await ws.send(JSON.stringify(heartbeatResponse))
                return
            }
            else if (parsedMessage.type === 'submitKey') {
                if (parsedMessage.key === hostKey) {
                    const keyAcceptedMessage = {
                        type: 'keyAccepted',
                        role: 'host'
                    }
                    await db.upsertUserRole(uuid, 'host');
                    await ws.send(JSON.stringify(keyAcceptedMessage))
                }
                else if (parsedMessage.key === modKey) {
                    const keyAcceptedMessage = {
                        type: 'keyAccepted',
                        role: 'mod'
                    }
                    await db.upsertUserRole(uuid, 'mod');
                    await ws.send(JSON.stringify(keyAcceptedMessage))
                }
                else {
                    const keyRejectedMessage = {
                        type: 'keyRejected'
                    }
                    logger.error(`Key rejected: ${parsedMessage.key} from ${senderUUID}`)
                    await ws.send(JSON.stringify(keyRejectedMessage))
                }
            }

            //MARK: 'chatMesasge' type
            else if (parsedMessage.type === 'chatMessage') { //handle normal chat messages
                //logger.warn('guestInputPermissionState: ', liveConfig.crowdControl.guestInputPermissionState)
                //logger.warn('thisUserRole: ', thisUserRole)
                //having this enable sends the user's colors along with the response message if it uses parsedMessage as the base..
                parsedMessage.userColor = thisUserColor
                const chatID = parsedMessage.chatID;
                const username = parsedMessage.username
                const userColor = thisUserColor
                let userInput = parsedMessage?.userInput
                const hordePrompt = parsedMessage?.userInput
                const senderUUID = parsedMessage.UUID
                const canPost = liveConfig.crowdControl.guestInputPermissionState;
                var userPrompt
                
                // Get room context for message isolation
                const currentRoomId = getWsRoom(ws);

                if (!canPost && thisUserRole !== 'host') {
                    //get their username from the clientsObject
                    let thisUser = clientsObject[senderUUID];
                    logger.warn('Guest input is disabled, ignoring message from:', thisUser.username);
                    const guestInputDisabledMessage = {
                        type: 'inputDisabledWarning',
                        message: `Guest input is currently disabled by the host. Please wait until it is enabled again.`,
                    }
                    await ws.send(JSON.stringify(guestInputDisabledMessage));
                    return
                }

                //setup the userPrompt array in order to send the input into the AIChat box
                if (chatID === 'AIChat') {
                    let userTryingToContinue = parsedMessage.userInput.length == 0 ? true : false
                    if (userTryingToContinue) {
                        logger.info('User is trying to continue the AI response...');
                    }
                    let [currentChat, sessionID] = await db.readAIChat(null, currentRoomId)
                    let messageHistory = JSON.parse(currentChat)
                    let lastMessageEntity = messageHistory[messageHistory.length - 1]?.entity || 'Unknown' //in the case of message sent in empty chat
                    let shouldContinue = userTryingToContinue && lastMessageEntity === 'AI' ? true : false
                    //if the message isn't empty (i.e. not a forced AI trigger), then add it to AIChat
                    //this can be the case when a previous chat is wiped, and we need to force send
                    //the character's firstMessage into the new chat session.
                    if (!shouldContinue && userInput && userInput.length > 0) {
                        userInput = userInput.slice(0, 1000); //force respect the message size limit
                        // Pass roomId to writeAIChatMessage for room-scoped sessions
                        await db.writeAIChatMessage(username, senderUUID, userInput, 'user', currentRoomId);
                        let [activeChat, foundSessionID] = await db.readAIChat(null, currentRoomId)
                        var chatJSON = JSON.parse(activeChat)
                        var lastItem = chatJSON[chatJSON.length - 1]
                        var newMessageID = lastItem?.messageID
                        var content = purifier.makeHtml(parsedMessage.userInput)
                        //logger.info('Input from: ', username, ' Content: ', content)

                        userPrompt = {
                            type: 'chatMessage',
                            chatID: chatID,
                            username: username,
                            content: content, //content,
                            userColor: userColor,
                            sessionID: foundSessionID,
                            messageID: newMessageID,
                            entity: 'user',
                            role: thisUserRole,
                            timestamp: lastItem?.timestamp || new Date().toISOString(),
                            roomId: currentRoomId // Include room context
                        }
                        
                        // CRITICAL: Use room-scoped broadcast if in a room
                        if (currentRoomId) {
                            await broadcastToRoom(currentRoomId, userPrompt);
                        } else {
                            // Fallback to global broadcast for backward compatibility
                            await broadcast(userPrompt)
                        }
                    }

                    if (
                        (liveConfig.promptConfig.isAutoResponse) ||
                        (!liveConfig.promptConfig.isAutoResponse && (!userInput || userInput.length == 0)) ||
                        shouldContinue
                    ) {
                        // Multi-character aware auto trigger: treat as 'auto'
                        const aiTriggerMsg = {
                            type: 'requestAIResponse',
                            trigger: shouldContinue ? 'manual' : 'auto',
                            latestUserMessageText: parsedMessage.userInput || '',
                            latestUserMessageID: userPrompt?.messageID,
                            mesID: userPrompt?.messageID,
                            username: username, // preserve user name for macro replacement
                            roomId: currentRoomId // Include room context for AI response
                        };
                        await handleRequestAIResponse(aiTriggerMsg, user, selectedAPI, hordeKey, engineMode, liveConfig, ws);
                    }
                }
                //read the current userChat file
                if (chatID === 'userChat') {
                    parsedMessage.content = parsedMessage.content.slice(0, 1000); //force respect the message size limit
                    // TODO: Pass roomId to writeUserChatMessage when room-scoped sessions are ready
                    await db.writeUserChatMessage(uuid, parsedMessage.content)
                    let [newdata, sessionID] = await db.readUserChat()
                    let newJsonArray = JSON.parse(newdata);
                    let lastItem = newJsonArray[newJsonArray.length - 1]
                    let newMessageID = lastItem?.messageID
                    let newContent = lastItem?.content

                    const newUserChatMessage = {
                        type: 'chatMessage',
                        chatID: chatID,
                        username: username,
                        userColor: userColor,
                        content: purifier.makeHtml(newContent),
                        messageID: newMessageID,
                        sessionID: sessionID,
                        role: thisUserRole,
                        entity: 'user',
                        timestamp: lastItem?.timestamp || new Date().toISOString(),
                        roomId: currentRoomId // Include room context
                    }
                    //logger.info(newUserChatMessage)
                    
                    // CRITICAL: Use room-scoped broadcast if in a room
                    if (currentRoomId) {
                        await broadcastToRoom(currentRoomId, newUserChatMessage);
                    } else {
                        // Fallback to global broadcast for backward compatibility
                        await broadcast(newUserChatMessage)
                    }
                }

            } else {
                logger.warn(`Unknown message type received (${parsedMessage.type}). Ignoring.`)
            }

            // Global (non-host) direct requestAIResponse support (e.g., future mod actions) - only if host not already processed
            if (parsedMessage.type === 'requestAIResponse' && thisUserRole !== 'host') {
                logger.info('[Queue] Non-host requestAIResponse received; forwarding to handler (permissions may be restricted in future).');
                await handleRequestAIResponse(parsedMessage, user, selectedAPI, hordeKey, engineMode, liveConfig, ws);
            }
        } catch (error) {
            logger.error('Error parsing message:', error);
            return;
        }
    });

    // Handle WebSocket close
    ws.on('close', async () => {
        // Remove the disconnected client from the clientsObject
        logger.info(`Client ${uuid} disconnected..removing from clientsObject`);
        delete clientsObject[uuid];
        updateConnectedUsers();
        await broadcastUserList();

        // Room cleanup - remove user from any room they're in
        const roomId = getWsRoom(ws);
        if (roomId) {
            try {
                await db.removeRoomMember(roomId, uuid);
                removeWsFromRoom(ws);
                
                // Notify remaining room members
                broadcastToRoom(roomId, {
                    type: 'memberLeft',
                    userId: uuid,
                    username: clientsObject[uuid]?.username || 'Unknown',
                    reason: 'disconnect'
                });
                
                logger.info(`[Room] User ${uuid} auto-left room ${roomId} on disconnect`);
            } catch (err) {
                logger.error('[Room] Error during disconnect cleanup:', err);
            }
        }

        // Decrement IP connection count
        const updatedConnections = (ipConnectionMap.get(clientIP) || 1) - 1;
        if (updatedConnections <= 0) {
            ipConnectionMap.delete(clientIP);
        } else {
            ipConnectionMap.set(clientIP, updatedConnections);
        }
        logger.info(`Connection closed. IP ${clientIP} now has ${updatedConnections} active connections`);
    });

};

function markdownifyChatHistoriesArray(chatMessagesArray) {
    let parsedArray;

    // 1. Handle full array passed as JSON string
    if (typeof chatMessagesArray === 'string') {
        try {
            parsedArray = JSON.parse(chatMessagesArray);
        } catch (e) {
            console.error('Failed to parse full JSON string:', e);
            return [];
        }
    } else if (Array.isArray(chatMessagesArray)) {
        // 2. Handle array of strings or objects
        parsedArray = chatMessagesArray.map(entry => {
            if (typeof entry === 'string') {
                try {
                    return JSON.parse(entry);
                } catch (e) {
                    console.warn('Skipping invalid JSON string in array:', entry);
                    return null;
                }
            } else if (typeof entry === 'object' && entry !== null) {
                return entry; // Already an object
            } else {
                console.warn('Skipping invalid item in array:', entry);
                return null;
            }
        }).filter(Boolean); // remove nulls
    } else {
        console.error('Input is not a valid string or array.');
        return [];
    }

    // 3. Now convert the `content` field using markdown
    for (let msg of parsedArray) {
        if (msg && typeof msg.content === 'string') {
            msg.content = purifier.makeHtml(msg.content);
        }
    }

    return parsedArray;
}


//checks an incoming liveConfig from client for changes to the APIList, and adjust server's list and db-registered APIs to match it.
async function checkAPIListChanges(liveConfig, parsedMessage) {
    // Defensively coerce to arrays to avoid null/undefined issues
    const serverAPIs = Array.isArray(liveConfig?.promptConfig?.APIList) ? liveConfig.promptConfig.APIList : [];
    const clientAPIs = Array.isArray(parsedMessage?.value?.promptConfig?.APIList) ? parsedMessage.value.promptConfig.APIList : [];

    // Quick check for identical lists
    if (serverAPIs.length === clientAPIs.length &&
        serverAPIs.every((sAPI, i) => isAPIEqual(sAPI, clientAPIs[i]))) {
        logger.info('No changes detected in API lists; skipping update.');
        return; // No changes
    }

    logger.info('Detected changes in API lists');

    try {
        // Map APIs by name for efficient lookup
        const serverAPIMap = new Map(serverAPIs.map(api => [api.name, api]));
        const clientAPIMap = new Map(clientAPIs.map(api => [api.name, api]));

        // 1. Handle deletions
        const deletedAPIs = serverAPIs.filter(sAPI => !clientAPIMap.has(sAPI.name));
        if (deletedAPIs.length > 0) {
            logger.warn(`Deleting ${deletedAPIs.length} APIs no longer in client list: ${deletedAPIs.map(a => a.name).join(', ')}`);
            for (const api of deletedAPIs) {
                try {
                    await db.deleteAPI(api.name);
                    if (parsedMessage.value.promptConfig.selectedAPI === api.name) {
                        parsedMessage.value.promptConfig.selectedAPI = 'Default';
                    }
                } catch (err) {
                    logger.error(`Failed to delete API ${api.name}:`, err);
                }
            }
            liveConfig.promptConfig.APIList = serverAPIs.filter(sAPI => !deletedAPIs.includes(sAPI));
        }

        // 2. Handle additions and updates
        const changedAPIs = [];
        for (const clientAPI of clientAPIs) {
            const serverAPI = serverAPIMap.get(clientAPI.name);
            if (!serverAPI) {
                // New API
                logger.info(`Adding new API: ${clientAPI.name}`);
                changedAPIs.push(clientAPI);
            } else if (!isAPIEqual(serverAPI, clientAPI)) {
                // Updated API
                logger.info(`Updating API: ${clientAPI.name}`);
                changedAPIs.push(clientAPI);
            }
        }

        // Batch upsert for additions and updates
        if (changedAPIs.length > 0) {
            logger.info(`Upserting ${changedAPIs.length} APIs: ${changedAPIs.map(a => a.name).join(', ')}`);
            for (const api of changedAPIs) {
                try {
                    // Enrich with existing server-side fields so required DB columns are present
                    const existing = serverAPIMap.get(api.name) || {};
                    const enriched = {
                        ...existing,
                        ...api,
                        // Preserve existing modelList/selectedModel if not provided by client
                        modelList: api.modelList !== undefined ? api.modelList : (existing.modelList || []),
                        selectedModel: api.selectedModel !== undefined ? api.selectedModel : (existing.selectedModel || ''),
                        claude: api.claude !== undefined ? api.claude : !!existing.claude,
                        useTokenizer: api.useTokenizer !== undefined ? api.useTokenizer : !!existing.useTokenizer,
                        created_at: existing.created_at || new Date().toISOString(),
                    };
                    await db.upsertAPI(enriched);
                } catch (err) {
                    logger.error(`Failed to upsert API ${api.name}:`, err);
                }
            }
            liveConfig.promptConfig.APIList = [...clientAPIs]; // Update server list
        }
    } catch (err) {
        logger.error('Error processing API list changes:', err);
    }
}

// Helper function to compare APIs
function isAPIEqual(api1, api2) {
    if (!api1 || !api2) return false;
    if (api1.name !== api2.name) return false;
    // Compare over the union of keys to detect newly added fields (e.g., useTokenizer)
    const skip = new Set(['created_at', 'last_used']);
    const keys = new Set([...Object.keys(api1 || {}), ...Object.keys(api2 || {})]);
    for (const key of keys) {
        if (skip.has(key)) continue;
        if (key === 'modelList') {
            const a = JSON.stringify(api1.modelList || []);
            const b = JSON.stringify(api2.modelList || []);
            if (a !== b) return false;
            continue;
        }
        const aVal = api1[key];
        const bVal = api2[key];
        // Normalize booleans potentially undefined
        if (key === 'claude' || key === 'useTokenizer') {
            const aBool = !!aVal; const bBool = !!bVal;
            if (aBool !== bBool) return false;
            continue;
        }
        if (aVal !== bVal) return false;
    }
    return true;
}

// Handle server shutdown via ctrl+c
process.on('SIGINT', async () => {
    logger.info('Server shutting down...');

    // Send a message to all connected clients
    const serverShutdownMessage = {
        type: 'forceDisconnect',
    };
    broadcast(serverShutdownMessage);

    //give a delay to make sure the shutdown message is sent to all users
    await delay(1000)

    // Close the WebSocket server
    wsServer.close(() => {
        logger.info('Host websocket closed.');
    });
    wssServer.close(() => {
        logger.info('Guest websocket closed.');
    });
    process.exit(0);
});

export default {
    broadcast
}
