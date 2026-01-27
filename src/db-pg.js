/**
 * PostgreSQL Database Module for SillyTavern MultiPlayer
 * Replaces SQLite with PostgreSQL for better multi-user performance
 *
 * Migration from src/db.js (SQLite) to PostgreSQL
 */

import pg from 'pg';
const { Pool } = pg;
import { dbLogger as logger } from './log.js';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';

const BCRYPT_SALT_ROUNDS = 10;

// PostgreSQL connection pool
const pool = new Pool({
    host: process.env.PG_HOST || process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || process.env.DB_PORT || '5432'),
    database: process.env.PG_DATABASE || process.env.DB_NAME || 'stmp',
    user: process.env.PG_USER || process.env.DB_USER || 'stmp_user',
    password: process.env.PG_PASSWORD || process.env.DB_PASSWORD,
    max: parseInt(process.env.PG_POOL_SIZE || '20'),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

// Connection error handling
pool.on('error', (err) => {
    logger.error('Unexpected PostgreSQL pool error:', err);
});

// Test connection on startup
pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        logger.error('Failed to connect to PostgreSQL:', err);
        process.exit(1);
    }
    logger.info('PostgreSQL connected successfully at', res.rows[0].now);
});



// =============================================================================
// WRITE QUEUE FOR SERIALIZATION
// =============================================================================

let isWriting = false;
const writeQueue = [];

async function queueDatabaseWrite(dbOperation, params) {
    const operationName = dbOperation.name || 'anonymous';
    return new Promise((resolve, reject) => {
        writeQueue.push({ dbOperation, params, resolve, reject, operationName });
        processWriteQueue();
    });
}

async function processWriteQueue() {
    if (isWriting || writeQueue.length === 0) return;
    isWriting = true;

    const { dbOperation, params, resolve, reject, operationName } = writeQueue.shift();

    const client = await pool.connect();
    let transactionStarted = false;

    try {
        await client.query('BEGIN');
        transactionStarted = true;
        const result = await dbOperation(client, ...params);
        await client.query('COMMIT');
        resolve(result);
    } catch (err) {
        if (transactionStarted) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackErr) {
                logger.error('Error during rollback:', rollbackErr);
            }
        }
        logger.error('Error executing database write:', err, { operation: operationName, params });
        reject(err);
    } finally {
        client.release();
        isWriting = false;
        if (writeQueue.length > 0) {
            setImmediate(processWriteQueue);
        }
    }
}

// =============================================================================
// SCHEMA INITIALIZATION
// =============================================================================

async function ensureDatabaseSchema() {
    logger.info('Checking PostgreSQL schema...');
    const client = await pool.connect();

    try {
        // Check if tables exist
        const result = await client.query(`
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
            AND table_name = 'users'
        `);

        if (result.rows.length === 0) {
            logger.warn('Database schema not found. Please run schema-postgres.sql first.');
            logger.warn('Run: psql -U stmp_user -d stmp -f src/schema-postgres.sql');
            throw new Error('Database schema not initialized');
        }

        logger.info('PostgreSQL schema verified successfully');
    } finally {
        client.release();
    }
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

function collapseNewlines(x) {
    return x?.replace(/\n\n+/g, '\n\n');
}

function generateUUID() {
    return uuidv4();
}

function generateAuthUUID() {
    return uuidv4();
}

// =============================================================================
// USER MANAGEMENT
// =============================================================================

async function upsertUser(uuid, username, color, persona = '') {
    return queueDatabaseWrite(async (client) => {
        // Match SQLite behavior: preserve existing persona if incoming is empty/falsy
        const result = await client.query(
            'SELECT persona FROM users WHERE user_id = $1',
            [uuid]
        );
        const existing = result.rows[0];
        const personaToSave = persona || (existing?.persona || '');

        logger.debug(`[upsertUser] UUID: ${uuid}, incoming persona: "${persona}", existing: "${existing?.persona}", saving: "${personaToSave}"`);

        await client.query(
            `INSERT INTO users (user_id, username, username_color, persona, last_seen_at)
             VALUES ($1, $2, $3, $4, NOW())
             ON CONFLICT (user_id)
             DO UPDATE SET
                username = EXCLUDED.username,
                username_color = EXCLUDED.username_color,
                persona = EXCLUDED.persona,
                last_seen_at = NOW()`,
            [uuid, username, color, personaToSave]
        );
    }, []);
}

async function upsertUserRole(uuid, role) {
    return queueDatabaseWrite(async (client) => {
        await client.query(
            `INSERT INTO user_roles (user_id, role)
             VALUES ($1, $2)
             ON CONFLICT (user_id)
             DO UPDATE SET role = EXCLUDED.role`,
            [uuid, role]
        );
    }, []);
}

async function getUser(uuid) {
    const result = await pool.query(
        'SELECT user_id, username, username_color, persona, created_at, last_seen_at FROM users WHERE user_id = $1',
        [uuid]
    );
    return result.rows[0];
}

async function getUsers() {
    const result = await pool.query(
        'SELECT username, username_color FROM users'
    );
    return result.rows;
}

async function getUserByUsername(username) {
    const result = await pool.query(
        'SELECT * FROM users WHERE LOWER(username) = LOWER($1)',
        [username]
    );
    return result.rows[0];
}

async function checkUsernameAvailable(username) {
    const result = await pool.query(
        'SELECT 1 FROM users WHERE LOWER(username) = LOWER($1)',
        [username]
    );
    return result.rows.length === 0;
}

async function getUserColor(UUID) {
    const result = await pool.query(
        'SELECT username_color FROM users WHERE user_id = $1',
        [UUID]
    );

    if (result.rows.length === 0) {
        logger.warn('User not found for UUID:', UUID);
        return null;
    }
    return result.rows[0].username_color;
}

// =============================================================================
// AUTHENTICATION
// =============================================================================

async function registerUser(username, password, email = null) {
    logger.info('Registering new user:', username);

    const existing = await getUserByUsername(username);
    if (existing) {
        if (!existing.password_hash) {
            logger.info('Upgrading guest account to registered account:', username);
            return queueDatabaseWrite(async (client) => {
                try {
                    const password_hash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
                    const updated_at = new Date().toISOString();

                    await client.query(
                        `UPDATE users
                         SET password_hash = $1, email = $2, last_seen_at = $3
                         WHERE user_id = $4`,
                        [password_hash, email, updated_at, existing.user_id]
                    );

                    logger.info('Guest account upgraded successfully:', username);
                    return {
                        success: true,
                        user: {
                            user_id: existing.user_id,
                            username: existing.username,
                            username_color: existing.username_color,
                            persona: existing.persona || '',
                            email,
                            role: existing.role || 'user',
                            created_at: existing.created_at
                        }
                    };
                } catch (err) {
                    logger.error('Error upgrading guest account:', err);
                    return { success: false, error: 'Database error during registration' };
                }
            }, []);
        }

        logger.warn('Username already taken (registered account):', username);
        return { success: false, error: 'Username already taken' };
    }

    return queueDatabaseWrite(async (client) => {
        try {
            const user_id = generateAuthUUID();
            const password_hash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
            const username_color = '#' + Math.floor(Math.random() * 16777215).toString(16);

            await client.query(
                `INSERT INTO users (user_id, username, username_color, password_hash, email, created_at, last_seen_at)
                 VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
                [user_id, username, username_color, password_hash, email]
            );

            await client.query(
                `INSERT INTO user_roles (user_id, role) VALUES ($1, 'user')`,
                [user_id]
            );

            logger.info('User registered successfully:', username);
            return {
                success: true,
                user: {
                    user_id,
                    username,
                    username_color,
                    persona: '',
                    email,
                    role: 'user',
                    created_at: new Date().toISOString()
                }
            };
        } catch (err) {
            logger.error('Error creating user:', err);
            return { success: false, error: 'Database error during registration' };
        }
    }, []);
}

async function authenticateUser(username, password) {
    logger.info('Authenticating user:', username);

    const user = await getUserByUsername(username);
    if (!user) {
        logger.warn('User not found:', username);
        return { success: false, error: 'Invalid username or password' };
    }

    if (!user.password_hash) {
        logger.warn('User has no password (guest account):', username);
        return { success: false, error: 'This account has no password. Please register.' };
    }

    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
        logger.warn('Password mismatch for user:', username);
        return { success: false, error: 'Invalid username or password' };
    }

    const roleResult = await pool.query(
        'SELECT role FROM user_roles WHERE user_id = $1',
        [user.user_id]
    );
    const role = roleResult.rows[0]?.role || 'user';

    await pool.query(
        'UPDATE users SET last_seen_at = NOW() WHERE user_id = $1',
        [user.user_id]
    );

    logger.info('User authenticated successfully:', username);
    return {
        success: true,
        user: {
            user_id: user.user_id,
            username: user.username,
            username_color: user.username_color,
            persona: user.persona || '',
            email: user.email,
            role,
            created_at: user.created_at
        }
    };
}

// =============================================================================
// CHARACTER MANAGEMENT
// =============================================================================

async function upsertChar(char_id, displayname, color) {
    return queueDatabaseWrite(async (client) => {
        await client.query(
            `INSERT INTO characters (char_id, displayname, display_color, last_seen_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (char_id)
             DO UPDATE SET
                displayname = EXCLUDED.displayname,
                display_color = EXCLUDED.display_color,
                last_seen_at = NOW()`,
            [char_id, displayname, color]
        );
    }, []);
}

async function getLatestCharacter() {
    const result = await pool.query(
        'SELECT * FROM characters ORDER BY last_seen_at DESC LIMIT 1'
    );
    return result.rows[0];
}

async function getCharacters() {
    const result = await pool.query(
        'SELECT * FROM characters'
    );
    return result.rows[0];
}

async function getCharacterColor(charName) {
    const result = await pool.query(
        'SELECT display_color FROM characters WHERE displayname = $1',
        [charName]
    );
    return result.rows[0]?.display_color || null;
}

// =============================================================================
// SESSION MANAGEMENT
// =============================================================================

async function newSession(roomId = null) {
    logger.info('Creating a new session... (room:', roomId, ')');
    return queueDatabaseWrite(async (client) => {
        const result = await client.query(
            'INSERT INTO sessions (room_id, started_at, is_active) VALUES ($1, NOW(), TRUE) RETURNING session_id',
            [roomId]
        );
        const session_id = result.rows[0].session_id;
        logger.info('Created new room session with session_id', session_id, 'for room', roomId);
        return session_id;
    }, []);
}

async function newUserChatSession(roomId = null) {
    return queueDatabaseWrite(async (client) => {
        const result = await client.query(
            'INSERT INTO "userSessions" (room_id, started_at, is_active) VALUES ($1, NOW(), TRUE) RETURNING session_id',
            [roomId]
        );
        return result.rows[0].session_id;
    }, []);
}

async function setActiveChat(sessionID, roomId = null) {
    logger.info('Setting session', sessionID, 'as active... (room:', roomId, ')');
    return queueDatabaseWrite(async (client) => {
        // Deactivate all other sessions in this room
        await client.query(
            'UPDATE sessions SET is_active = FALSE, ended_at = NOW() WHERE room_id IS NOT DISTINCT FROM $1',
            [roomId]
        );

        // Activate the specified session
        await client.query(
            'UPDATE sessions SET is_active = TRUE, ended_at = NULL WHERE session_id = $1',
            [sessionID]
        );

        logger.info('Session', sessionID, 'was set as active.');
    }, []);
}

async function getActiveChat(roomId = null) {
    let result;
    if (roomId) {
        result = await pool.query(
            'SELECT session_id FROM sessions WHERE room_id = $1 AND is_active = TRUE LIMIT 1',
            [roomId]
        );
    } else {
        result = await pool.query(
            'SELECT session_id FROM sessions WHERE is_active = TRUE LIMIT 1'
        );
    }
    return result.rows[0]?.session_id || null;
}

async function getSessionRoom(sessionId) {
    const result = await pool.query(
        'SELECT room_id FROM sessions WHERE session_id = $1',
        [sessionId]
    );
    return result.rows[0]?.room_id || null;
}

async function getRoomActiveSession(roomId, type = 'ai') {
    const table = type === 'ai' ? 'sessions' : '"userSessions"';
    const result = await pool.query(
        `SELECT session_id FROM ${table} WHERE room_id = $1 AND is_active = TRUE LIMIT 1`,
        [roomId]
    );
    return result.rows[0]?.session_id || null;
}

// =============================================================================
// CHAT MESSAGE OPERATIONS
// =============================================================================

async function writeAIChatMessage(username, userId, message, entity, roomId = null) {
    logger.info('Writing AI chat message...Username:', username, ', User ID:', userId, ', Entity:', entity, ', RoomID:', roomId);

    // IMPORTANT: Ensure character exists in users table before writing message
    // This prevents foreign key constraint violations when characters send messages
    if (entity === 'AI') {
        await ensureCharacterExists(userId);
    }

    return queueDatabaseWrite(async (client) => {
        let activeSession;
        if (roomId) {
            const sessionResult = await client.query(
                'SELECT session_id FROM sessions WHERE room_id = $1 AND is_active = TRUE LIMIT 1',
                [roomId]
            );
            activeSession = sessionResult.rows[0]?.session_id;
        } else {
            const sessionResult = await client.query(
                'SELECT session_id FROM sessions WHERE is_active = TRUE LIMIT 1'
            );
            activeSession = sessionResult.rows[0]?.session_id;
        }

        if (!activeSession) {
            logger.info('[writeAIChatMessage] No active session found for room', roomId, ', creating a new session...');
            // Create session directly within this transaction instead of queueing another
            const result = await client.query(
                'INSERT INTO sessions (room_id, started_at, is_active) VALUES ($1, NOW(), TRUE) RETURNING session_id',
                [roomId]
            );
            activeSession = result.rows[0].session_id;
            logger.info('[writeAIChatMessage] New room session created with session_id', activeSession, 'for room', roomId);
        }

        const collapsed = collapseNewlines(message);

        await client.query(
            `INSERT INTO aichats (session_id, room_id, user_id, username, message, entity, timestamp)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [activeSession, roomId, userId, username, collapsed, entity]
        );

        const msgIdResult = await client.query(
            'SELECT message_id FROM aichats WHERE session_id = $1 ORDER BY message_id DESC LIMIT 1',
            [activeSession]
        );

        return msgIdResult.rows[0]?.message_id;
    }, []);
}

async function writeUserChatMessage(userId, message, roomId = null) {
    return queueDatabaseWrite(async (client) => {
        let activeSession;
        if (roomId) {
            const sessionResult = await client.query(
                'SELECT session_id FROM "userSessions" WHERE room_id = $1 AND is_active = TRUE LIMIT 1',
                [roomId]
            );
            activeSession = sessionResult.rows[0]?.session_id;
        } else {
            const sessionResult = await client.query(
                'SELECT session_id FROM "userSessions" WHERE is_active = TRUE LIMIT 1'
            );
            activeSession = sessionResult.rows[0]?.session_id;
        }

        if (!activeSession) {
            logger.info('[writeUserChatMessage] No active user session found for room', roomId, ', creating a new session...');
            // Create session directly within this transaction
            const result = await client.query(
                'INSERT INTO "userSessions" (room_id, started_at, is_active) VALUES ($1, NOW(), TRUE) RETURNING session_id',
                [roomId]
            );
            activeSession = result.rows[0].session_id;
            logger.info('[writeUserChatMessage] New user session created with session_id', activeSession, 'for room', roomId);
        }

        const collapsed = collapseNewlines(message);

        await client.query(
            `INSERT INTO userchats (session_id, room_id, user_id, message, timestamp, active)
             VALUES ($1, $2, $3, $4, NOW(), TRUE)`,
            [activeSession, roomId, userId, collapsed]
        );
    }, []);
}

async function readAIChat() {
    logger.info(`[readAIChat] Reading AI chat for `);
    const result = await pool.query(`
        SELECT
            a.message_id,
            a.user_id,
            a.username,
            a.message AS content,
            a.entity,
            a.timestamp
        FROM aichats a
        ORDER BY a.timestamp ASC
    `);
    return result.rows;
}

async function readUserChat() {
    const result = await pool.query(
        `SELECT
            message_id,
            user_id,
            message AS content,
            timestamp,
            active
         FROM userchats
         ORDER BY timestamp ASC`
    );
    return result.rows;
}

async function getMessage(messageID, sessionID) {
    const result = await pool.query(
        'SELECT message AS content FROM aichats WHERE message_id = $1 AND session_id = $2',
        [messageID, sessionID]
    );
    return result.rows[0]?.content || null;
}

async function getAIChatMessageRow(messageID, sessionID) {
    const result = await pool.query(
        'SELECT * FROM aichats WHERE message_id = $1 AND session_id = $2',
        [messageID, sessionID]
    );
    return result.rows[0] || null;
}

async function editMessage(sessionID, mesID, newMessage) {
    logger.info('Editing AIChat message... ' + mesID);
    return queueDatabaseWrite(async (client) => {
        await client.query(
            'UPDATE aichats SET message = $1 WHERE message_id = $2',
            [newMessage, mesID]
        );
        logger.info(`Message ${mesID} was edited.`);
        const proof = await client.query(
            'SELECT message FROM aichats WHERE message_id = $1',
            [mesID]
        );
        console.info('edited message result: ', proof.rows[0]);
        return 'ok';
    }, []);
}

async function deleteAIChatMessage(mesID) {
    logger.info('Deleting AI chat message... ' + mesID);
    return queueDatabaseWrite(async (client) => {
        try {
            const result = await client.query(
                'SELECT * FROM aichats WHERE message_id = $1',
                [mesID]
            );
            if (result.rows.length > 0) {
                await client.query(
                    'DELETE FROM aichats WHERE message_id = $1',
                    [mesID]
                );
                logger.debug(`Message ${mesID} was deleted`);
                return 'ok';
            }
            return 'not found';
        } catch (err) {
            logger.error('Error deleting AI chat message:', err);
            throw err;
        }
    }, []);
}

async function deleteUserChatMessage(mesID) {
    logger.info('Deleting user chat message... ' + mesID);
    return queueDatabaseWrite(async (client) => {
        try {
            const result = await client.query(
                'SELECT * FROM userchats WHERE message_id = $1',
                [mesID]
            );
            if (result.rows.length > 0) {
                await client.query(
                    'DELETE FROM userchats WHERE message_id = $1',
                    [mesID]
                );
                logger.info(`User chat message ${mesID} was deleted`);
                return 'ok';
            }
            return 'not found';
        } catch (err) {
            logger.error('Error deleting user chat message:', err);
            return 'error';
        }
    }, []);
}

async function removeLastAIChatMessage(roomId = null) {
    return queueDatabaseWrite(async (client) => {
        let activeSession;
        if (roomId) {
            const sessionResult = await client.query(
                'SELECT session_id FROM sessions WHERE room_id = $1 AND is_active = TRUE LIMIT 1',
                [roomId]
            );
            activeSession = sessionResult.rows[0]?.session_id;
        } else {
            const sessionResult = await client.query(
                'SELECT session_id FROM sessions WHERE is_active = TRUE LIMIT 1'
            );
            activeSession = sessionResult.rows[0]?.session_id;
        }

        if (!activeSession) return;

        const msgResult = await client.query(
            'SELECT message_id FROM aichats WHERE session_id = $1 ORDER BY message_id DESC LIMIT 1',
            [activeSession]
        );

        const messageId = msgResult.rows[0]?.message_id;
        if (messageId) {
            await client.query(
                'DELETE FROM aichats WHERE message_id = $1',
                [messageId]
            );
        }
    }, []);
}

async function getNextMessageID() {
    const result = await pool.query(
        "SELECT nextval(pg_get_serial_sequence('aichats', 'message_id')) AS next_id"
    );
    return result.rows[0].next_id;
}

// =============================================================================
// PAST CHATS / SESSION HISTORY
// =============================================================================

async function getPastChats(type, roomId = null) {
    logger.info('[getPastChats] Getting data for past ai chats... Room:', roomId || 'ALL (global)');

    const table = type === 'ai' ? 'sessions' : '"userSessions"';
    const chatTable = type === 'ai' ? 'aichats' : 'userchats';

    let query, params;

    if (roomId) {
        query = `
            SELECT
                s.session_id,
                s.started_at,
                s.ended_at,
                s.is_active,
                s.room_id,
                COUNT(c.message_id) AS message_count,
                (
                    SELECT c2.username
                    FROM ${chatTable} c2
                    WHERE c2.session_id = s.session_id
                    AND c2.entity = 'AI'
                    ORDER BY c2.message_id ASC
                    LIMIT 1
                ) AS ai_name
            FROM ${table} s
            LEFT JOIN ${chatTable} c ON c.session_id = s.session_id
            WHERE s.room_id = $1 AND s.is_active = FALSE
            GROUP BY s.session_id
            HAVING COUNT(c.message_id) > 0
            ORDER BY s.started_at DESC
        `;
        params = [roomId];
    } else {
        query = `
            SELECT
                s.session_id,
                s.started_at,
                s.ended_at,
                s.is_active,
                s.room_id,
                COUNT(c.message_id) AS message_count,
                (
                    SELECT c2.username
                    FROM ${chatTable} c2
                    WHERE c2.session_id = s.session_id
                    AND c2.entity = 'AI'
                    ORDER BY c2.message_id ASC
                    LIMIT 1
                ) AS ai_name
            FROM ${table} s
            LEFT JOIN ${chatTable} c ON c.session_id = s.session_id
            WHERE s.is_active = FALSE
            GROUP BY s.session_id
            HAVING COUNT(c.message_id) > 0
            ORDER BY s.started_at DESC
        `;
        params = [];
    }

    const result = await pool.query(query, params);

    const pastChats = {};
    result.rows.forEach(row => {
        pastChats[row.session_id] = {
            session_id: row.session_id,
            started_at: row.started_at,
            ended_at: row.ended_at,
            is_active: row.is_active,
            room_id: row.room_id,
            messageCount: parseInt(row.message_count),
            aiName: row.ai_name || 'Unknown'
        };
    });

    logger.info(`[getPastChats] Found ${result.rows.length} past ${type} chats for room ${roomId || 'ALL'}`);
    result.rows.forEach(row => {
        logger.info(`[getPastChats]   Session ${row.session_id}: ${row.message_count} messages, is_active=${row.is_active}, ai_name=${row.ai_name || 'Unknown'}, started_at=${row.started_at}, ended_at=${row.ended_at}`);
    });

    return pastChats;
}

async function deletePastChat(sessionID, type = 'ai', roomId = null) {
    logger.debug('Deleting past chat... ' + sessionID);
    return queueDatabaseWrite(async (client) => {
        const table = type === 'ai' ? 'sessions' : '"userSessions"';
        const chatTable = type === 'ai' ? 'aichats' : 'userchats';

        let wasActive = false;
        try {
            // Check if session exists and get its active status
            const row = await client.query(
                `SELECT is_active, room_id FROM ${table} WHERE session_id = $1`,
                [sessionID]
            );

            if (row.rows.length === 0) {
                logger.warn(`Session ${sessionID} not found for deletion`);
                return ['not found', false];
            }

            if (roomId && row.rows[0]?.room_id !== roomId) {
                logger.error('Session does not belong to this room');
                return ['error', false];
            }

            wasActive = row.rows[0]?.is_active || false;

            // Delete messages first
            const deleteMessagesResult = await client.query(`DELETE FROM ${chatTable} WHERE session_id = $1`, [sessionID]);
            logger.debug(`[deletePastChat] Deleted ${deleteMessagesResult.rowCount} messages from session ${sessionID}`);

            // Then delete session
            const deleteSessionResult = await client.query(`DELETE FROM ${table} WHERE session_id = $1`, [sessionID]);
            logger.debug(`[deletePastChat] Deleted ${deleteSessionResult.rowCount} session record for session ${sessionID}`);

            // Verify deletion
            const verifyResult = await client.query(
                `SELECT COUNT(*) as count FROM ${table} WHERE session_id = $1`,
                [sessionID]
            );
            const stillExists = parseInt(verifyResult.rows[0].count) > 0;

            if (stillExists) {
                logger.error(`[deletePastChat] ERROR: Session ${sessionID} still exists after deletion!`);
                return ['error', wasActive];
            }

            logger.debug(`[deletePastChat] Session ${sessionID} was successfully deleted and verified`);
            return ['ok', wasActive];
        } catch (err) {
            logger.error('Error deleting session:', err);
            return ['error', false];
        }
    }, []);
}

async function exportSession(sessionID) {
    const result = await pool.query(
        `SELECT message_id, username, message, entity, timestamp
         FROM aichats
         WHERE session_id = $1
         ORDER BY message_id ASC`,
        [sessionID]
    );
    return result.rows;
}

// =============================================================================
// API MANAGEMENT
// =============================================================================

async function upsertAPI(apiData) {
    logger.info('Adding/updating API...');
    const { name, endpoint, key, type, claude, useTokenizer, modelList, selectedModel } = apiData;

    // Ensure modelList is properly serialized as JSON
    const modelListJson = modelList ? JSON.stringify(Array.isArray(modelList) ? modelList : Array.from(modelList)) : null;

    return queueDatabaseWrite(async (client) => {
        await client.query(
            `INSERT INTO apis (name, endpoint, key, type, claude, "useTokenizer", "modelList", "selectedModel", created_at, last_used_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
             ON CONFLICT (name)
             DO UPDATE SET
                endpoint = EXCLUDED.endpoint,
                key = EXCLUDED.key,
                type = EXCLUDED.type,
                claude = EXCLUDED.claude,
                "useTokenizer" = EXCLUDED."useTokenizer",
                "modelList" = EXCLUDED."modelList",
                "selectedModel" = EXCLUDED."selectedModel",
                last_used_at = NOW()`,
            [name, endpoint, key, type, claude || false, useTokenizer || false, modelListJson, selectedModel]
        );
        logger.info('API upserted:', name);
    }, []);
}

async function getAPIs() {
    const result = await pool.query('SELECT * FROM apis ORDER BY created_at ASC');
    // Parse modelList from JSON string to array
    return result.rows.map(api => ({
        ...api,
        modelList: api.modelList ? JSON.parse(api.modelList) : []
    }));
}

async function getAPI(name) {
    const result = await pool.query('SELECT * FROM apis WHERE name = $1', [name]);
    const api = result.rows[0];
    if (!api) return null;

    // Parse modelList from JSON string to array
    return {
        ...api,
        modelList: api.modelList ? JSON.parse(api.modelList) : []
    };
}

async function deleteAPI(APIName) {
    return queueDatabaseWrite(async (client) => {
        await client.query('DELETE FROM apis WHERE name = $1', [APIName]);
    }, []);
}

// =============================================================================
// LOREBOOK MANAGEMENT
// =============================================================================

async function createLorebook(name, description = '') {
    const lorebook_id = generateUUID();
    return queueDatabaseWrite(async (client) => {
        await client.query(
            `INSERT INTO lorebooks (lorebook_id, name, description, enabled, scan_depth, token_budget, created_at)
             VALUES ($1, $2, $3, TRUE, 5, 500, NOW())`,
            [lorebook_id, name, description]
        );
        return { lorebook_id, name, description, enabled: true, scan_depth: 5, token_budget: 500 };
    }, []);
}

async function getLorebooks() {
    const result = await pool.query(
        'SELECT * FROM lorebooks ORDER BY created_at ASC'
    );
    return result.rows;
}

async function getLorebook(lorebookId) {
    const result = await pool.query(
        'SELECT * FROM lorebooks WHERE lorebook_id = $1',
        [lorebookId]
    );
    return result.rows[0] || null;
}

async function updateLorebook(lorebookId, updates) {
    return queueDatabaseWrite(async (client) => {
        const { name, description, enabled, scan_depth, token_budget } = updates;
        const setClauses = [];
        const params = [];
        let paramIndex = 1;

        if (name !== undefined) {
            setClauses.push(`name = $${paramIndex++}`);
            params.push(name);
        }
        if (description !== undefined) {
            setClauses.push(`description = $${paramIndex++}`);
            params.push(description);
        }
        if (enabled !== undefined) {
            setClauses.push(`enabled = $${paramIndex++}`);
            params.push(enabled);
        }
        if (scan_depth !== undefined) {
            setClauses.push(`scan_depth = $${paramIndex++}`);
            params.push(scan_depth);
        }
        if (token_budget !== undefined) {
            setClauses.push(`token_budget = $${paramIndex++}`);
            params.push(token_budget);
        }

        if (setClauses.length === 0) return;

        params.push(lorebookId);
        await client.query(
            `UPDATE lorebooks SET ${setClauses.join(', ')} WHERE lorebook_id = $${paramIndex}`,
            params
        );
    }, []);
}

async function deleteLorebook(lorebookId) {
    return queueDatabaseWrite(async (client) => {
        await client.query('DELETE FROM lorebook_entries WHERE lorebook_id = $1', [lorebookId]);
        await client.query('DELETE FROM lorebooks WHERE lorebook_id = $1', [lorebookId]);
    }, []);
}

async function createLorebookEntry(lorebookId, entryData) {
    const entry_id = generateUUID();
    const { title, keys, content, enabled, strategy, position, insertion_order, depth, trigger_percent } = entryData;

    return queueDatabaseWrite(async (client) => {
        await client.query(
            `INSERT INTO lorebook_entries (
                entry_id, lorebook_id, title, keys, content, enabled, strategy, position,
                insertion_order, depth, trigger_percent, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())`,
            [
                entry_id, lorebookId, title, JSON.stringify(keys), content, enabled ?? true,
                strategy || 'keyword', position || 'afterCharDefs', insertion_order ?? 100,
                depth, trigger_percent ?? 100
            ]
        );
        return {
            entry_id, lorebook_id: lorebookId, title, keys, content, enabled: enabled ?? true,
            strategy: strategy || 'keyword', position: position || 'afterCharDefs',
            insertion_order: insertion_order ?? 100, depth, trigger_percent: trigger_percent ?? 100
        };
    }, []);
}

async function getLorebookEntries(lorebookId) {
    const result = await pool.query(
        'SELECT * FROM lorebook_entries WHERE lorebook_id = $1 ORDER BY insertion_order ASC',
        [lorebookId]
    );
    return result.rows.map(row => ({
        ...row,
        keys: JSON.parse(row.keys)
    }));
}

async function updateLorebookEntry(entryId, updates) {
    return queueDatabaseWrite(async (client) => {
        const { title, keys, content, enabled, strategy, position, insertion_order, depth, trigger_percent } = updates;
        const setClauses = [];
        const params = [];
        let paramIndex = 1;

        if (title !== undefined) {
            setClauses.push(`title = $${paramIndex++}`);
            params.push(title);
        }
        if (keys !== undefined) {
            setClauses.push(`keys = $${paramIndex++}`);
            params.push(JSON.stringify(keys));
        }
        if (content !== undefined) {
            setClauses.push(`content = $${paramIndex++}`);
            params.push(content);
        }
        if (enabled !== undefined) {
            setClauses.push(`enabled = $${paramIndex++}`);
            params.push(enabled);
        }
        if (strategy !== undefined) {
            setClauses.push(`strategy = $${paramIndex++}`);
            params.push(strategy);
        }
        if (position !== undefined) {
            setClauses.push(`position = $${paramIndex++}`);
            params.push(position);
        }
        if (insertion_order !== undefined) {
            setClauses.push(`insertion_order = $${paramIndex++}`);
            params.push(insertion_order);
        }
        if (depth !== undefined) {
            setClauses.push(`depth = $${paramIndex++}`);
            params.push(depth);
        }
        if (trigger_percent !== undefined) {
            setClauses.push(`trigger_percent = $${paramIndex++}`);
            params.push(trigger_percent);
        }

        if (setClauses.length === 0) return;

        params.push(entryId);
        await client.query(
            `UPDATE lorebook_entries SET ${setClauses.join(', ')} WHERE entry_id = $${paramIndex}`,
            params
        );
    }, []);
}

async function deleteLorebookEntry(entryId) {
    return queueDatabaseWrite(async (client) => {
        await client.query('DELETE FROM lorebook_entries WHERE entry_id = $1', [entryId]);
    }, []);
}

async function getAllEnabledEntries() {
    const result = await pool.query(
        `SELECT le.* FROM lorebook_entries le
         INNER JOIN lorebooks l ON le.lorebook_id = l.lorebook_id
         WHERE l.enabled = TRUE AND le.enabled = TRUE
         ORDER BY le.insertion_order ASC`
    );
    return result.rows.map(row => ({
        ...row,
        keys: JSON.parse(row.keys)
    }));
}

// =============================================================================
// CHARACTER SYNCHRONIZATION (PostgreSQL Foreign Key Fix)
// =============================================================================

/**
 * Synchronize character files with the users table
 * This ensures all character files have corresponding entries in the users table
 * to satisfy the foreign key constraint on aichats.user_id
 *
 * @param {string} charactersDir - Path to characters directory
 * @returns {Promise<{synced: number, skipped: number, errors: number}>}
 */
async function syncCharactersToDatabase(charactersDir = './public/characters') {
    const fs = await import('fs/promises');
    const path = await import('path');

    logger.info('[syncCharacters] Syncing character files to database...');

    let synced = 0;
    let skipped = 0;
    let errors = 0;

    try {
        // Read all PNG files from characters directory
        const files = await fs.readdir(charactersDir);
        const pngFiles = files.filter(f => f.toLowerCase().endsWith('.png'));

        logger.info(`[syncCharacters] Found ${pngFiles.length} character PNG files`);

        for (const filename of pngFiles) {
            try {
                // Character name is the filename without .png extension
                const charName = path.basename(filename, '.png');
                const charPath = `public/characters/${filename}`;

                // Check if character already exists in users table
                const existingCheck = await pool.query(
                    'SELECT user_id FROM users WHERE user_id = $1',
                    [charName]
                );

                if (existingCheck.rows.length > 0) {
                    // Character already exists
                    skipped++;
                    continue;
                }

                // Insert character into users table
                // user_id = character name (this is what gets referenced in aichats)
                await pool.query(
                    `INSERT INTO users (user_id, username, username_color, persona, created_at, last_seen_at)
                     VALUES ($1, $2, $3, $4, NOW(), NOW())
                     ON CONFLICT (user_id) DO NOTHING`,
                    [
                        charName,                    // user_id
                        charName,                    // username
                        '#8B4789',                   // default purple color for characters
                        `Character: ${charName}`     // persona marker
                    ]
                );

                logger.info(`[syncCharacters] Synced character: ${charName}`);
                synced++;

            } catch (fileError) {
                logger.error(`[syncCharacters] Error syncing ${filename}:`, fileError.message);
                errors++;
            }
        }

        logger.info(`[syncCharacters] Sync complete - Synced: ${synced}, Skipped: ${skipped}, Errors: ${errors}`);

        return { synced, skipped, errors };

    } catch (error) {
        logger.error('[syncCharacters] Failed to sync characters:', error);
        return { synced, skipped, errors };
    }
}

/**
 * Ensure a specific character exists in the users table
 * Call this before inserting a message from a character
 *
 * @param {string} characterName - Character name/ID
 * @returns {Promise<boolean>} True if character exists or was created
 */
async function ensureCharacterExists(characterName) {
    try {
        // Check if character exists
        const result = await pool.query(
            'SELECT user_id FROM users WHERE user_id = $1',
            [characterName]
        );

        if (result.rows.length > 0) {
            return true; // Already exists
        }

        // Create character entry
        await pool.query(
            `INSERT INTO users (user_id, username, username_color, persona, created_at, last_seen_at)
             VALUES ($1, $2, $3, $4, NOW(), NOW())
             ON CONFLICT (user_id) DO NOTHING`,
            [
                characterName,
                characterName,
                '#8B4789',
                `Character: ${characterName}`
            ]
        );

        logger.info(`[ensureCharacterExists] Created user entry for character: ${characterName}`);
        return true;

    } catch (error) {
        logger.error(`[ensureCharacterExists] Failed to ensure character ${characterName}:`, error);
        return false;
    }
}

// =============================================================================
// ROOM MANAGEMENT
// =============================================================================

async function createRoom(name, description = '', createdBy = null, settings = {}) {
    logger.info('Creating room:', name);
    const room_id = generateUUID();

    return queueDatabaseWrite(async (client) => {
        await client.query(
            `INSERT INTO rooms (room_id, name, description, created_by, settings, is_active, created_at)
             VALUES ($1, $2, $3, $4, $5, TRUE, NOW())`,
            [room_id, name, description, createdBy, JSON.stringify(settings)]
        );

        if (createdBy) {
            await client.query(
                `INSERT INTO room_members (room_id, user_id, role, joined_at)
                 VALUES ($1, $2, 'creator', NOW())`,
                [room_id, createdBy]
            );
        }

        logger.info('Room created:', name, '(' + room_id + ')');
        return room_id;
    }, []);
}

async function getRooms() {
    try {
        const result = await pool.query(
            'SELECT * FROM rooms WHERE is_active = TRUE'
        );
        return result.rows;
    } catch (error) {
        logger.error('Error getting rooms:', error);
        return [];
    }
}

async function getRoomById(roomId) {
    try {
        const result = await pool.query(
            'SELECT * FROM rooms WHERE room_id = $1 AND is_active = TRUE',
            [roomId]
        );

        if (result.rows.length === 0) return null;

        const room = result.rows[0];
        if (room.settings) {
            logger.info(`[getRoomById] Raw room data for ${roomId}:`, {
                name: room.name,
                settings_raw: room.settings
            });
            room.settings = JSON.parse(room.settings);
            logger.info(`[getRoomById] Parsed settings for ${roomId}:`, JSON.stringify(room.settings));
        }
        return room;
    } catch (err) {
        logger.error('Error getting room:', err);
        return null;
    }
}

async function getAllActiveRooms() {
    try {
        const result = await pool.query(
            `SELECT
                r.room_id,
                r.name,
                r.description,
                r.created_by,
                r.created_at,
                COUNT(DISTINCT rm.user_id) AS member_count,
                STRING_AGG(DISTINCT u.username, ', ') AS member_names
             FROM rooms r
             LEFT JOIN room_members rm ON r.room_id = rm.room_id
             LEFT JOIN users u ON rm.user_id = u.user_id
             WHERE r.is_active = TRUE
             GROUP BY r.room_id, r.name, r.description, r.created_by, r.created_at
             ORDER BY r.created_at DESC`
        );
        return result.rows;
    } catch (err) {
        logger.error('Error getting active rooms:', err);
        return [];
    }
}

async function updateRoomSettings(roomId, updates) {
    logger.info('Updating room settings:', roomId);

    return queueDatabaseWrite(async (client) => {
        const { name, description, settings } = updates;

        if (settings !== undefined) {
            logger.info(`[updateRoomSettings] Settings to save for room ${roomId}:`, JSON.stringify(settings));
        }

        const setClauses = [];
        const params = [];
        let paramIndex = 1;

        if (name !== undefined) {
            setClauses.push(`name = $${paramIndex++}`);
            params.push(name);
        }
        if (description !== undefined) {
            setClauses.push(`description = $${paramIndex++}`);
            params.push(description);
        }
        if (settings !== undefined) {
            setClauses.push(`settings = $${paramIndex++}`);
            params.push(JSON.stringify(settings));
        }

        if (setClauses.length === 0) return true;

        params.push(roomId);
        await client.query(
            `UPDATE rooms SET ${setClauses.join(', ')} WHERE room_id = $${paramIndex}`,
            params
        );

        logger.info('Room settings updated:', roomId);
        return true;
    }, []);
}

async function deleteRoom(roomId) {
    logger.info('Soft-deleting room:', roomId);
    return queueDatabaseWrite(async (client) => {
        await client.query(
            'UPDATE rooms SET is_active = FALSE WHERE room_id = $1',
            [roomId]
        );
        logger.info('Room soft-deleted:', roomId);
    }, []);
}

async function addRoomMember(roomId, userId, role = 'member') {
    logger.info('Adding member', userId, 'to room', roomId, 'with role', role);
    return queueDatabaseWrite(async (client) => {
        await client.query(
            `INSERT INTO room_members (room_id, user_id, role, joined_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (room_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
            [roomId, userId, role]
        );
    }, []);
}

async function removeRoomMember(roomId, userId) {
    return queueDatabaseWrite(async (client) => {
        await client.query(
            'DELETE FROM room_members WHERE room_id = $1 AND user_id = $2',
            [roomId, userId]
        );
    }, []);
}

async function getRoomMembers(roomId) {
    const result = await pool.query(
        `SELECT rm.user_id, rm.role, rm.joined_at, u.username, u.username_color
         FROM room_members rm
         LEFT JOIN users u ON rm.user_id = u.user_id
         WHERE rm.room_id = $1
         ORDER BY rm.joined_at ASC`,
        [roomId]
    );
    return result.rows;
}

async function getUserRooms(userId) {
    const result = await pool.query(
        `SELECT r.*, rm.role, rm.joined_at
         FROM rooms r
         INNER JOIN room_members rm ON r.room_id = rm.room_id
         WHERE rm.user_id = $1 AND r.is_active = TRUE
         ORDER BY rm.joined_at DESC`,
        [userId]
    );
    return result.rows;
}

async function isUserInRoom(roomId, userId) {
    const result = await pool.query(
        'SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2',
        [roomId, userId]
    );
    return result.rows.length > 0;
}

async function getUserRoomRole(roomId, userId) {
    const result = await pool.query(
        'SELECT role FROM room_members WHERE room_id = $1 AND user_id = $2',
        [roomId, userId]
    );
    return result.rows[0]?.role || null;
}

async function createDefaultGlobalRoom() {
    const globalRoomId = 'global-room-00000000-0000-0000-0000-000000000000';
    const existing = await getRoomById(globalRoomId);
    if (existing) {
        logger.info('Global room already exists');
        return;
    }

    return queueDatabaseWrite(async (client) => {
        await client.query(
            `INSERT INTO rooms (room_id, name, description, is_active, created_at)
             VALUES ($1, 'Global Room', 'Default room for all users (backward compatibility)', TRUE, NOW())
             ON CONFLICT (room_id) DO NOTHING`,
            [globalRoomId]
        );
        logger.info('Created default global room');
    }, []);
}

async function migrateExistingDataToGlobalRoom() {
    logger.info('Checking for legacy data migration...');

    const globalRoomId = 'global-room-00000000-0000-0000-0000-000000000000';

    const nullRoomCheck = await pool.query(
        'SELECT 1 FROM aichats WHERE room_id IS NULL LIMIT 1'
    );

    if (nullRoomCheck.rows.length === 0) {
        logger.info('No legacy data to migrate');
        return;
    }

    logger.info('Migrating legacy data to global room...');

    return queueDatabaseWrite(async (client) => {
        await client.query(
            'UPDATE aichats SET room_id = $1 WHERE room_id IS NULL',
            [globalRoomId]
        );
        await client.query(
            'UPDATE userchats SET room_id = $1 WHERE room_id IS NULL',
            [globalRoomId]
        );
        await client.query(
            'UPDATE sessions SET room_id = $1 WHERE room_id IS NULL',
            [globalRoomId]
        );
        await client.query(
            'UPDATE "userSessions" SET room_id = $1 WHERE room_id IS NULL',
            [globalRoomId]
        );

        logger.info('Legacy data migration complete');
    }, []);
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
    pool,
    ensureDatabaseSchema,
    queueDatabaseWrite,
    collapseNewlines,
    generateUUID,
    generateAuthUUID,

    // User management
    upsertUser,
    upsertUserRole,
    getUser,
    getUsers,
    getUserByUsername,
    checkUsernameAvailable,
    getUserColor,
    registerUser,
    authenticateUser,

    // Character management
    upsertChar,
    getCharacters,
    getLatestCharacter,
    getCharacterColor,
    syncCharactersToDatabase,
    ensureCharacterExists,

    // Session management
    newSession,
    newUserChatSession,
    setActiveChat,
    getActiveChat,
    getSessionRoom,
    getRoomActiveSession,

    // Chat operations
    writeAIChatMessage,
    writeUserChatMessage,
    readAIChat,
    readUserChat,
    getMessage,
    getAIChatMessageRow,
    editMessage,
    deleteAIChatMessage,
    deleteUserChatMessage,
    removeLastAIChatMessage,
    getNextMessageID,

    // Past chats
    getPastChats,
    deletePastChat,
    exportSession,

    // API management
    upsertAPI,
    getAPIs,
    getAPI,
    deleteAPI,

    // Lorebook management
    createLorebook,
    getLorebooks,
    getLorebook,
    updateLorebook,
    deleteLorebook,
    createLorebookEntry,
    getLorebookEntries,
    updateLorebookEntry,
    deleteLorebookEntry,
    getAllEnabledEntries,

    // Room management
    createRoom,
    getRooms,
    getRoomById,
    getAllActiveRooms,
    updateRoomSettings,
    deleteRoom,
    addRoomMember,
    removeRoomMember,
    getRoomMembers,
    getUserRooms,
    isUserInRoom,
    getUserRoomRole,
    createDefaultGlobalRoom,
    migrateExistingDataToGlobalRoom
};
