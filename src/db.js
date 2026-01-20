import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { dbLogger as logger } from './log.js';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';


// Connect to the SQLite database
const dbPromise = open({
    filename: './stmp.db',
    driver: sqlite3.Database
}).then(async (db) => {
    await db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA cache_size = 1000;
        PRAGMA temp_store = MEMORY;
        PRAGMA mmap_size = 268435456;
    `);
    return db;
});

const schemaDictionary = {
    // Room tables for message isolation
    rooms: {
        room_id: "TEXT UNIQUE PRIMARY KEY",
        name: "TEXT NOT NULL",
        description: "TEXT",
        created_by: "TEXT",
        created_at: "DATETIME DEFAULT CURRENT_TIMESTAMP",
        settings: "TEXT", // JSON: room-specific config (character, API, etc.)
        is_active: "BOOLEAN DEFAULT TRUE", // Soft delete flag
        foreignKeys: {
            created_by: "users(user_id)"
        }
    },
    room_members: {
        id: "INTEGER PRIMARY KEY", // Composite key workaround
        room_id: "TEXT NOT NULL",
        user_id: "TEXT NOT NULL",
        joined_at: "DATETIME DEFAULT CURRENT_TIMESTAMP",
        role: "TEXT DEFAULT 'member'", // 'creator', 'moderator', 'member'
        foreignKeys: {
            room_id: "rooms(room_id)",
            user_id: "users(user_id)"
        }
    },
    users: {
        user_id: "TEXT UNIQUE PRIMARY KEY",
        username: "TEXT",
        username_color: "TEXT",
        persona: "TEXT",
        password_hash: "TEXT", // bcrypt hashed password (null for legacy/anonymous users)
        email: "TEXT", // Optional email for account recovery
        created_at: "DATETIME DEFAULT CURRENT_TIMESTAMP",
        last_seen_at: "DATETIME DEFAULT CURRENT_TIMESTAMP"
    },

    user_roles: {
        user_id: "TEXT UNIQUE PRIMARY KEY",
        role: "TEXT DEFAULT 'user'",
        foreignKeys: {
            user_id: "users(user_id)"
        }
    },
    characters: {
        char_id: "TEXT UNIQUE PRIMARY KEY",
        displayname: "TEXT",
        display_color: "TEXT",
        created_at: "DATETIME DEFAULT CURRENT_TIMESTAMP",
        last_seen_at: "DATETIME DEFAULT CURRENT_TIMESTAMP"
    },
    aichats: {
        message_id: "INTEGER PRIMARY KEY",
        session_id: "INTEGER",
        room_id: "TEXT", // Room isolation - CRITICAL for sync safety
        user_id: "TEXT",
        username: "TEXT",
        message: "TEXT",
        entity: "TEXT",
        timestamp: "DATETIME DEFAULT CURRENT_TIMESTAMP",
        foreignKeys: {
            session_id: "sessions(session_id)",
            user_id: "users(user_id)",
            room_id: "rooms(room_id)"
        }
    },
    userchats: {
        message_id: "INTEGER PRIMARY KEY",
        session_id: "INTEGER",
        room_id: "TEXT", // Room isolation - CRITICAL for sync safety
        user_id: "TEXT",
        message: "TEXT",
        timestamp: "DATETIME DEFAULT CURRENT_TIMESTAMP",
        active: "BOOLEAN DEFAULT TRUE",
        foreignKeys: {
            session_id: "userSessions(session_id)",
            user_id: "users(user_id)",
            room_id: "rooms(room_id)"
        }
    },
    sessions: {
        session_id: "INTEGER PRIMARY KEY",
        room_id: "TEXT", // Room isolation - CRITICAL for sync safety
        started_at: "DATETIME DEFAULT CURRENT_TIMESTAMP",
        ended_at: "DATETIME",
        is_active: "BOOLEAN DEFAULT TRUE",
        foreignKeys: {
            room_id: "rooms(room_id)"
        }
    },
    userSessions: {
        session_id: "INTEGER PRIMARY KEY",
        room_id: "TEXT", // Room isolation - CRITICAL for sync safety
        started_at: "DATETIME DEFAULT CURRENT_TIMESTAMP",
        ended_at: "DATETIME",
        is_active: "BOOLEAN DEFAULT TRUE",
        foreignKeys: {
            room_id: "rooms(room_id)"
        }
    },
    apis: {
        name: "TEXT UNIQUE PRIMARY KEY",
        endpoint: "TEXT",
        key: "TEXT",
        type: "TEXT",
        claude: "BOOLEAN DEFAULT FALSE", //saves as INTEGER 0 or 1
        useTokenizer: "BOOLEAN DEFAULT FALSE",
        created_at: "DATETIME DEFAULT CURRENT_TIMESTAMP",
        last_used_at: "DATETIME DEFAULT CURRENT_TIMESTAMP",
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
        created_at: "DATETIME DEFAULT CURRENT_TIMESTAMP"
    },
    lorebook_entries: {
        entry_id: "TEXT UNIQUE PRIMARY KEY",
        lorebook_id: "TEXT",
        title: "TEXT",
        keys: "TEXT", // JSON array of trigger keywords
        content: "TEXT",
        enabled: "BOOLEAN DEFAULT TRUE",
        strategy: "TEXT DEFAULT 'keyword'", // 'constant', 'keyword', or 'disabled'
        position: "TEXT DEFAULT 'afterCharDefs'",
        insertion_order: "INTEGER DEFAULT 100",
        depth: "INTEGER",
        trigger_percent: "INTEGER DEFAULT 100",
        created_at: "DATETIME DEFAULT CURRENT_TIMESTAMP",
        foreignKeys: {
            lorebook_id: "lorebooks(lorebook_id)"
        }
    }
};


// Database write queue for serialization
let isWriting = false;
const writeQueue = [];

async function queueDatabaseWrite(dbOperation, params) {
    const operationName = dbOperation.name || 'anonymous';
    //logger.info(`Queuing database write for operation: ${operationName}`);
    return new Promise((resolve, reject) => {
        writeQueue.push({ dbOperation, params, resolve, reject, operationName });
        processWriteQueue();
    });
}

async function processWriteQueue() {
    if (isWriting || writeQueue.length === 0) return;
    isWriting = true;

    const { dbOperation, params, resolve, reject, operationName } = writeQueue.shift();
    //logger.info(`Processing database write for operation: ${operationName}`);
    const db = await dbPromise;

    let transactionStarted = false;
    try {
        await db.run('BEGIN TRANSACTION');
        transactionStarted = true;
        const result = await dbOperation(db, ...params);
        await db.run('COMMIT');
        //logger.info(`Completed database write for operation: ${operationName}`);
        resolve(result);
    } catch (err) {
        if (transactionStarted) {
            try {
                await db.run('ROLLBACK');
                //logger.info('Rollback successful');
            } catch (rollbackErr) {
                logger.error('Error during rollback:', rollbackErr);
            }
        }
        logger.error('Error executing database write:', err, { operation: operationName, params });
        reject(err);
    } finally {
        isWriting = false;
        processWriteQueue(); // Process next write
    }
}

// Optional: Monitor queue length to detect bottlenecks
setInterval(() => {
    if (writeQueue.length > 0) {
        logger.warn(`Database write queue length: ${writeQueue.length}`);
    }
}, 60 * 1000);


async function ensureDatabaseSchema(schemaDictionary) {
    console.info('Ensuring database schema...');
    const db = await dbPromise;
    for (const [tableName, tableSchema] of Object.entries(schemaDictionary)) {
        // Create the table if it doesn't exist
        let createTableQuery = `CREATE TABLE IF NOT EXISTS ${tableName} (`;
        const columnDefinitions = [];
        for (const [columnName, columnType] of Object.entries(tableSchema)) {
            if (columnName !== 'foreignKeys') {
                columnDefinitions.push(`${columnName} ${columnType}`);
            }
        }

        // Adding foreign keys if they exist
        if (tableSchema.foreignKeys) {
            for (const [fkColumn, fkReference] of Object.entries(tableSchema.foreignKeys)) {
                columnDefinitions.push(`FOREIGN KEY (${fkColumn}) REFERENCES ${fkReference}`);
            }
        }

        createTableQuery += columnDefinitions.join(', ') + ')';
        await db.run(createTableQuery);

        // Check and add columns if they don't exist
        const tableInfo = await db.all(`PRAGMA table_info(${tableName})`);
        const existingColumns = tableInfo.map(column => column.name);

        for (const [columnName, columnType] of Object.entries(tableSchema)) {
            if (columnName !== 'foreignKeys' && !existingColumns.includes(columnName)) {
                const addColumnQuery = `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`;
                await db.run(addColumnQuery);
            }
        }
    }
    await db.run(`INSERT OR IGNORE INTO apis (name, endpoint, key, type, claude) VALUES ('Default', 'localhost:5000', '', 'TC', FALSE)`);
}


// Write the session ID of whatever the active session in the sessions table is
async function writeUserChatMessage(userId, message) {
    logger.debug('Writing user chat message to database...');
    return queueDatabaseWrite(async (db) => {
        let insertQuery = '';
        let params = [];

        // Retrieve the active user session
        const activeSession = await db.get('SELECT session_id FROM userSessions WHERE is_active = TRUE');
        let session_id;

        if (activeSession) {
            session_id = activeSession.session_id;
            logger.debug(`Using existing user session_id: ${session_id}`);
        } else {
            const maxSession = await db.get('SELECT MAX(session_id) AS max_session_id FROM userSessions');
            session_id = maxSession.max_session_id ? maxSession.max_session_id + 1 : 1;
            await db.run(
                'INSERT INTO userSessions (session_id, is_active, started_at) VALUES (?, ?, ?)',
                [session_id, 1, new Date().toISOString()]
            );
            logger.debug(`Created new user session_id: ${session_id}`);
        }

        // Generate timestamp
        const timestamp = new Date().toISOString();

        // Insert new message
        insertQuery = `
            INSERT INTO userchats (user_id, message, timestamp, active, session_id)
            VALUES (?, ?, ?, ?, ?)
        `;
        params = [userId, message, timestamp, 1, session_id];
        const result = await db.run(insertQuery, params);

        const message_id = result.lastID;
        logger.debug(`Inserted user chat message ${message_id} with session_id ${session_id}`);
        return { message_id, session_id, user_id: userId, message, timestamp };
    }, []);
}


// If roomId is provided, only return sessions for that room
async function getPastChats(type, roomId = null) {
    logger.info(`[getPastChats] Getting data for past ${type} chats... Room: ${roomId || 'ALL (global)'}`);
    const db = await dbPromise;
    try {
        // Build query with optional room filter
        // When roomId is provided, only return sessions FOR THAT SPECIFIC ROOM
        // Sessions with NULL room_id are legacy and won't be shown in specific rooms
        let roomFilter = '';
        let params = [];
        if (roomId) {
            roomFilter = 'AND s.room_id = ?';
            params = [roomId];
        }
        
        const query = `
            SELECT s.session_id, s.started_at, s.ended_at, s.is_active, s.room_id, a.user_id, a.timestamp,
            strftime('%Y-%m-%d %H:%M:%S', a.timestamp, 'localtime') AS local_timestamp
            FROM sessions s
            JOIN aichats a ON s.session_id = a.session_id
            WHERE 1=1 ${roomFilter}
            ORDER BY s.started_at ASC
        `;
        
        logger.debug(`[getPastChats] Query: ${query.replace(/\s+/g, ' ').trim()}, Params: ${JSON.stringify(params)}`);
        const rows = await db.all(query, params);

        const result = {};

        for (const row of rows) {
            const sessionID = row.session_id;

            // Create a 'messages' object for each unique session_id
            if (!result[sessionID]) {
                result[sessionID] = {
                    session_id: row.session_id,
                    room_id: row.room_id,
                    started_at: row.started_at,
                    ended_at: row.ended_at,
                    is_active: row.is_active,
                    aiName: null,
                    messageCount: 0,
                    latestTimestamp: null
                };
            }

            // Check if the user_id does not contain a hyphen to determine if it's an AI user
            if (!row.user_id.includes('-')) {
                const aiName = row.user_id;
                if (!result[sessionID].aiName) {
                    result[sessionID].aiName = aiName;
                } else if (!result[sessionID].aiName.includes(aiName)) {
                    result[sessionID].aiName += `, ${aiName}`;
                }
            }

            // Use the local_timestamp directly from the row
            const localTimestamp = row.local_timestamp;

            // Update the message count and latest timestamp for the session
            result[sessionID].messageCount++;
            result[sessionID].latestTimestamp = localTimestamp;
        }

        return result;
    } catch (err) {
        logger.error('An error occurred while reading from the database:', err);
        throw err;
    }
}

async function deletePastChat(sessionID) {

    logger.debug('Deleting past chat... ' + sessionID);
    //const db = await dbPromise;
    return queueDatabaseWrite(async (db) => {
        let wasActive = false;
        try {
            const row = await db.get('SELECT * FROM sessions WHERE session_id = ?', [sessionID]);
            if (row) {
                await db.run('DELETE FROM aichats WHERE session_id = ?', [sessionID]);
                if (row.is_active) {
                    wasActive = true;
                }
                await db.run('DELETE FROM sessions WHERE session_id = ?', [row.session_id]);
                logger.debug(`Session ${sessionID} was deleted`);
            }
            return ['ok', wasActive];
        } catch (err) {
            logger.error('Error deleting session:', err);
        }
    }, [sessionID]);
}

async function deleteAIChatMessage(mesID) {
    logger.info('Deleting AI chat message... ' + mesID);
    //const db = await dbPromise;
    return queueDatabaseWrite(async (db) => {
        try {
            const row = await db.get('SELECT * FROM aichats WHERE message_id = ?', [mesID]);
            if (row) {
                await db.run('DELETE FROM aichats WHERE message_id = ?', [mesID]);
                logger.debug(`Message ${mesID} was deleted`);
                return 'ok';
            }

        } catch (err) {
            logger.error('Error deleting message:', err);
            return 'error';
        }
    }, [mesID]);
}

async function deleteUserChatMessage(mesID) {
    logger.info('Deleting user chat message... ' + mesID);
    //const db = await dbPromise;
    return queueDatabaseWrite(async (db) => {
        try {
            const row = await db.get('SELECT * FROM userchats WHERE message_id = ?', [mesID]);
            if (row) {
                await db.run('DELETE FROM userchats WHERE message_id = ?', [mesID]);
                logger.info(`User chat message ${mesID} was deleted`);
                return 'ok';
            }

        } catch (err) {
            logger.error('Error deleting message:', err);
            return 'error';
        }
    }, [mesID]);
}

async function deleteAPI(APIName) {

    logger.debug('[deleteAPI()] Deleting API named:' + APIName);
    //const db = await dbPromise;
    return queueDatabaseWrite(async (db) => {
        try {
            const row = await db.get('SELECT * FROM apis WHERE name = ?', [APIName]);
            if (row) {
                await db.run('DELETE FROM apis WHERE name = ?', [APIName]);
                logger.debug(`API ${APIName} was deleted`);
            }
            return ['ok'];
        } catch (err) {
            logger.error('Error deleting API:', err);
        }
    }, [APIName]);
}

// Only read the user chat messages that are active
async function readUserChat() {
    //logger.debug('Reading user chat...');
    const db = await dbPromise;
    let foundSessionID;

    try {
        const rows = await db.all(`
            SELECT 
                u.username,
                u.username_color,
                uc.message,
                uc.message_id,
                uc.session_id,
                ur.role AS userRole,
                uc.timestamp
            FROM userchats uc 
            LEFT JOIN users u ON uc.user_id = u.user_id
            LEFT JOIN user_roles ur ON uc.user_id = ur.user_id
            WHERE uc.active = TRUE
            ORDER BY uc.timestamp ASC 
        `);

        if (rows.length === 0) {
            logger.warn('No active user chats found.');
        }

        const result = JSON.stringify(rows.map(row => ({
            username: row.username || 'Unknown',
            content: row.message,
            userColor: row.username_color || '#FFFFFF',
            messageID: row.message_id,
            sessionID: row.session_id,
            role: row.userRole || null,
            timestamp: row.timestamp
        })));

        if (rows.length > 0) {
            foundSessionID = rows[0].session_id;
            //logger.debug(`Found ${rows.length} active user chats in session ${foundSessionID}`);
        }

        return [result, foundSessionID];

    } catch (err) {
        logger.error('An error occurred while reading from the database:', err);
        throw err;
    }
}


//Remove last AI chat in the current session from the database
async function removeLastAIChatMessage() {
    logger.info('Removing last AI chat message...');
    //const db = await dbPromise;
    return queueDatabaseWrite(async (db) => {
        try {
            const session = await db.get('SELECT session_id FROM sessions WHERE is_active = 1 LIMIT 1');
            if (!session) {
                logger.error('Tried to remove last message from AIChat, but no active session found. Returning null.');
                return null;
            }

            const row = await db.get('SELECT message_id FROM aichats WHERE session_id = ? ORDER BY message_id DESC LIMIT 1', [session.session_id]);
            if (row) {
                await db.run('DELETE FROM aichats WHERE message_id = ?', [row.message_id]);
                logger.info(`Deleted last message ${row.message_id} from session ${session.session_id}`);
            }
            return session.session_id;
        } catch (err) {
            logger.error('Error deleting message:', err);
            return null;

        }
    }, []);
}

// If roomId is provided, only deactivate sessions in that room
async function setActiveChat(sessionID, roomId = null) {
    logger.info('Setting session ' + sessionID + ' as active...' + (roomId ? ` (room: ${roomId})` : ''));
    return queueDatabaseWrite(async (db) => {
        try {
            if (roomId) {
                // Only deactivate sessions in the same room
                await db.run('UPDATE sessions SET is_active = 0 WHERE is_active = 1 AND room_id = ?', [roomId]);
            } else {
                // Global deactivation (backward compatibility)
                await db.run('UPDATE sessions SET is_active = 0 WHERE is_active = 1');
            }
            await db.run('UPDATE sessions SET is_active = 1 WHERE session_id = ?', [sessionID]);
            logger.info(`Session ${sessionID} was set as active.`);
        } catch (err) {
            logger.error(`Error setting session ${sessionID} as active:`, err);
        }
    }, [sessionID, roomId]);
}

/**
 * Get the room a session belongs to
 * @param {number} sessionId - Session ID
 * @returns {Promise<object|null>} Session info with room_id, or null
 */
async function getSessionRoom(sessionId) {
    const db = await dbPromise;
    try {
        const row = await db.get('SELECT session_id, room_id FROM sessions WHERE session_id = ?', [sessionId]);
        return row || null;
    } catch (err) {
        logger.error(`Error getting session room for ${sessionId}:`, err);
        return null;
    }
}

async function getActiveChat() {
    const db = await dbPromise;
    try {
        const row = await db.get('SELECT session_id FROM sessions WHERE is_active = 1 LIMIT 1');
        if (!row) {
            logger.error('Tried to get active session, but no active session found. Returning null.');
            return null;
        }

        if (row.session_id === null) {
            logger.error('Found active session, but session_id is null. Returning null.');
            return null;
        }
        //logger.debug('Found active session with session_id: ' + row.session_id);
        return row.session_id;

    } catch (err) {
        logger.error('Error getting active session:', err);
        return null;
    }
}

//this might not be necessary, but just in case. 
function collapseNewlines(x) {
    x.replace(/\r/g, '');
    return x.replaceAll(/\n+/g, '\n');
}

// Write an AI chat message to the database
// If roomId is provided, writes to a room-specific session
async function writeAIChatMessage(username, userId, message, entity, roomId = null) {
    logger.info('Writing AI chat message...Username: ' + username + ', User ID: ' + userId + ', Entity: ' + entity + ', RoomID: ' + (roomId || 'global'));

    return queueDatabaseWrite(async (db) => {
        collapseNewlines(message)
        try {
            let sessionId;
            
            if (roomId) {
                // Get or create a room-specific session
                const row = await db.get(
                    'SELECT session_id FROM sessions WHERE room_id = ? AND is_active = TRUE',
                    [roomId]
                );
                if (!row) {
                    logger.info(`No active session found for room ${roomId}, creating a new session...`);
                    await db.run('INSERT INTO sessions (room_id) VALUES (?)', [roomId]);
                    sessionId = (await db.get(
                        'SELECT session_id FROM sessions WHERE room_id = ? AND is_active = TRUE',
                        [roomId]
                    )).session_id;
                    logger.info(`New room session created with session_id ${sessionId} for room ${roomId}`);
                } else {
                    sessionId = row.session_id;
                }
            } else {
                // Fallback to global session (backward compatibility)
                const row = await db.get('SELECT session_id FROM sessions WHERE is_active = TRUE');
                if (!row) {
                    logger.warn('No active session found, creating a new session...');
                    await db.run('INSERT INTO sessions DEFAULT VALUES');
                    sessionId = (await db.get('SELECT session_id FROM sessions WHERE is_active = TRUE')).session_id;
                    logger.info(`A new session was created with session_id ${sessionId}`);
                } else {
                    sessionId = row.session_id;
                }
            }
            
            const timestamp = new Date().toISOString();
            await db.run(
                'INSERT INTO aichats (session_id, user_id, message, username, entity, timestamp, room_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [sessionId, userId, message, username, entity, timestamp, roomId]
            );
            let resultingMessageID = (await db.get('SELECT message_id FROM aichats WHERE session_id = ? ORDER BY message_id DESC LIMIT 1', [sessionId]))?.message_id;

            // Return details so callers can include metadata in outbound events
            return { sessionId, message_id: resultingMessageID, timestamp };
        } catch (err) {
            logger.error('Error writing AI chat message:', err);
        }
    }, [username, userId, message, entity, roomId]);
}

// Create a new session, optionally for a specific room
async function newSession(roomId = null) {
    logger.info(`Creating a new session...${roomId ? ` (room: ${roomId})` : ' (global)'}`);
    return queueDatabaseWrite(async (db) => {
        try {
            if (roomId) {
                // Only end sessions in the same room
                await db.run('UPDATE sessions SET is_active = FALSE, ended_at = CURRENT_TIMESTAMP WHERE is_active = TRUE AND room_id = ?', [roomId]);
                await db.run('INSERT INTO sessions (room_id, is_active) VALUES (?, TRUE)', [roomId]);
                const newSessionID = (await db.get('SELECT session_id FROM sessions WHERE is_active = TRUE AND room_id = ?', [roomId])).session_id;
                logger.info(`Created new room session with session_id ${newSessionID} for room ${roomId}`);
                return newSessionID;
            } else {
                // Global session (backward compatibility)
                await db.run('UPDATE sessions SET is_active = FALSE, ended_at = CURRENT_TIMESTAMP WHERE is_active = TRUE');
                await db.run('INSERT INTO sessions DEFAULT VALUES');
                const newSessionID = (await db.get('SELECT session_id FROM sessions WHERE is_active = TRUE')).session_id;
                logger.info('Creating a new session with session_id ' + newSessionID + '...');
                return newSessionID;
            }
        } catch (error) {
            logger.error('Error creating a new session:', error);
        }
    }, [roomId]);
}

// mark currently active user chat entries as inactive
async function newUserChatSession() {
    logger.info('Creating a new user chat session...');
    return queueDatabaseWrite(async function newUserChatSessionOP(db) {
        // Deactivate userchats
        const userChatResult = await db.run('UPDATE userchats SET active = FALSE WHERE active = TRUE');
        logger.debug(`Deactivated ${userChatResult.changes} user chat rows.`);

        // Deactivate userSessions
        const sessionResult = await db.run('UPDATE userSessions SET is_active = FALSE WHERE is_active = TRUE');
        logger.debug(`Deactivated ${sessionResult.changes} user session rows.`);

        return {
            success: true,
            userChatChanges: userChatResult.changes,
            userSessionChanges: sessionResult.changes
        };
    }, []);
}

// Create or update the user in the database
async function upsertUser(uuid, username, color, persona = '') {
    logger.info('Adding/updating user...' + uuid);

    //const db = await dbPromise;
    return queueDatabaseWrite(async (db) => {
        try {
            // First check if user exists to preserve existing persona if not provided
            const existing = await db.get('SELECT persona FROM users WHERE user_id = ?', [uuid]);
            const personaToSave = persona || (existing?.persona || '');
            
            logger.debug(`[upsertUser] UUID: ${uuid}, incoming persona: "${persona}", existing: "${existing?.persona}", saving: "${personaToSave}"`);
            
            await db.run('INSERT OR REPLACE INTO users (user_id, username, username_color, persona, last_seen_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)', [uuid, username, color, personaToSave]);
            logger.debug('A user was upserted');
        } catch (err) {
            logger.error('Error writing user:', err);
        }
    }, [uuid, username, color, persona]);
}


async function upsertUserRole(uuid, role) {

    logger.info('Adding/updating user role...' + uuid + ' ' + role);
    //const db = await dbPromise;
    return queueDatabaseWrite(async (db) => {
        try {
            await db.run('INSERT OR REPLACE INTO user_roles (user_id, role) VALUES (?, ?)', [uuid, role]);
            logger.debug('A user role was upserted');
        } catch (err) {
            logger.error('Error writing user role:', err);
        }
    }, [uuid, role]);
}

// Create or update the character in the database
async function upsertChar(char_id, displayname, color) {
    logger.debug(`Adding/updating ${displayname} (${char_id})`);
    return queueDatabaseWrite(async (db) => {
        const existingRow = await db.get('SELECT displayname FROM characters WHERE char_id = ?', [char_id]);

        if (!existingRow) {
            // Case 1: Row with matching char_id doesn't exist, create a new row
            await db.run(
                'INSERT INTO characters (char_id, displayname, display_color, last_seen_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)',
                [char_id, displayname, color]
            );
            logger.debug(`A new character was inserted, ${char_id}, ${displayname}`);
        } else if (existingRow.displayname !== displayname) {
            // Case 2: Row with matching char_id exists, but displayname is different, update displayname and last_seen_at
            await db.run(
                'UPDATE characters SET displayname = ?, last_seen_at = CURRENT_TIMESTAMP WHERE char_id = ?',
                [displayname, char_id]
            );
            logger.debug(`Updated displayname for character from ${existingRow.displayname} to ${displayname}`);
        } else {
            // Case 3: Row with matching char_id AND displayname exists, only update last_seen_at
            await db.run('UPDATE characters SET last_seen_at = CURRENT_TIMESTAMP WHERE char_id = ?', [char_id]);
            // logger.debug('Last seen timestamp was updated');
        }
    }, [char_id, displayname, color]); // Explicitly pass empty params array
}

// Retrieve the character with the most recent last_seen_at value
async function getLatestCharacter() {
    logger.debug('Retrieving the character with the most recent last_seen_at value');
    const db = await dbPromise;
    try {
        const character = await db.get('SELECT * FROM characters ORDER BY last_seen_at DESC LIMIT 1');
        return character;
    } catch (err) {
        logger.error('Error retrieving character:', err);
        return null;
    }
}

// Get user info from the database, including the role
async function getUser(uuid) {
    logger.debug('Getting user...' + uuid);
    const db = await dbPromise;
    try {
        return await db.get('SELECT u.user_id, u.username, u.username_color, u.persona, u.created_at, u.last_seen_at, ur.role FROM users u LEFT JOIN user_roles ur ON u.user_id = ur.user_id WHERE u.user_id = ?', [uuid]);
    } catch (err) {
        logger.error('Error getting user:', err);
        throw err;
    }
}

// Read AI chat data from the SQLite database
// If roomId is provided, reads only from that room's session
async function readAIChat(sessionID = null, roomId = null) {
    const db = await dbPromise;
    let wasAutoDiscovered = false;

    if (!sessionID) {
        let activeSession;
        if (roomId) {
            // Get active session for specific room
            activeSession = await db.get(
                'SELECT session_id FROM sessions WHERE room_id = ? AND is_active = 1 LIMIT 1',
                [roomId]
            );
        } else {
            // Fallback to global active session (backward compatibility)
            activeSession = await db.get('SELECT session_id FROM sessions WHERE is_active = 1 LIMIT 1');
        }
        if (!activeSession) return [JSON.stringify([]), null];
        sessionID = activeSession.session_id;
        wasAutoDiscovered = true;
    }

    const rows = await db.all(`
        SELECT 
            a.username,
            a.message,
            CASE
                WHEN u.user_id IS NULL THEN 
                    (SELECT c.display_color FROM characters c WHERE c.char_id = a.user_id)
                ELSE 
                    u.username_color
            END AS userColor,
            a.message_id,
            a.session_id,
            a.entity,
            ur.role AS userRole,
            u.persona AS userPersona,
            a.timestamp
        FROM aichats a
        LEFT JOIN users u ON a.user_id = u.user_id
        LEFT JOIN user_roles ur ON a.user_id = ur.user_id
        WHERE a.session_id = ?
        ORDER BY a.timestamp ASC
    `, [sessionID]);

    const result = JSON.stringify(rows.map(row => ({
        username: row.username,
        content: row.message,
        userColor: row.userColor,
        sessionID: row.session_id,
        messageID: row.message_id,
        entity: row.entity,
        role: row.userRole ?? null,
        persona: row.userPersona || '',
        timestamp: row.timestamp
    })
    ));

    return [result, sessionID];
}

async function getNextMessageID() {
    const db = await dbPromise;
    try {
        const row = await db.get('SELECT MAX(message_id) AS maxMessageID FROM aichats');
        return (row?.maxMessageID ?? 0) + 1;
    } catch (err) {
        logger.error('Failed to get next message ID:', err);
        return 1; // fallback for empty DB
    }
}

async function getUserColor(UUID) {
    //logger.debug('Getting user color...' + UUID);
    const db = await dbPromise;
    try {
        const row = await db.get('SELECT username_color FROM users WHERE user_id = ?', [UUID]);
        if (row) {
            const userColor = row.username_color;
            return userColor;
        } else {
            logger.warn(`User not found for UUID: ${UUID}`);
            return null;
        }
    } catch (err) {
        logger.error('Error getting user color:', err);
        throw err;
    }
}

async function getCharacterColor(charName) {
    //logger.debug('Getting character color...' + charName);
    const db = await dbPromise;
    try {
        const row = await db.get('SELECT display_color FROM characters WHERE char_id = ?', [charName]);
        if (row) {
            const charColor = row.display_color;
            logger.debug(`Character color: ${charColor}`);
            return charColor;
        } else {
            logger.warn(`Character '${charName}' not found.`);
            return null;
        }
    } catch (err) {
        logger.error(`Error getting color for ${charName}: ${err}`);
        throw err;
    }
}

//currently userchats aren't editable, so we only look at aichats.
async function getMessage(messageID, sessionID) {
    logger.debug(`Getting AIChat message ${messageID}, sessionID: ${sessionID}`);
    const db = await dbPromise;
    try {
        logger.debug(`trying for message...`);
        let result = await db.get(
            'SELECT * FROM aichats WHERE message_id = ? AND session_id = ?',
            [messageID, sessionID]
        );
        if (!result) {
            logger.error(`Message not found for messageID ${messageID} and sessionID ${sessionID}. this is result: ${result}`);
            return null;
        }
        if (result) logger.debug(`Message found, returning message text.`); //: ${result.message}`);
        return result.message

    } catch (err) {
        logger.error('Error getting AI chat message:', err);
        throw err;
    }
}

async function editMessage(sessionID, mesID, newMessage) {
    logger.info('Editing AIChat message... ' + mesID);
    return queueDatabaseWrite(async (db, sessionID, mesID, newMessage) => {
        await db.run('UPDATE aichats SET message = ? WHERE message_id = ?', [newMessage, mesID]);
        logger.info(`Message ${mesID} was edited.`);
        //let sessionID = await getActiveChat()
        let proof = await getMessage(mesID, sessionID);
        console.info('edited message result: ', proof);
        return 'ok';
    }, [sessionID, mesID, newMessage]);
}


//takes an object with keys in this order: name, endpoint, key, type, claude, modelList (array), selectedModel
async function upsertAPI(apiData) {
    logger.info('Adding/updating API...');
    logger.trace(apiData)

    const { name, endpoint, key, type } = apiData;
    let { claude, useTokenizer, modelList, selectedModel } = apiData;
    logger.info('Adding/updating API...' + name);

    // Minimal required fields
    if ([name, endpoint, type].some((v) => v === undefined || v === null || v === '')) {
        logger.error('API missing required fields (name/endpoint/type); cannot register.');
        logger.error(apiData);
        return;
    }

    return queueDatabaseWrite(async (db) => {
        try {
            // Pull existing row to fill defaults for optional fields
            const existing = await db.get('SELECT * FROM apis WHERE name = ?', [name]);
            // Normalize booleans
            const claudeFinal = typeof claude === 'boolean' ? claude : !!(existing && existing.claude);
            const useTokenizerFinal = typeof useTokenizer === 'boolean' ? useTokenizer : !!(existing && existing.useTokenizer);
            // Model list and selected model defaults
            let modelListFinal;
            if (modelList !== undefined) {
                modelListFinal = Array.isArray(modelList) ? modelList : []; // client sends array
            } else if (existing && typeof existing.modelList === 'string') {
                try { modelListFinal = JSON.parse(existing.modelList) || []; } catch { modelListFinal = []; }
            } else {
                modelListFinal = [];
            }
            const selectedModelFinal = (selectedModel !== undefined) ? selectedModel : (existing?.selectedModel || '');

            await db.run(
                'INSERT OR REPLACE INTO apis (name, endpoint, key, type, claude, useTokenizer, modelList, selectedModel) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [
                    name,
                    endpoint,
                    key || '',
                    type,
                    claudeFinal ? 1 : 0,
                    useTokenizerFinal ? 1 : 0,
                    JSON.stringify(modelListFinal),
                    selectedModelFinal,
                ]
            );
            logger.debug('An API was upserted');

            const nullRows = await db.get(
                'SELECT * FROM apis WHERE name IS NULL OR endpoint IS NULL OR name = "" OR endpoint = ""'
            );
            if (nullRows) {
                await db.run(
                    'DELETE FROM apis WHERE name IS NULL OR endpoint IS NULL OR name = "" OR endpoint = ""'
                );
                logger.debug('Cleaned up rows with no name or endpoint values');
            }
        } catch (err) {
            logger.error('Error writing API:', err);
        }
    }, [name, endpoint, key, type, claude, modelList, selectedModel]);
}

async function getAPIs() {
    logger.debug('Getting API list.');
    const db = await dbPromise;
    try {
        const rows = await db.all('SELECT * FROM apis');
        const apis = rows.map(row => {
            try {
                row.modelList = JSON.parse(row.modelList);
            } catch (err) {
                logger.error(`Error parsing modelList for API ${row.name}:`, err);
                row.modelList = []; // Assign an empty array as the default value
            }
            row.claude == 1 ? row.claude = true : row.claude = false
            row.useTokenizer == 1 ? row.useTokenizer = true : row.useTokenizer = false
            return row;
        });
        return apis;
    } catch (err) {
        logger.error('Error getting APIs:', err);
        throw err;
    }
}

async function getAPI(name) {
    const db = await dbPromise;
    try {
        let gotAPI = await db.get('SELECT * FROM apis WHERE name = ?', [name]);
        if (gotAPI) {
            try {
                gotAPI.modelList = JSON.parse(gotAPI.modelList);
            } catch (err) {
                logger.error(`Error parsing modelList for API ${gotAPI.name}:`, err);
                gotAPI.modelList = []; // Assign an empty array as the default value
            }
            gotAPI.claude == 1 ? gotAPI.claude = true : gotAPI.claude = false
            gotAPI.useTokenizer == 1 ? gotAPI.useTokenizer = true : gotAPI.useTokenizer = false
            return gotAPI;
        } else {
            logger.error('API not found: "', name, '",returning Default instead.');
            let defaultAPI = await db.get('SELECT * FROM apis WHERE name = ?', ['Default']);
            console.warn(defaultAPI)
            return defaultAPI; // or handle the absence of the API in a different way
        }
    } catch (err) {
        logger.error('Error getting API:', err);
        throw err;
    }
}

//currently unused...exports a JSON object of all messages in a session
async function exportSession(sessionID) {
    logger.debug('Exporting session...' + sessionID);
    const db = await dbPromise;
    try {
        const rows = await db.all(`
            SELECT 
                a.username,
                a.message,
                CASE
                    WHEN u.user_id IS NULL THEN 
                        (SELECT c.display_color FROM characters c WHERE c.char_id = a.user_id)
                    ELSE 
                        u.username_color
                END AS userColor,
                a.message_id,
                a.entity
            FROM aichats a
            LEFT JOIN users u ON a.user_id = u.user_id
            WHERE a.session_id = ?
            ORDER BY a.timestamp ASC
        `, [sessionID]);

        const result = JSON.stringify(rows.map(row => ({
            username: row.username,
            content: row.message,
            userColor: row.userColor,
            messageID: row.message_id,
            entity: row.entity
        })));

        return result;

    } catch (err) {
        logger.error('An error occurred while reading from the database:', err);
        throw err;
    }
}

async function getAIChatMessageRow(messageID, sessionID) {
    const db = await dbPromise;
    try {
        const row = await db.get('SELECT * FROM aichats WHERE message_id = ? AND session_id = ?', [messageID, sessionID]);
        if (!row) {
            dbLogger.warn(`getAIChatMessageRow: No row for message_id ${messageID}, session ${sessionID}`);
        }
        return row || null;
    } catch (err) {
        dbLogger.error('getAIChatMessageRow error:', err);
        return null;
    }
}
    // return full AI chat message row (including username, entity, etc)}

// ===============================
// LOREBOOK / WORLD INFO FUNCTIONS
// ===============================

// Generate a simple UUID v4
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// Create a new lorebook
async function createLorebook(name, description = '') {
    logger.info('Creating lorebook: ' + name);
    return queueDatabaseWrite(async (db) => {
        const lorebook_id = generateUUID();
        const created_at = new Date().toISOString();
        await db.run(
            'INSERT INTO lorebooks (lorebook_id, name, description, enabled, scan_depth, token_budget, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [lorebook_id, name, description, 1, 5, 500, created_at]
        );
        logger.info('Lorebook created with ID: ' + lorebook_id);
        return { lorebook_id, name, description, enabled: true, scan_depth: 5, token_budget: 500, created_at };
    }, []);
}

// Get all lorebooks
async function getLorebooks() {
    logger.debug('Getting all lorebooks...');
    const db = await dbPromise;
    try {
        const rows = await db.all('SELECT * FROM lorebooks ORDER BY name ASC');
        return rows.map(row => ({
            ...row,
            enabled: !!row.enabled
        }));
    } catch (err) {
        logger.error('Error getting lorebooks:', err);
        return [];
    }
}

// Get a single lorebook by ID
async function getLorebook(lorebookId) {
    logger.debug('Getting lorebook: ' + lorebookId);
    const db = await dbPromise;
    try {
        const row = await db.get('SELECT * FROM lorebooks WHERE lorebook_id = ?', [lorebookId]);
        if (row) {
            row.enabled = !!row.enabled;
        }
        return row || null;
    } catch (err) {
        logger.error('Error getting lorebook:', err);
        return null;
    }
}

// Update a lorebook
async function updateLorebook(lorebookId, updates) {
    logger.info('Updating lorebook: ' + lorebookId);
    return queueDatabaseWrite(async (db) => {
        const fields = [];
        const values = [];
        
        if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
        if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }
        if (updates.enabled !== undefined) { fields.push('enabled = ?'); values.push(updates.enabled ? 1 : 0); }
        if (updates.scan_depth !== undefined) { fields.push('scan_depth = ?'); values.push(updates.scan_depth); }
        if (updates.token_budget !== undefined) { fields.push('token_budget = ?'); values.push(updates.token_budget); }
        
        if (fields.length === 0) return null;
        
        values.push(lorebookId);
        await db.run(`UPDATE lorebooks SET ${fields.join(', ')} WHERE lorebook_id = ?`, values);
        logger.info('Lorebook updated: ' + lorebookId);
        return await getLorebook(lorebookId);
    }, []);
}

// Delete a lorebook and all its entries
async function deleteLorebook(lorebookId) {
    logger.info('Deleting lorebook: ' + lorebookId);
    return queueDatabaseWrite(async (db) => {
        // Delete all entries first
        await db.run('DELETE FROM lorebook_entries WHERE lorebook_id = ?', [lorebookId]);
        // Then delete the lorebook
        await db.run('DELETE FROM lorebooks WHERE lorebook_id = ?', [lorebookId]);
        logger.info('Lorebook and entries deleted: ' + lorebookId);
        return 'ok';
    }, []);
}

// Create a new lorebook entry
async function createLorebookEntry(lorebookId, entryData) {
    logger.info('Creating entry in lorebook: ' + lorebookId);
    return queueDatabaseWrite(async (db) => {
        const entry_id = generateUUID();
        const created_at = new Date().toISOString();
        const keys = JSON.stringify(entryData.keys || []);
        
        await db.run(
            `INSERT INTO lorebook_entries 
            (entry_id, lorebook_id, title, keys, content, enabled, strategy, position, insertion_order, depth, trigger_percent, created_at) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                entry_id,
                lorebookId,
                entryData.title || '',
                keys,
                entryData.content || '',
                entryData.enabled !== false ? 1 : 0,
                entryData.strategy || 'keyword',
                entryData.position || 'afterCharDefs',
                entryData.insertion_order || 100,
                entryData.depth || null,
                entryData.trigger_percent || 100,
                created_at
            ]
        );
        logger.info('Entry created with ID: ' + entry_id);
        return {
            entry_id,
            lorebook_id: lorebookId,
            title: entryData.title || '',
            keys: entryData.keys || [],
            content: entryData.content || '',
            enabled: entryData.enabled !== false,
            strategy: entryData.strategy || 'keyword',
            position: entryData.position || 'afterCharDefs',
            insertion_order: entryData.insertion_order || 100,
            depth: entryData.depth || null,
            trigger_percent: entryData.trigger_percent || 100,
            created_at
        };
    }, []);
}

// Get all entries for a lorebook
async function getLorebookEntries(lorebookId) {
    logger.debug('Getting entries for lorebook: ' + lorebookId);
    const db = await dbPromise;
    try {
        const rows = await db.all(
            'SELECT * FROM lorebook_entries WHERE lorebook_id = ? ORDER BY insertion_order ASC, title ASC',
            [lorebookId]
        );
        return rows.map(row => ({
            ...row,
            keys: JSON.parse(row.keys || '[]'),
            enabled: !!row.enabled
        }));
    } catch (err) {
        logger.error('Error getting lorebook entries:', err);
        return [];
    }
}

// Get all entries from all enabled lorebooks (for activation scanning)
async function getAllEnabledEntries() {
    logger.debug('Getting all enabled entries from enabled lorebooks...');
    const db = await dbPromise;
    try {
        const rows = await db.all(`
            SELECT e.*, l.scan_depth AS lorebook_scan_depth, l.token_budget AS lorebook_token_budget
            FROM lorebook_entries e
            JOIN lorebooks l ON e.lorebook_id = l.lorebook_id
            WHERE l.enabled = 1 AND e.enabled = 1
            ORDER BY e.insertion_order ASC
        `);
        return rows.map(row => ({
            ...row,
            keys: JSON.parse(row.keys || '[]'),
            enabled: !!row.enabled
        }));
    } catch (err) {
        logger.error('Error getting all enabled entries:', err);
        return [];
    }
}

// Update a lorebook entry
async function updateLorebookEntry(entryId, updates) {
    logger.info('Updating entry: ' + entryId);
    return queueDatabaseWrite(async (db) => {
        const fields = [];
        const values = [];
        
        if (updates.title !== undefined) { fields.push('title = ?'); values.push(updates.title); }
        if (updates.keys !== undefined) { fields.push('keys = ?'); values.push(JSON.stringify(updates.keys)); }
        if (updates.content !== undefined) { fields.push('content = ?'); values.push(updates.content); }
        if (updates.enabled !== undefined) { fields.push('enabled = ?'); values.push(updates.enabled ? 1 : 0); }
        if (updates.strategy !== undefined) { fields.push('strategy = ?'); values.push(updates.strategy); }
        if (updates.position !== undefined) { fields.push('position = ?'); values.push(updates.position); }
        if (updates.insertion_order !== undefined) { fields.push('insertion_order = ?'); values.push(updates.insertion_order); }
        if (updates.depth !== undefined) { fields.push('depth = ?'); values.push(updates.depth); }
        if (updates.trigger_percent !== undefined) { fields.push('trigger_percent = ?'); values.push(updates.trigger_percent); }
        
        if (fields.length === 0) return null;
        
        values.push(entryId);
        await db.run(`UPDATE lorebook_entries SET ${fields.join(', ')} WHERE entry_id = ?`, values);
        logger.info('Entry updated: ' + entryId);
        
        // Return updated entry
        const row = await db.get('SELECT * FROM lorebook_entries WHERE entry_id = ?', [entryId]);
        if (row) {
            row.keys = JSON.parse(row.keys || '[]');
            row.enabled = !!row.enabled;
        }
        return row;
    }, []);
}

// Delete a lorebook entry
async function deleteLorebookEntry(entryId) {
    logger.info('Deleting entry: ' + entryId);
    return queueDatabaseWrite(async (db) => {
        await db.run('DELETE FROM lorebook_entries WHERE entry_id = ?', [entryId]);
        logger.info('Entry deleted: ' + entryId);
        return 'ok';
    }, []);
}

// ===============================
// USER AUTHENTICATION FUNCTIONS
// ===============================

const BCRYPT_SALT_ROUNDS = 10;

// Generate a simple UUID v4 (reusing from lorebook section)
function generateAuthUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// Check if a username is available
async function checkUsernameAvailable(username) {
    logger.debug('Checking username availability: ' + username);
    const db = await dbPromise;
    try {
        const row = await db.get('SELECT user_id FROM users WHERE LOWER(username) = LOWER(?)', [username]);
        return !row; // true if no row found (username is available)
    } catch (err) {
        logger.error('Error checking username:', err);
        return false;
    }
}

// Get user by username (case-insensitive)
async function getUserByUsername(username) {
    logger.debug('Getting user by username: ' + username);
    const db = await dbPromise;
    try {
        const row = await db.get(
            `SELECT u.user_id, u.username, u.username_color, u.persona, u.password_hash, u.email, u.created_at, u.last_seen_at, ur.role 
             FROM users u 
             LEFT JOIN user_roles ur ON u.user_id = ur.user_id 
             WHERE LOWER(u.username) = LOWER(?)`, 
            [username]
        );
        return row || null;
    } catch (err) {
        logger.error('Error getting user by username:', err);
        return null;
    }
}

// Register a new user with password
async function registerUser(username, password, email = null) {
    logger.info('Registering new user: ' + username);
    
    // Check if username is already taken
    const existing = await getUserByUsername(username);
    if (existing) {
        logger.warn('Username already taken: ' + username);
        return { success: false, error: 'Username already taken' };
    }
    
    return queueDatabaseWrite(async (db) => {
        try {
            const user_id = generateAuthUUID();
            const password_hash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
            const username_color = '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0');
            const created_at = new Date().toISOString();
            
            await db.run(
                `INSERT INTO users (user_id, username, username_color, persona, password_hash, email, created_at, last_seen_at) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [user_id, username, username_color, '', password_hash, email, created_at, created_at]
            );
            
            // Also create user_roles entry with default 'user' role
            await db.run('INSERT INTO user_roles (user_id, role) VALUES (?, ?)', [user_id, 'user']);
            
            logger.info('User registered successfully: ' + username + ' (ID: ' + user_id + ')');
            return { 
                success: true, 
                user: {
                    user_id,
                    username,
                    username_color,
                    persona: '',
                    email,
                    role: 'user',
                    created_at
                }
            };
        } catch (err) {
            logger.error('Error registering user:', err);
            return { success: false, error: 'Database error during registration' };
        }
    }, []);
}

// Authenticate user with password
async function authenticateUser(username, password) {
    logger.info('Authenticating user: ' + username);
    
    const user = await getUserByUsername(username);
    if (!user) {
        logger.warn('Authentication failed - user not found: ' + username);
        return { success: false, error: 'Invalid username or password' };
    }
    
    if (!user.password_hash) {
        logger.warn('Authentication failed - user has no password (legacy account): ' + username);
        return { success: false, error: 'This account has no password. Please register a new account.' };
    }
    
    try {
        const passwordMatch = await bcrypt.compare(password, user.password_hash);
        if (!passwordMatch) {
            logger.warn('Authentication failed - wrong password: ' + username);
            return { success: false, error: 'Invalid username or password' };
        }
        
        // Update last_seen_at
        const db = await dbPromise;
        await db.run('UPDATE users SET last_seen_at = CURRENT_TIMESTAMP WHERE user_id = ?', [user.user_id]);
        
        logger.info('User authenticated successfully: ' + username);
        return {
            success: true,
            user: {
                user_id: user.user_id,
                username: user.username,
                username_color: user.username_color,
                persona: user.persona || '',
                email: user.email,
                role: user.role || 'user',
                created_at: user.created_at
            }
        };
    } catch (err) {
        logger.error('Error during authentication:', err);
        return { success: false, error: 'Authentication error' };
    }
}

// ============================================================================
// ROOM MANAGEMENT FUNCTIONS - Critical for message isolation
// ============================================================================

// Global Room ID constant - used for migration and fallback
const GLOBAL_ROOM_ID = 'global-room-00000000-0000-0000-0000-000000000000';

/**
 * Create a new room
 * @param {string} name - Room display name
 * @param {string} description - Room description
 * @param {string} createdBy - User ID of creator
 * @param {object} settings - Room-specific settings (JSON-serializable)
 * @returns {Promise<object>} Created room object
 */
async function createRoom(name, description = '', createdBy = null, settings = {}) {
    logger.info(`Creating room: ${name}`);
    
    return queueDatabaseWrite(async (db) => {
        const room_id = uuidv4();
        const settingsJson = JSON.stringify(settings);
        
        await db.run(
            `INSERT INTO rooms (room_id, name, description, created_by, settings, is_active, created_at) 
             VALUES (?, ?, ?, ?, ?, TRUE, CURRENT_TIMESTAMP)`,
            [room_id, name, description, createdBy, settingsJson]
        );
        
        // If creator specified, add them as room member with 'creator' role
        if (createdBy) {
            await db.run(
                `INSERT INTO room_members (room_id, user_id, role, joined_at) 
                 VALUES (?, ?, 'creator', CURRENT_TIMESTAMP)`,
                [room_id, createdBy]
            );
        }
        
        // Create initial session for the room
        await db.run(
            `INSERT INTO sessions (room_id, started_at, is_active) 
             VALUES (?, CURRENT_TIMESTAMP, TRUE)`,
            [room_id]
        );
        
        await db.run(
            `INSERT INTO userSessions (room_id, started_at, is_active) 
             VALUES (?, CURRENT_TIMESTAMP, TRUE)`,
            [room_id]
        );
        
        logger.info(`Room created: ${name} (${room_id})`);
        
        return {
            room_id,
            name,
            description,
            created_by: createdBy,
            settings,
            is_active: true,
            created_at: new Date().toISOString()
        };
    }, []);
}

/**
 * Get room by ID
 * @param {string} roomId - Room ID
 * @returns {Promise<object|null>} Room object or null
 */
async function getRoomById(roomId) {
    const db = await dbPromise;
    try {
        const room = await db.get('SELECT * FROM rooms WHERE room_id = ? AND is_active = TRUE', [roomId]);
        if (room && room.settings) {
            room.settings = JSON.parse(room.settings);
        }
        return room;
    } catch (err) {
        logger.error('Error getting room:', err);
        return null;
    }
}

/**
 * Get all active rooms with member counts
 * @returns {Promise<Array>} Array of room objects with member counts
 */
async function getAllActiveRooms() {
    const db = await dbPromise;
    try {
        const rooms = await db.all(`
            SELECT 
                r.room_id,
                r.name,
                r.description,
                r.created_by,
                r.created_at,
                r.settings,
                COUNT(rm.user_id) as member_count,
                GROUP_CONCAT(u.username, ', ') as member_names
            FROM rooms r
            LEFT JOIN room_members rm ON r.room_id = rm.room_id
            LEFT JOIN users u ON rm.user_id = u.user_id
            WHERE r.is_active = TRUE
            GROUP BY r.room_id
            ORDER BY r.created_at DESC
        `);
        
        return rooms.map(room => ({
            ...room,
            settings: room.settings ? JSON.parse(room.settings) : {}
        }));
    } catch (err) {
        logger.error('Error getting active rooms:', err);
        return [];
    }
}

/**
 * Update room settings
 * @param {string} roomId - Room ID
 * @param {object} updates - Object with name, description, and/or settings
 * @returns {Promise<boolean>} Success status
 */
async function updateRoomSettings(roomId, updates) {
    logger.info(`Updating room settings: ${roomId}`);
    
    return queueDatabaseWrite(async (db) => {
        const { name, description, settings } = updates;
        
        // Build dynamic update query
        const setClauses = [];
        const params = [];
        
        if (name !== undefined) {
            setClauses.push('name = ?');
            params.push(name);
        }
        if (description !== undefined) {
            setClauses.push('description = ?');
            params.push(description);
        }
        if (settings !== undefined) {
            setClauses.push('settings = ?');
            params.push(JSON.stringify(settings));
        }
        
        if (setClauses.length === 0) {
            return true; // Nothing to update
        }
        
        params.push(roomId);
        
        await db.run(
            `UPDATE rooms SET ${setClauses.join(', ')} WHERE room_id = ?`,
            params
        );
        
        logger.info(`Room settings updated: ${roomId}`);
        return true;
    }, []);
}

/**
 * Soft delete a room (set is_active = FALSE)
 * Rooms are never truly deleted to preserve chat history
 * @param {string} roomId - Room ID
 * @returns {Promise<boolean>} Success status
 */
async function deleteRoom(roomId) {
    logger.info(`Soft-deleting room: ${roomId}`);
    
    // Prevent deletion of global room
    if (roomId === GLOBAL_ROOM_ID) {
        logger.warn('Attempted to delete global room - denied');
        return false;
    }
    
    return queueDatabaseWrite(async (db) => {
        await db.run('UPDATE rooms SET is_active = FALSE WHERE room_id = ?', [roomId]);
        
        // Remove all members
        await db.run('DELETE FROM room_members WHERE room_id = ?', [roomId]);
        
        logger.info(`Room soft-deleted: ${roomId}`);
        return true;
    }, []);
}

/**
 * Add a user to a room
 * @param {string} roomId - Room ID
 * @param {string} userId - User ID
 * @param {string} role - Role: 'creator', 'moderator', or 'member'
 * @returns {Promise<boolean>} Success status
 */
async function addRoomMember(roomId, userId, role = 'member') {
    logger.info(`Adding member ${userId} to room ${roomId} with role ${role}`);
    
    return queueDatabaseWrite(async (db) => {
        // Check if already a member
        const existing = await db.get(
            'SELECT * FROM room_members WHERE room_id = ? AND user_id = ?',
            [roomId, userId]
        );
        
        if (existing) {
            logger.debug(`User ${userId} already in room ${roomId}`);
            return true;
        }
        
        await db.run(
            `INSERT INTO room_members (room_id, user_id, role, joined_at) 
             VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
            [roomId, userId, role]
        );
        
        logger.info(`Member added: ${userId} to room ${roomId}`);
        return true;
    }, []);
}

/**
 * Remove a user from a room
 * @param {string} roomId - Room ID
 * @param {string} userId - User ID
 * @returns {Promise<boolean>} Success status
 */
async function removeRoomMember(roomId, userId) {
    logger.info(`Removing member ${userId} from room ${roomId}`);
    
    return queueDatabaseWrite(async (db) => {
        await db.run(
            'DELETE FROM room_members WHERE room_id = ? AND user_id = ?',
            [roomId, userId]
        );
        
        logger.info(`Member removed: ${userId} from room ${roomId}`);
        return true;
    }, []);
}

/**
 * Get all members of a room
 * @param {string} roomId - Room ID
 * @returns {Promise<Array>} Array of member objects
 */
async function getRoomMembers(roomId) {
    const db = await dbPromise;
    try {
        return await db.all(`
            SELECT 
                rm.user_id,
                rm.role,
                rm.joined_at,
                u.username,
                u.username_color,
                u.persona
            FROM room_members rm
            LEFT JOIN users u ON rm.user_id = u.user_id
            WHERE rm.room_id = ?
            ORDER BY rm.joined_at ASC
        `, [roomId]);
    } catch (err) {
        logger.error('Error getting room members:', err);
        return [];
    }
}

/**
 * Get all rooms a user is a member of
 * @param {string} userId - User ID
 * @returns {Promise<Array>} Array of room objects
 */
async function getUserRooms(userId) {
    const db = await dbPromise;
    try {
        const rooms = await db.all(`
            SELECT 
                r.room_id,
                r.name,
                r.description,
                r.settings,
                rm.role,
                rm.joined_at
            FROM room_members rm
            JOIN rooms r ON rm.room_id = r.room_id
            WHERE rm.user_id = ? AND r.is_active = TRUE
            ORDER BY rm.joined_at DESC
        `, [userId]);
        
        return rooms.map(room => ({
            ...room,
            settings: room.settings ? JSON.parse(room.settings) : {}
        }));
    } catch (err) {
        logger.error('Error getting user rooms:', err);
        return [];
    }
}

/**
 * Get active session for a room
 * @param {string} roomId - Room ID
 * @param {string} type - 'ai' or 'user'
 * @returns {Promise<number|null>} Session ID or null
 */
async function getRoomActiveSession(roomId, type = 'ai') {
    const db = await dbPromise;
    const table = type === 'ai' ? 'sessions' : 'userSessions';
    
    try {
        const session = await db.get(
            `SELECT session_id FROM ${table} WHERE room_id = ? AND is_active = TRUE LIMIT 1`,
            [roomId]
        );
        return session?.session_id || null;
    } catch (err) {
        logger.error(`Error getting room ${type} session:`, err);
        return null;
    }
}

/**
 * Check if user is a member of a room
 * @param {string} roomId - Room ID
 * @param {string} userId - User ID
 * @returns {Promise<boolean>} True if user is in room
 */
async function isUserInRoom(roomId, userId) {
    const db = await dbPromise;
    try {
        const member = await db.get(
            'SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?',
            [roomId, userId]
        );
        return !!member;
    } catch (err) {
        logger.error('Error checking room membership:', err);
        return false;
    }
}

/**
 * Get user's role in a room
 * @param {string} roomId - Room ID
 * @param {string} userId - User ID
 * @returns {Promise<string|null>} Role or null if not in room
 */
async function getUserRoomRole(roomId, userId) {
    const db = await dbPromise;
    try {
        const member = await db.get(
            'SELECT role FROM room_members WHERE room_id = ? AND user_id = ?',
            [roomId, userId]
        );
        return member?.role || null;
    } catch (err) {
        logger.error('Error getting user room role:', err);
        return null;
    }
}

// ============================================================================
// MIGRATION: Create global room and migrate existing data
// ============================================================================

/**
 * Create default global room if it doesn't exist
 * This room is used for backward compatibility with existing data
 */
async function createDefaultGlobalRoom() {
    const db = await dbPromise;
    
    try {
        // Check if global room already exists
        const existing = await db.get(
            'SELECT room_id FROM rooms WHERE room_id = ?',
            [GLOBAL_ROOM_ID]
        );
        
        if (existing) {
            logger.debug('Global room already exists');
            return GLOBAL_ROOM_ID;
        }
        
        logger.info('Creating default Global Room for backward compatibility...');
        
        // Create global room directly (bypass queue since this runs during init)
        await db.run(
            `INSERT INTO rooms (room_id, name, description, created_by, settings, is_active, created_at) 
             VALUES (?, 'Global Room', 'Default room for all users (backward compatibility)', NULL, '{}', TRUE, CURRENT_TIMESTAMP)`,
            [GLOBAL_ROOM_ID]
        );
        
        // Create session for global room
        await db.run(
            `INSERT INTO sessions (room_id, started_at, is_active) 
             VALUES (?, CURRENT_TIMESTAMP, TRUE)`,
            [GLOBAL_ROOM_ID]
        );
        
        await db.run(
            `INSERT INTO userSessions (room_id, started_at, is_active) 
             VALUES (?, CURRENT_TIMESTAMP, TRUE)`,
            [GLOBAL_ROOM_ID]
        );
        
        logger.info('Global Room created successfully');
        return GLOBAL_ROOM_ID;
    } catch (err) {
        logger.error('Error creating global room:', err);
        throw err;
    }
}

/**
 * Migrate existing data to global room
 * This ensures backward compatibility while enabling room isolation
 */
async function migrateExistingDataToGlobalRoom() {
    const db = await dbPromise;
    
    try {
        // Check if migration is needed (any data without room_id)
        const needsMigration = await db.get(
            'SELECT 1 FROM aichats WHERE room_id IS NULL LIMIT 1'
        );
        
        if (!needsMigration) {
            logger.debug('No migration needed - all data already has room_id');
            return;
        }
        
        logger.info('Migrating existing data to Global Room...');
        
        // Ensure global room exists
        await createDefaultGlobalRoom();
        
        // Migrate sessions
        const sessionResult = await db.run(
            'UPDATE sessions SET room_id = ? WHERE room_id IS NULL',
            [GLOBAL_ROOM_ID]
        );
        logger.info(`Migrated ${sessionResult.changes || 0} sessions to Global Room`);
        
        // Migrate userSessions
        const userSessionResult = await db.run(
            'UPDATE userSessions SET room_id = ? WHERE room_id IS NULL',
            [GLOBAL_ROOM_ID]
        );
        logger.info(`Migrated ${userSessionResult.changes || 0} userSessions to Global Room`);
        
        // Migrate aichats
        const aiChatResult = await db.run(
            'UPDATE aichats SET room_id = ? WHERE room_id IS NULL',
            [GLOBAL_ROOM_ID]
        );
        logger.info(`Migrated ${aiChatResult.changes || 0} AI chat messages to Global Room`);
        
        // Migrate userchats
        const userChatResult = await db.run(
            'UPDATE userchats SET room_id = ? WHERE room_id IS NULL',
            [GLOBAL_ROOM_ID]
        );
        logger.info(`Migrated ${userChatResult.changes || 0} user chat messages to Global Room`);
        
        logger.info('Migration to Global Room completed successfully');
    } catch (err) {
        logger.error('Error during migration:', err);
        throw err;
    }
}

// Initialize database schema synchronously, migration runs on first DB access
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
    // Lorebook / World Info functions
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
    // User Authentication functions
    checkUsernameAvailable,
    getUserByUsername,
    registerUser,
    authenticateUser,
    // Room Management functions
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