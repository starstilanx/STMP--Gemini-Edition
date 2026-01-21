import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import pg from 'pg';
const { Pool } = pg;

// Configuration
const SQLITE_DB_PATH = './stmp.db';
const POSTGRES_CONNECTION_STRING = process.env.DATABASE_URL || 'postgres://postgres:2330@localhost:5432/stmp';

// Schema Definition (Mirrors db.js but adapted for Postgres)
const schemaDictionary = {
    users: {
        user_id: "TEXT UNIQUE PRIMARY KEY",
        username: "TEXT",
        username_color: "TEXT",
        persona: "TEXT",
        password_hash: "TEXT",
        email: "TEXT",
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
    sessions: {
        session_id: "SERIAL PRIMARY KEY", // Changed from INTEGER PRIMARY KEY
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
    aichats: {
        message_id: "SERIAL PRIMARY KEY",
        session_id: "INTEGER",
        user_id: "TEXT",
        username: "TEXT",
        message: "TEXT",
        entity: "TEXT",
        timestamp: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
        room_id: "TEXT"
    },
    userchats: {
        message_id: "SERIAL PRIMARY KEY",
        session_id: "INTEGER",
        user_id: "TEXT",
        message: "TEXT",
        timestamp: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
        active: "BOOLEAN DEFAULT TRUE",
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
        keys: "TEXT",
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

async function migrate() {
    console.log('Starting migration...');
    const sqliteDb = await open({
        filename: SQLITE_DB_PATH,
        driver: sqlite3.Database
    });

    const pgPool = new Pool({
        connectionString: POSTGRES_CONNECTION_STRING,
    });

    const pgClient = await pgPool.connect();

    try {
        await pgClient.query('BEGIN');

        // 1. Create Tables
        console.log('Creating tables...');
        for (const [tableName, tableSchema] of Object.entries(schemaDictionary)) {
            let createTableQuery = `CREATE TABLE IF NOT EXISTS "${tableName}" (`;
            const columnDefinitions = [];
            for (const [columnName, columnType] of Object.entries(tableSchema)) {
                if (columnName !== 'foreignKeys') {
                    columnDefinitions.push(`"${columnName}" ${columnType}`);
                }
            }
            createTableQuery += columnDefinitions.join(', ') + ')';
            await pgClient.query(createTableQuery);
            console.log(`Table ${tableName} ensured.`);
        }

        // 2. Transfer Data
        console.log('Transferring data...');
        // Order matters for foreign keys if we enforced them, but we aren't strict here in creation
        // However, it's good practice.
        const tables = Object.keys(schemaDictionary);

        for (const tableName of tables) {
            console.log(`Migrating table: ${tableName}`);
            const rows = await sqliteDb.all(`SELECT * FROM ${tableName}`);

            if (rows.length === 0) continue;

            const columns = Object.keys(rows[0]).map(c => `"${c}"`).join(', ');
            const placeholders = Object.keys(rows[0]).map((_, i) => `$${i + 1}`).join(', ');
            const query = `INSERT INTO "${tableName}" (${columns}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;

            for (const row of rows) {
                // Postgres boolean conversion (SQLite uses 0/1)
                const values = Object.values(row).map(val => {
                    // Check current schema type for boolean fields if needed, 
                    // but PG driver usually handles 1/0 for boolean columns if configured, or we explicitly convert.
                    // A safe bet is to check if the schema definition says BOOLEAN and the value is number
                    // But for simplicity, we pass as is, PG 'true'/'false' or 1/0 usually works depending on driver checks.
                    // Actually, pg driver inserts `1` into boolean as true? No, strict mode might fail.
                    // Let's do a quick pass for likely boolean fields based on schema
                    return val;
                });

                // Explicit conversion for known boolean columns based on schema
                const tableSchema = schemaDictionary[tableName];
                const convertedValues = Object.keys(row).map(key => {
                    let val = row[key];
                    const type = tableSchema[key];
                    if (type && type.startsWith('BOOLEAN') && typeof val === 'number') {
                        return val === 1;
                    }
                    return val;
                });

                await pgClient.query(query, convertedValues);
            }

            // If the table has a SERIAL primary key, we must update the sequence
            if (schemaDictionary[tableName].session_id?.includes('SERIAL') || schemaDictionary[tableName].message_id?.includes('SERIAL')) {
                const pkCol = schemaDictionary[tableName].session_id ? 'session_id' : 'message_id';
                // Properly quote the table name for pg_get_serial_sequence to respect case sensitivity
                await pgClient.query(`SELECT setval(pg_get_serial_sequence('"${tableName}"', '${pkCol}'), (SELECT MAX("${pkCol}") FROM "${tableName}"))`);
                console.log(`Updated sequence for ${tableName}`);
            }
        }

        await pgClient.query('COMMIT');
        console.log('Migration completed successfully.');
    } catch (e) {
        await pgClient.query('ROLLBACK');
        console.error('Migration failed:', e);
    } finally {
        pgClient.release();
        await pgPool.end();
        await sqliteDb.close();
    }
}

migrate();
