import pg from 'pg';
const { Pool } = pg;
import { dbLogger as logger } from './log.js';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';

// PostgreSQL Configuration
const connectionString = process.env.DATABASE_URL || 'postgres://postgres:2330@localhost:5432/stmp';

const pool = new Pool({
    connectionString,
    max: 20, // Max number of clients in the pool
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

pool.on('error', (err, client) => {
    logger.error('Unexpected error on idle client', err);
    process.exit(-1);
});

// Helper to query directly (for reads)
const query = (text, params) => pool.query(text, params);

// Helper for transactions or complex atomic operations
const getClient = () => pool.connect();

// Global Room ID constant - used for migration and fallback
const GLOBAL_ROOM_ID = 'global-room-00000000-0000-0000-0000-000000000000';

const schemaDictionary = {
    // Room tables for message isolation
    rooms: {
        room_id: "TEXT UNIQUE PRIMARY KEY",
        name: "TEXT NOT NULL",
        description: "TEXT",
        created_by: "TEXT",
        created_at: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
        settings: "TEXT", // JSON: room-specific config
        is_active: "BOOLEAN DEFAULT TRUE", // Soft delete flag
        // foreign keys defined separately
    },
    room_members: {
        id: "SERIAL PRIMARY KEY", // Changed from INTEGER PRIMARY KEY
        room_id: "TEXT NOT NULL",
        user_id: "TEXT NOT NULL",
        joined_at: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
        role: "TEXT DEFAULT 'member'", // 'creator', 'moderator', 'member'
    },
    users: {
        user_id: "TEXT UNIQUE PRIMARY KEY",
        username: "TEXT",
        username_color: "TEXT",
        persona: "TEXT",
        password_hash: "TEXT", // bcrypt hashed password (null for legacy/anonymous users)
        email: "TEXT", // Optional email for account recovery
        created_at: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
        last_seen_at: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"
    },
    user_roles: {
        user_id: "TEXT UNIQUE PRIMARY KEY",
        role: "TEXT DEFAULT 'user'",
    },
    characters: {
        char_id: "TEXT UNIQUE PRIMARY KEY",
        displayname: "TEXT",
        display_color: "TEXT",
        created_at: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
        last_seen_at: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"
    },
    aichats: {
        message_id: "SERIAL PRIMARY KEY",
        session_id: "INTEGER",
        room_id: "TEXT", // Room isolation
        user_id: "TEXT",
        username: "TEXT",
        message: "TEXT",
        entity: "TEXT",
        timestamp: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"
    },
    userchats: {
        message_id: "SERIAL PRIMARY KEY",
        session_id: "INTEGER",
        room_id: "TEXT", // Room isolation
        user_id: "TEXT",
        message: "TEXT",
        timestamp: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
        active: "BOOLEAN DEFAULT TRUE"
    },
    sessions: {
        session_id: "SERIAL PRIMARY KEY",
        started_at: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
        ended_at: "TIMESTAMP",
        is_active: "BOOLEAN DEFAULT TRUE",
        room_id: "TEXT"
    },
    userSessions: {
        session_id: "SERIAL PRIMARY KEY",
        started_at: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
        ended_at: "TIMESTAMP",
        is_active: "BOOLEAN DEFAULT TRUE",
        room_id: "TEXT"
    },
    apis: {
        name: "TEXT UNIQUE PRIMARY KEY",
        endpoint: "TEXT",
        key: "TEXT",
        type: "TEXT",
        claude: "BOOLEAN DEFAULT FALSE",
        useTokenizer: "BOOLEAN DEFAULT FALSE",
        created_at: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
        last_used_at: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
        modelList: "TEXT",
        selectedModel: "TEXT"
    },
    lorebooks: {
        lorebook_id: "TEXT UNIQUE PRIMARY KEY",
        name: "TEXT",
        description: "TEXT",
        enabled: "BOOLEAN DEFAULT TRUE",
        scan_depth: "INTEGER DEFAULT 5",
        token_budget: "INTEGER DEFAULT 500",
        created_at: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"
    },
    lorebook_entries: {
        entry_id: "TEXT UNIQUE PRIMARY KEY",
        lorebook_id: "TEXT",
        title: "TEXT",
        keys: "TEXT", // JSON array
        content: "TEXT",
        enabled: "BOOLEAN DEFAULT TRUE",
        strategy: "TEXT DEFAULT 'keyword'",
        position: "TEXT DEFAULT 'afterCharDefs'",
        insertion_order: "INTEGER DEFAULT 100",
        depth: "INTEGER",
        trigger_percent: "INTEGER DEFAULT 100",
        created_at: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"
    }
};

async function ensureDatabaseSchema(schemaDictionary) {
    console.info('Ensuring database schema...');
    const client = await getClient();
    try {
        await client.query('BEGIN');
        for (const [tableName, tableSchema] of Object.entries(schemaDictionary)) {
            // Create table
            let createTableQuery = `CREATE TABLE IF NOT EXISTS "${tableName}" (`;
            const columnDefinitions = [];
            for (const [columnName, columnType] of Object.entries(tableSchema)) {
                if (columnName !== 'foreignKeys') {
                    columnDefinitions.push(`"${columnName}" ${columnType}`);
                }
            }
            createTableQuery += columnDefinitions.join(', ') + ')';
            await client.query(createTableQuery);

            // Add missing columns
            const res = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [tableName]);
            const existingColumns = res.rows.map(r => r.column_name);

            for (const [columnName, columnType] of Object.entries(tableSchema)) {
                if (columnName !== 'foreignKeys' && !existingColumns.includes(columnName)) {
                    await client.query(`ALTER TABLE "${tableName}" ADD COLUMN "${columnName}" ${columnType}`);
                }
            }
        }
        await client.query(`INSERT INTO apis (name, endpoint, key, type, claude) VALUES ('Default', 'localhost:5000', '', 'TC', FALSE) ON CONFLICT (name) DO NOTHING`);
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        logger.error('Error ensuring schema:', e);
        throw e;
    } finally {
        client.release();
    }
}

// Write the session ID of whatever the active session in the sessions table is
async function writeUserChatMessage(userId, message, roomId = GLOBAL_ROOM_ID) {
    logger.debug(`Writing user chat message to database for room: ${roomId}...`);
    const client = await getClient();
    try {
        await client.query('BEGIN');

        // Look for active session for THIS SPECIFIC ROOM
        let res = await client.query('SELECT session_id FROM "userSessions" WHERE is_active = TRUE AND room_id = $1', [roomId]);
        let session_id;

        if (res.rows.length > 0) {
            session_id = res.rows[0].session_id;
            logger.debug(`Using existing user session_id: ${session_id} (Room: ${roomId})`);
        } else {
            // Create new session for this room
            const insertRes = await client.query('INSERT INTO "userSessions" (is_active, started_at, room_id) VALUES (TRUE, CURRENT_TIMESTAMP, $1) RETURNING session_id', [roomId]);
            session_id = insertRes.rows[0].session_id;
            logger.debug(`Created new user session_id: ${session_id} for room ${roomId}`);
        }

        const timestamp = new Date().toISOString();

        const insertMsgRes = await client.query(
            'INSERT INTO userchats (user_id, message, timestamp, active, session_id, room_id) VALUES ($1, $2, $3, TRUE, $4, $5) RETURNING message_id',
            [userId, message, timestamp, session_id, room_id]
        );
        const message_id = insertMsgRes.rows[0].message_id;

        await client.query('COMMIT');
        logger.debug(`Inserted user chat message ${message_id} with session_id ${session_id}`);
        return { message_id, session_id, user_id: userId, message, timestamp };
    } catch (e) {
        await client.query('ROLLBACK');
        logger.error('Error writing user chat message:', e);
        throw e;
    } finally {
        client.release();
    }
}

async function getPastChats(type) {
    logger.debug(`Getting data for all past ${type} chats...`);
    try {
        const rows = (await query(`
             SELECT s.session_id, s.started_at, s.ended_at, s.is_active, a.user_id, a.timestamp,
             to_char(a.timestamp, 'YYYY-MM-DD HH24:MI:SS') AS local_timestamp
             FROM sessions s
             JOIN aichats a ON s.session_id = a.session_id
             WHERE EXISTS (SELECT 1 FROM sessions s2 WHERE s.session_id = s2.session_id) 
             ORDER BY s.started_at ASC
        `)).rows;

        const result = {};
        for (const row of rows) {
            const sessionID = row.session_id;
            if (!result[sessionID]) {
                result[sessionID] = {
                    session_id: row.session_id,
                    started_at: row.started_at,
                    ended_at: row.ended_at,
                    is_active: row.is_active,
                    aiName: null,
                    messageCount: 0,
                    latestTimestamp: null
                };
            }
            if (!row.user_id.includes('-')) {
                const aiName = row.user_id;
                if (!result[sessionID].aiName) {
                    result[sessionID].aiName = aiName;
                } else if (!result[sessionID].aiName.includes(aiName)) {
                    result[sessionID].aiName += `, ${aiName}`;
                }
            }
            result[sessionID].messageCount++;
            result[sessionID].latestTimestamp = row.local_timestamp;
        }
        return result;
    } catch (err) {
        logger.error('An error occurred while reading from the database:', err);
        throw err;
    }
}

async function deletePastChat(sessionID) {
    logger.debug('Deleting past chat... ' + sessionID);
    const client = await getClient();
    try {
        await client.query('BEGIN');
        const res = await client.query('SELECT * FROM sessions WHERE session_id = $1', [sessionID]);
        let wasActive = false;
        if (res.rows.length > 0) {
            const row = res.rows[0];
            await client.query('DELETE FROM aichats WHERE session_id = $1', [sessionID]);
            if (row.is_active) wasActive = true;
            await client.query('DELETE FROM sessions WHERE session_id = $1', [sessionID]);
            logger.debug(`Session ${sessionID} was deleted`);
        }
        await client.query('COMMIT');
        return ['ok', wasActive];
    } catch (err) {
        await client.query('ROLLBACK');
        logger.error('Error deleting session:', err);
        return ['error', false];
    } finally {
        client.release();
    }
}

async function deleteAIChatMessage(mesID) {
    logger.info('Deleting AI chat message... ' + mesID);
    try {
        const res = await query('DELETE FROM aichats WHERE message_id = $1 RETURNING *', [mesID]);
        if (res.rowCount > 0) {
            logger.debug(`Message ${mesID} was deleted`);
            return 'ok';
        }
        return 'error';
    } catch (err) {
        logger.error('Error deleting message:', err);
        return 'error';
    }
}

async function deleteUserChatMessage(mesID) {
    logger.info('Deleting user chat message... ' + mesID);
    try {
        const res = await query('DELETE FROM userchats WHERE message_id = $1 RETURNING *', [mesID]);
        if (res.rowCount > 0) {
            logger.info(`User chat message ${mesID} was deleted`);
            return 'ok';
        }
        return 'error';
    } catch (err) {
        logger.error('Error deleting message:', err);
        return 'error';
    }
}

async function deleteAPI(APIName) {
    logger.debug('[deleteAPI()] Deleting API named:' + APIName);
    try {
        await query('DELETE FROM apis WHERE name = $1', [APIName]);
        logger.debug(`API ${APIName} was deleted`);
        return ['ok'];
    } catch (err) {
        logger.error('Error deleting API:', err);
        return ['error'];
    }
}

async function readUserChat() {
    let foundSessionID;
    try {
        const res = await query(`
            SELECT 
                u.username,
                u.username_color,
                uc.message,
                uc.message_id,
                uc.session_id,
                ur.role AS "userRole",
                uc.timestamp
            FROM userchats uc 
            LEFT JOIN users u ON uc.user_id = u.user_id
            LEFT JOIN user_roles ur ON uc.user_id = ur.user_id
            WHERE uc.active = TRUE
            ORDER BY uc.timestamp ASC 
        `);

        if (res.rows.length === 0) {
            logger.warn('No active user chats found.');
        } else {
            foundSessionID = res.rows[0].session_id;
        }

        const result = JSON.stringify(res.rows.map(row => ({
            username: row.username || 'Unknown',
            content: row.message,
            userColor: row.username_color || '#FFFFFF',
            messageID: row.message_id,
            sessionID: row.session_id,
            role: row.userRole || null,
            timestamp: row.timestamp
        })));
        return [result, foundSessionID];
    } catch (err) {
        logger.error('An error occurred while reading from the database:', err);
        throw err;
    }
}

async function removeLastAIChatMessage() {
    logger.info('Removing last AI chat message...');
    const client = await getClient();
    try {
        await client.query('BEGIN');
        const sessRes = await client.query('SELECT session_id FROM sessions WHERE is_active = TRUE LIMIT 1');
        if (sessRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return null;
        }
        const session_id = sessRes.rows[0].session_id;

        await client.query(`
            DELETE FROM aichats 
            WHERE message_id = (
                SELECT message_id FROM aichats WHERE session_id = $1 ORDER BY message_id DESC LIMIT 1
            )
        `, [session_id]);

        logger.info(`Deleted last message from session ${session_id}`);
        await client.query('COMMIT');
        return session_id;
    } catch (err) {
        await client.query('ROLLBACK');
        logger.error('Error deleting message:', err);
        return null;
    } finally {
        client.release();
    }
}

async function setActiveChat(sessionID) {
    logger.info('Setting session ' + sessionID + ' as active...');
    const client = await getClient();
    try {
        await client.query('BEGIN');
        await client.query('UPDATE sessions SET is_active = FALSE WHERE is_active = TRUE');
        await client.query('UPDATE sessions SET is_active = TRUE WHERE session_id = $1', [sessionID]);
        await client.query('COMMIT');
        logger.info(`Session ${sessionID} was set as active.`);
    } catch (err) {
        await client.query('ROLLBACK');
        logger.error(`Error setting session ${sessionID} as active:`, err);
    } finally {
        client.release();
    }
}

async function getActiveChat() {
    try {
        const res = await query('SELECT session_id FROM sessions WHERE is_active = TRUE LIMIT 1');
        if (res.rows.length === 0) return null;
        return res.rows[0].session_id;
    } catch (err) {
        logger.error('Error getting active session:', err);
        return null;
    }
}

// Stub for now or verify need
async function getSessionRoom() {
    // This is from conflicting file export list, should implement?
    // Not found in previous scan, maybe new?
    // Let's assume it gets room_id from active session
    try {
        const res = await query('SELECT room_id FROM sessions WHERE is_active = TRUE LIMIT 1');
        return res.rows[0]?.room_id || null;
    } catch (err) { return null; }
}

function collapseNewlines(x) {
    if (!x) return '';
    let s = x.replace(/\r/g, '');
    return s.replace(/\n+/g, '\n');
}

async function writeAIChatMessage(username, userId, message, entity, roomId = GLOBAL_ROOM_ID) {
    logger.info(`Writing AI chat message for room ${roomId}...Username: ${username}, User ID: ${userId}, Entity: ${entity}`);
    const client = await getClient();
    try {
        await client.query('BEGIN');
        const cleanMessage = collapseNewlines(message);

        // Look for active session for THIS SPECIFIC ROOM
        let sessionId;
        const sessRes = await client.query('SELECT session_id FROM sessions WHERE is_active = TRUE AND room_id = $1', [roomId]);
        if (sessRes.rows.length > 0) {
            sessionId = sessRes.rows[0].session_id;
        } else {
            logger.warn(`No active session found for room ${roomId}, creating a new session...`);
            const newSessRes = await client.query('INSERT INTO sessions (is_active, room_id) VALUES (TRUE, $1) RETURNING session_id', [roomId]);
            sessionId = newSessRes.rows[0].session_id;
            logger.info(`A new session was created with session_id ${sessionId} for room ${roomId}`);
        }

        const timestamp = new Date().toISOString();
        const insertRes = await client.query(
            'INSERT INTO aichats (session_id, user_id, message, username, entity, timestamp, room_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING message_id',
            [sessionId, userId, cleanMessage, username, entity, timestamp, roomId]
        );
        const resultingMessageID = insertRes.rows[0].message_id;

        await client.query('COMMIT');
        return { sessionId, message_id: resultingMessageID, timestamp };
    } catch (err) {
        await client.query('ROLLBACK');
        logger.error('Error writing AI chat message:', err);
        return null;
    } finally {
        client.release();
    }
}

async function newSession(roomId = GLOBAL_ROOM_ID) {
    logger.info(`Creating a new session for room: ${roomId}...`);
    const client = await getClient();
    try {
        await client.query('BEGIN');
        await client.query('UPDATE sessions SET is_active = FALSE, ended_at = CURRENT_TIMESTAMP WHERE is_active = TRUE');
        const res = await client.query('INSERT INTO sessions (is_active, started_at, room_id) VALUES (TRUE, CURRENT_TIMESTAMP, $1) RETURNING session_id', [roomId]);
        const newSessionID = res.rows[0].session_id;
        await client.query('COMMIT');
        logger.info('Created new session with session_id ' + newSessionID + ' for room ' + roomId);
        return newSessionID;
    } catch (error) {
        await client.query('ROLLBACK');
        logger.error('Error creating a new session:', error);
        return null;
    } finally {
        client.release();
    }
}

async function newUserChatSession() {
    logger.info('Creating a new user chat session...');
    const client = await getClient();
    try {
        await client.query('BEGIN');
        const userChatRes = await client.query('UPDATE userchats SET active = FALSE WHERE active = TRUE');
        const sessionRes = await client.query('UPDATE "userSessions" SET is_active = FALSE WHERE is_active = TRUE');
        await client.query('COMMIT');

        return {
            success: true,
            userChatChanges: userChatRes.rowCount,
            userSessionChanges: sessionRes.rowCount
        };
    } catch (e) {
        await client.query('ROLLBACK');
        logger.error('Error creating new user chat session:', e);
        return { success: false };
    } finally {
        client.release();
    }
}

async function upsertUser(uuid, username, color, persona = '') {
    logger.info('Adding/updating user...' + uuid);
    try {
        const existingRes = await query('SELECT persona FROM users WHERE user_id = $1', [uuid]);
        const existingPersona = existingRes.rows[0]?.persona || '';
        const personaToSave = persona || existingPersona;

        await query(`
             INSERT INTO users (user_id, username, username_color, persona, last_seen_at) 
             VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
             ON CONFLICT (user_id) 
             DO UPDATE SET username = $2, username_color = $3, persona = $4, last_seen_at = CURRENT_TIMESTAMP
        `, [uuid, username, color, personaToSave]);

        logger.debug('A user was upserted');
    } catch (err) {
        logger.error('Error writing user:', err);
    }
}

async function upsertUserRole(uuid, role) {
    logger.info('Adding/updating user role...' + uuid + ' ' + role);
    try {
        await query(`
             INSERT INTO user_roles (user_id, role) VALUES ($1, $2)
             ON CONFLICT (user_id) DO UPDATE SET role = $2
        `, [uuid, role]);
        logger.debug('A user role was upserted');
    } catch (err) {
        logger.error('Error writing user role:', err);
    }
}

async function upsertChar(char_id, displayname, color) {
    logger.debug(`Adding/updating ${displayname} (${char_id})`);
    try {
        await query(`
            INSERT INTO characters (char_id, displayname, display_color, last_seen_at)
            VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
            ON CONFLICT (char_id) DO UPDATE 
            SET displayname = $2, display_color = $3, last_seen_at = CURRENT_TIMESTAMP
         `, [char_id, displayname, color]);
        logger.debug(`Upserted character ${char_id}`);
    } catch (e) {
        logger.error('Error upserting character:', e);
    }
}

async function getLatestCharacter() {
    try {
        const res = await query('SELECT * FROM characters ORDER BY last_seen_at DESC LIMIT 1');
        return res.rows[0] || null;
    } catch (err) {
        logger.error('Error retrieving character:', err);
        return null;
    }
}

async function getUser(uuid) {
    try {
        const res = await query(`
             SELECT u.user_id, u.username, u.username_color, u.persona, u.created_at, u.last_seen_at, ur.role 
             FROM users u 
             LEFT JOIN user_roles ur ON u.user_id = ur.user_id 
             WHERE u.user_id = $1
        `, [uuid]);
        return res.rows[0] || null;
    } catch (err) {
        logger.error('Error getting user:', err);
        throw err;
    }
}

async function readAIChat(sessionID = null) {
    let effectiveSessionID = sessionID;

    if (!sessionID) {
        const activeRes = await query('SELECT session_id FROM sessions WHERE is_active = TRUE LIMIT 1');
        if (activeRes.rows.length === 0) return [JSON.stringify([]), null];
        effectiveSessionID = activeRes.rows[0].session_id;
    }

    try {
        const res = await query(`
            SELECT 
                a.username,
                a.message,
                CASE
                    WHEN u.user_id IS NULL THEN 
                        (SELECT c.display_color FROM characters c WHERE c.char_id = a.user_id)
                    ELSE 
                        u.username_color
                END AS "userColor",
                a.message_id,
                a.session_id,
                a.entity,
                ur.role AS "userRole",
                u.persona AS "userPersona",
                a.timestamp
            FROM aichats a
            LEFT JOIN users u ON a.user_id = u.user_id
            LEFT JOIN user_roles ur ON a.user_id = ur.user_id
            WHERE a.session_id = $1
            ORDER BY a.timestamp ASC
        `, [effectiveSessionID]);

        const result = JSON.stringify(res.rows.map(row => ({
            username: row.username,
            content: row.message,
            userColor: row.userColor,
            sessionID: row.session_id,
            messageID: row.message_id,
            entity: row.entity,
            role: row.userRole ?? null,
            persona: row.userPersona || '',
            timestamp: row.timestamp
        })));
        return [result, effectiveSessionID];

    } catch (e) {
        logger.error('Error reading AIChat:', e);
        return [JSON.stringify([]), effectiveSessionID];
    }
}

async function getNextMessageID() {
    try {
        const res = await query('SELECT MAX(message_id) AS "maxMessageID" FROM aichats');
        return (res.rows[0]?.maxMessageID ?? 0) + 1;
    } catch (err) {
        logger.error('Failed to get next message ID:', err);
        return 1;
    }
}

async function getUserColor(UUID) {
    try {
        const res = await query('SELECT username_color FROM users WHERE user_id = $1', [UUID]);
        return res.rows[0]?.username_color || null;
    } catch (err) {
        logger.error('Error getting user color:', err);
        throw err;
    }
}

async function getCharacterColor(charName) {
    try {
        const res = await query('SELECT display_color FROM characters WHERE char_id = $1', [charName]);
        return res.rows[0]?.display_color || null;
    } catch (err) {
        logger.error('Error getting character color:', err);
        throw err;
    }
}

async function getMessage(messageID, sessionID) {
    try {
        const res = await query('SELECT * FROM aichats WHERE message_id = $1 AND session_id = $2', [messageID, sessionID]);
        return res.rows[0]?.message || null;
    } catch (err) {
        logger.error('Error getting message:', err);
        throw err;
    }
}

async function editMessage(sessionID, mesID, newMessage) {
    logger.info('Editing AIChat message... ' + mesID);
    try {
        await query('UPDATE aichats SET message = $1 WHERE message_id = $2', [newMessage, mesID]);
        logger.info(`Message ${mesID} was edited.`);
        return 'ok';
    } catch (e) {
        logger.error('Error editing message:', e);
        return 'error';
    }
}

async function upsertAPI(apiData) {
    const { name, endpoint, key, type } = apiData;
    let { claude, useTokenizer, modelList, selectedModel } = apiData;
    if (!name || !endpoint || !type) return;

    try {
        const existingRes = await query('SELECT * FROM apis WHERE name = $1', [name]);
        const existing = existingRes.rows[0];

        const claudeFinal = typeof claude === 'boolean' ? claude : !!(existing?.claude);
        const useTokenizerFinal = typeof useTokenizer === 'boolean' ? useTokenizer : !!(existing?.useTokenizer);

        let modelListFinal;
        if (modelList !== undefined) {
            modelListFinal = Array.isArray(modelList) ? modelList : [];
        } else if (existing?.modelList) {
            try { modelListFinal = JSON.parse(existing.modelList); } catch { modelListFinal = []; }
        } else {
            modelListFinal = [];
        }

        const selectedModelFinal = (selectedModel !== undefined) ? selectedModel : (existing?.selectedModel || '');

        await query(`
             INSERT INTO apis (name, endpoint, key, type, claude, "useTokenizer", "modelList", "selectedModel")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (name) DO UPDATE SET
             endpoint = $2, key = $3, type = $4, claude = $5, "useTokenizer" = $6, "modelList" = $7, "selectedModel" = $8
        `, [name, endpoint, key || '', type, claudeFinal, useTokenizerFinal, JSON.stringify(modelListFinal), selectedModelFinal]);

        await query('DELETE FROM apis WHERE name IS NULL OR endpoint IS NULL OR name = \'\' OR endpoint = \'\'');
    } catch (err) {
        logger.error('Error writing API:', err);
    }
}

async function getAPIs() {
    try {
        const res = await query('SELECT * FROM apis');
        return res.rows.map(row => {
            try { row.modelList = JSON.parse(row.modelList); } catch { row.modelList = []; }
            return row;
        });
    } catch (err) {
        logger.error('Error getting APIs:', err);
        throw err;
    }
}

async function getAPI(name) {
    try {
        const res = await query('SELECT * FROM apis WHERE name = $1', [name]);
        let gotAPI = res.rows[0];
        if (gotAPI) {
            try { gotAPI.modelList = JSON.parse(gotAPI.modelList); } catch { gotAPI.modelList = []; }
            return gotAPI;
        } else {
            const defRes = await query('SELECT * FROM apis WHERE name = \'Default\'');
            return defRes.rows[0];
        }
    } catch (err) {
        logger.error('Error getting API:', err);
        throw err;
    }
}

async function exportSession(sessionID) {
    try {
        const res = await query(`
            SELECT 
                a.username,
                a.message,
                CASE
                    WHEN u.user_id IS NULL THEN 
                        (SELECT c.display_color FROM characters c WHERE c.char_id = a.user_id)
                    ELSE 
                        u.username_color
                END AS "userColor",
                a.message_id,
                a.entity
            FROM aichats a
            LEFT JOIN users u ON a.user_id = u.user_id
            WHERE a.session_id = $1
            ORDER BY a.timestamp ASC
        `, [sessionID]);

        return JSON.stringify(res.rows.map(row => ({
            username: row.username,
            content: row.message,
            userColor: row.userColor,
            messageID: row.message_id,
            entity: row.entity
        })));
    } catch (e) {
        logger.error('Error exporting session:', e);
        throw e;
    }
}

async function getAIChatMessageRow(messageID, sessionID) {
    try {
        const res = await query('SELECT * FROM aichats WHERE message_id = $1 AND session_id = $2', [messageID, sessionID]);
        return res.rows[0] || null;
    } catch (err) {
        logger.error('getAIChatMessageRow error:', err);
        return null;
    }
}

// Lorebook Functions
function generateUUID() { return uuidv4(); }

async function createLorebook(name, description = '') {
    const lorebook_id = generateUUID();
    const created_at = new Date().toISOString();
    try {
        await query(
            'INSERT INTO lorebooks (lorebook_id, name, description, created_at, enabled, scan_depth, token_budget) VALUES ($1, $2, $3, $4, TRUE, 5, 500)',
            [lorebook_id, name, description, created_at]
        );
        return { lorebook_id, name, description, enabled: true, scan_depth: 5, token_budget: 500, created_at };
    } catch (e) { logger.error(e); }
}

async function getLorebooks() {
    try {
        const res = await query('SELECT * FROM lorebooks ORDER BY name ASC');
        return res.rows;
    } catch (e) { return []; }
}

async function getLorebook(id) {
    try {
        const res = await query('SELECT * FROM lorebooks WHERE lorebook_id = $1', [id]);
        return res.rows[0];
    } catch (e) { return null; }
}

async function updateLorebook(id, updates) {
    const fields = [];
    const values = [];
    let idx = 1;
    for (const [k, v] of Object.entries(updates)) {
        fields.push(`${k} = $${idx++}`);
        values.push(v);
    }
    if (fields.length === 0) return null;
    values.push(id);
    try {
        await query(`UPDATE lorebooks SET ${fields.join(', ')} WHERE lorebook_id = $${idx}`, values);
        return getLorebook(id);
    } catch (e) { logger.error(e); return null; }
}

async function deleteLorebook(id) {
    const client = await getClient();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM lorebook_entries WHERE lorebook_id = $1', [id]);
        await client.query('DELETE FROM lorebooks WHERE lorebook_id = $1', [id]);
        await client.query('COMMIT');
        return 'ok';
    } catch (e) { await client.query('ROLLBACK'); logger.error(e); } finally { client.release(); }
}

async function createLorebookEntry(lorebookId, entryData) {
    const entry_id = generateUUID();
    const created_at = new Date().toISOString();
    try {
        await query(`
             INSERT INTO lorebook_entries 
             (entry_id, lorebook_id, title, keys, content, enabled, strategy, position, insertion_order, depth, trigger_percent, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `, [
            entry_id, lorebookId, entryData.title || '', JSON.stringify(entryData.keys || []), entryData.content || '',
            entryData.enabled !== false, entryData.strategy || 'keyword', entryData.position || 'afterCharDefs',
            entryData.insertion_order || 100, entryData.depth || null, entryData.trigger_percent || 100, created_at
        ]);
        return { entry_id, ...entryData, created_at };
    } catch (e) { logger.error(e); return null; }
}

async function getLorebookEntries(id) {
    try {
        const res = await query('SELECT * FROM lorebook_entries WHERE lorebook_id = $1 ORDER BY insertion_order ASC, title ASC', [id]);
        return res.rows.map(r => ({ ...r, keys: JSON.parse(r.keys || '[]') }));
    } catch (e) { return []; }
}

async function getAllEnabledEntries() {
    try {
        const res = await query(`
             SELECT e.*, l.scan_depth AS lorebook_scan_depth, l.token_budget AS lorebook_token_budget
             FROM lorebook_entries e
             JOIN lorebooks l ON e.lorebook_id = l.lorebook_id
             WHERE l.enabled = TRUE AND e.enabled = TRUE
             ORDER BY e.insertion_order ASC
         `);
        return res.rows.map(r => ({ ...r, keys: JSON.parse(r.keys || '[]') }));
    } catch (e) { return []; }
}

async function updateLorebookEntry(id, updates) {
    const fields = [];
    const values = [];
    let idx = 1;
    for (const [k, v] of Object.entries(updates)) {
        if (k === 'keys') values.push(JSON.stringify(v));
        else values.push(v);
        fields.push(`${k} = $${idx++}`);
    }
    if (fields.length === 0) return null;
    values.push(id);
    try {
        await query(`UPDATE lorebook_entries SET ${fields.join(', ')} WHERE entry_id = $${idx}`, values);
        const res = await query('SELECT * FROM lorebook_entries WHERE entry_id = $1', [id]);
        const row = res.rows[0];
        if (row) row.keys = JSON.parse(row.keys || '[]');
        return row;
    } catch (e) { return null; }
}

async function deleteLorebookEntry(id) {
    try {
        await query('DELETE FROM lorebook_entries WHERE entry_id = $1', [id]);
        return 'ok';
    } catch (e) { return 'error'; }
}

// User Auth
function generateAuthUUID() { return generateUUID(); }

async function checkUsernameAvailable(username) {
    try {
        const res = await query('SELECT user_id FROM users WHERE LOWER(username) = LOWER($1)', [username]);
        return res.rows.length === 0;
    } catch (e) { return false; }
}

async function getUserByUsername(username) {
    try {
        const res = await query(`
             SELECT u.user_id, u.username, u.username_color, u.persona, u.password_hash, u.email, u.created_at, u.last_seen_at, ur.role 
             FROM users u 
             LEFT JOIN user_roles ur ON u.user_id = ur.user_id 
             WHERE LOWER(u.username) = LOWER($1)
        `, [username]);
        return res.rows[0] || null;
    } catch (e) { return null; }
}

async function registerUser(username, password, email = null) {
    const existing = await getUserByUsername(username);
    if (existing) return { success: false, error: 'Username already taken' };

    const user_id = generateAuthUUID();
    const password_hash = await bcrypt.hash(password, 10);
    const username_color = '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0');

    const client = await getClient();
    try {
        await client.query('BEGIN');
        await client.query(
            'INSERT INTO users (user_id, username, username_color, persona, password_hash, email) VALUES ($1, $2, $3, $4, $5, $6)',
            [user_id, username, username_color, '', password_hash, email]
        );
        await client.query('INSERT INTO user_roles (user_id, role) VALUES ($1, $2)', [user_id, 'user']);
        await client.query('COMMIT');

        return {
            success: true,
            user: { user_id, username, username_color, persona: '', email, role: 'user' }
        };
    } catch (e) {
        await client.query('ROLLBACK');
        logger.error(e);
        return { success: false, error: 'Database error' };
    } finally {
        client.release();
    }
}

async function authenticateUser(username, password) {
    const user = await getUserByUsername(username);
    if (!user) return { success: false, error: 'Invalid username or password' };
    if (!user.password_hash) return { success: false, error: 'No password set' };

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return { success: false, error: 'Invalid username or password' };

    await query('UPDATE users SET last_seen_at = CURRENT_TIMESTAMP WHERE user_id = $1', [user.user_id]);

    return {
        success: true,
        user: { ...user, password_hash: undefined }
    };
}

async function getTableData(tableName) {
    if (!schemaDictionary[tableName]) {
        throw new Error('Invalid table name');
    }
    try {
        const res = await query(`SELECT * FROM "${tableName}"`);
        return res.rows;
    } catch (err) {
        logger.error(`Error reading table ${tableName}:`, err);
        throw err;
    }
}

// ============================================================================
// ROOM MANAGEMENT FUNCTIONS - Critical for message isolation
// ============================================================================

async function createRoom(name, description = '', createdBy = null, settings = {}) {
    logger.info(`Creating room: ${name}`);
    const client = await getClient();
    try {
        await client.query('BEGIN');
        const room_id = uuidv4();
        const settingsJson = JSON.stringify(settings || {});

        await client.query(
            `INSERT INTO rooms (room_id, name, description, created_by, settings, is_active, created_at) 
             VALUES ($1, $2, $3, $4, $5, TRUE, CURRENT_TIMESTAMP)`,
            [room_id, name, description, createdBy, settingsJson]
        );

        if (createdBy) {
            await client.query(
                `INSERT INTO room_members (room_id, user_id, role, joined_at) 
                 VALUES ($1, $2, 'creator', CURRENT_TIMESTAMP)`,
                [room_id, createdBy]
            );
        }

        await client.query('INSERT INTO sessions (room_id, started_at, is_active) VALUES ($1, CURRENT_TIMESTAMP, TRUE)', [room_id]);
        await client.query('INSERT INTO "userSessions" (room_id, started_at, is_active) VALUES ($1, CURRENT_TIMESTAMP, TRUE)', [room_id]);

        await client.query('COMMIT');
        logger.info(`Room created: ${name} (${room_id})`);

        return {
            room_id,
            name,
            description,
            created_by: createdBy,
            settings: settings || {},
            is_active: true,
            created_at: new Date().toISOString()
        };
    } catch (e) {
        await client.query('ROLLBACK');
        logger.error(e);
        return null; // or throw
    } finally {
        client.release();
    }
}

async function getRoomById(roomId) {
    try {
        const res = await query('SELECT * FROM rooms WHERE room_id = $1 AND is_active = TRUE', [roomId]);
        const room = res.rows[0];
        if (room && room.settings) {
            try { room.settings = JSON.parse(room.settings); } catch { room.settings = {}; }
        }
        return room || null;
    } catch (err) {
        logger.error('Error getting room:', err);
        return null;
    }
}

async function getAllActiveRooms() {
    try {
        const res = await query(`
            SELECT 
                r.room_id,
                r.name,
                r.description,
                r.created_by,
                r.created_at,
                r.settings,
                COUNT(rm.user_id) as member_count,
                string_agg(u.username, ', ') as member_names
            FROM rooms r
            LEFT JOIN room_members rm ON r.room_id = rm.room_id
            LEFT JOIN users u ON rm.user_id = u.user_id
            WHERE r.is_active = TRUE
            GROUP BY r.room_id
            ORDER BY r.created_at DESC
        `);

        return res.rows.map(room => ({
            ...room,
            settings: room.settings ? JSON.parse(room.settings) : {}
        }));
    } catch (err) {
        logger.error('Error getting active rooms:', err);
        return [];
    }
}

async function updateRoomSettings(roomId, updates) {
    const { name, description, settings } = updates;
    const setClauses = [];
    const params = [];
    let idx = 1;

    if (name !== undefined) {
        setClauses.push(`name = $${idx++}`);
        params.push(name);
    }
    if (description !== undefined) {
        setClauses.push(`description = $${idx++}`);
        params.push(description);
    }
    if (settings !== undefined) {
        setClauses.push(`settings = $${idx++}`);
        params.push(JSON.stringify(settings));
    }

    if (setClauses.length === 0) return true;

    params.push(roomId);

    try {
        await query(`UPDATE rooms SET ${setClauses.join(', ')} WHERE room_id = $${idx}`, params);
        return true;
    } catch (e) {
        logger.error('Error updating room:', e);
        return false;
    }
}

async function deleteRoom(roomId) {
    if (roomId === GLOBAL_ROOM_ID) return false;
    const client = await getClient();
    try {
        await client.query('BEGIN');
        await client.query('UPDATE rooms SET is_active = FALSE WHERE room_id = $1', [roomId]);
        await client.query('DELETE FROM room_members WHERE room_id = $1', [roomId]);
        await client.query('COMMIT');
        return true;
    } catch (e) {
        await client.query('ROLLBACK');
        logger.error('Error deleting room:', e);
        return false;
    } finally {
        client.release();
    }
}

async function addRoomMember(roomId, userId, role = 'member') {
    try {
        const existingRes = await query('SELECT * FROM room_members WHERE room_id = $1 AND user_id = $2', [roomId, userId]);
        if (existingRes.rows.length > 0) return true;

        await query(
            `INSERT INTO room_members (room_id, user_id, role, joined_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
            [roomId, userId, role]
        );
        return true;
    } catch (e) {
        logger.error('Error adding room member:', e);
        return false;
    }
}

async function removeRoomMember(roomId, userId) {
    try {
        await query('DELETE FROM room_members WHERE room_id = $1 AND user_id = $2', [roomId, userId]);
        return true;
    } catch (e) {
        logger.error('Error removing room member:', e);
        return false;
    }
}

async function getRoomMembers(roomId) {
    try {
        const res = await query(`
            SELECT 
                rm.user_id,
                rm.role,
                rm.joined_at,
                u.username,
                u.username_color,
                u.persona
            FROM room_members rm
            LEFT JOIN users u ON rm.user_id = u.user_id
            WHERE rm.room_id = $1
            ORDER BY rm.joined_at ASC
        `, [roomId]);
        return res.rows;
    } catch (err) {
        logger.error('Error getting room members:', err);
        return [];
    }
}

async function getUserRooms(userId) {
    try {
        const res = await query(`
            SELECT 
                r.room_id,
                r.name,
                r.description,
                r.settings,
                rm.role,
                rm.joined_at
            FROM room_members rm
            JOIN rooms r ON rm.room_id = r.room_id
            WHERE rm.user_id = $1 AND r.is_active = TRUE
            ORDER BY rm.joined_at DESC
        `, [userId]);

        return res.rows.map(room => ({
            ...room,
            settings: room.settings ? JSON.parse(room.settings) : {}
        }));
    } catch (err) {
        logger.error('Error getting user rooms:', err);
        return [];
    }
}

async function getRoomActiveSession(roomId, type = 'ai') {
    const table = type === 'ai' ? 'sessions' : '"userSessions"';
    try {
        const res = await query(`SELECT session_id FROM ${table} WHERE room_id = $1 AND is_active = TRUE LIMIT 1`, [roomId]);
        return res.rows[0]?.session_id || null;
    } catch (err) {
        logger.error(`Error getting room ${type} session:`, err);
        return null;
    }
}

async function isUserInRoom(roomId, userId) {
    try {
        const res = await query('SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2', [roomId, userId]);
        return res.rows.length > 0;
    } catch (err) {
        return false;
    }
}

async function getUserRoomRole(roomId, userId) {
    try {
        const res = await query('SELECT role FROM room_members WHERE room_id = $1 AND user_id = $2', [roomId, userId]);
        return res.rows[0]?.role || null;
    } catch (err) {
        return null;
    }
}

async function createDefaultGlobalRoom() {
    try {
        const res = await query('SELECT room_id FROM rooms WHERE room_id = $1', [GLOBAL_ROOM_ID]);
        if (res.rows.length > 0) return GLOBAL_ROOM_ID;

        const client = await getClient();
        try {
            await client.query('BEGIN');
            await client.query(
                `INSERT INTO rooms (room_id, name, description, created_by, settings, is_active, created_at) 
                 VALUES ($1, 'Global Room', 'Default room for all users (backward compatibility)', NULL, '{}', TRUE, CURRENT_TIMESTAMP)`,
                [GLOBAL_ROOM_ID]
            );
            await client.query('INSERT INTO sessions (room_id, started_at, is_active) VALUES ($1, CURRENT_TIMESTAMP, TRUE)', [GLOBAL_ROOM_ID]);
            await client.query('INSERT INTO "userSessions" (room_id, started_at, is_active) VALUES ($1, CURRENT_TIMESTAMP, TRUE)', [GLOBAL_ROOM_ID]);
            await client.query('COMMIT');
            logger.info('Global Room created successfully');
            return GLOBAL_ROOM_ID;
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    } catch (e) {
        logger.error('Error creating global room:', e);
        throw e;
    }
}

async function migrateExistingDataToGlobalRoom() {
    try {
        const res = await query('SELECT 1 FROM aichats WHERE room_id IS NULL LIMIT 1');
        if (res.rows.length === 0) return;

        await createDefaultGlobalRoom();

        await query('UPDATE sessions SET room_id = $1 WHERE room_id IS NULL', [GLOBAL_ROOM_ID]);
        await query('UPDATE "userSessions" SET room_id = $1 WHERE room_id IS NULL', [GLOBAL_ROOM_ID]);
        await query('UPDATE aichats SET room_id = $1 WHERE room_id IS NULL', [GLOBAL_ROOM_ID]);
        await query('UPDATE userchats SET room_id = $1 WHERE room_id IS NULL', [GLOBAL_ROOM_ID]);

        logger.info('Migration to Global Room completed successfully');
    } catch (err) {
        logger.error('Error during migration:', err);
    }
}

ensureDatabaseSchema(schemaDictionary);

export default {
    writeUserChatMessage,
    writeAIChatMessage,
    newSession,
    upsertUser,
    getUser,
    readAIChat,
    readUserChat,
    upsertChar,
    removeLastAIChatMessage,
    getPastChats,
    deleteAIChatMessage,
    deleteUserChatMessage,
    getMessage,
    getAIChatMessageRow,
    deletePastChat,
    getUserColor,
    upsertUserRole,
    getCharacterColor,
    upsertAPI,
    getAPIs,
    getAPI,
    newUserChatSession,
    getLatestCharacter,
    deleteAPI,
    editMessage,
    getNextMessageID,
    setActiveChat,
    getActiveChat,
    getSessionRoom,
    exportSession,
    createLorebook,
    getLorebooks,
    getLorebook,
    updateLorebook,
    deleteLorebook,
    createLorebookEntry,
    getLorebookEntries,
    getAllEnabledEntries,
    updateLorebookEntry,
    deleteLorebookEntry,
    checkUsernameAvailable,
    getUserByUsername,
    registerUser,
    authenticateUser,
    getTableData,
    query,
    // Room Management
    createRoom,
    getRoomById,
    getAllActiveRooms,
    updateRoomSettings,
    deleteRoom,
    addRoomMember,
    removeRoomMember,
    getRoomMembers,
    getUserRooms,
    getRoomActiveSession,
    isUserInRoom,
    getUserRoomRole,
    createDefaultGlobalRoom,
    migrateExistingDataToGlobalRoom,
    GLOBAL_ROOM_ID
};