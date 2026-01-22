/**
 * Database Loader
 * Dynamically loads either SQLite or PostgreSQL database module
 * based on DB_TYPE environment variable
 *
 * Usage in server.js:
 *   import db from './src/db-loader.js';
 */

import { config } from 'dotenv';

// Load environment variables
config();

const DB_TYPE = process.env.DB_TYPE || 'sqlite';

console.log(`[Database] Loading ${DB_TYPE.toUpperCase()} database module...`);

let db;

if (DB_TYPE === 'postgres' || DB_TYPE === 'postgresql' || DB_TYPE === 'pg') {
    // Load PostgreSQL module
    const dbPg = await import('./db-pg.js');
    db = dbPg.default;
    console.log('[Database] PostgreSQL module loaded successfully');

    // Initialize schema
    try {
        await db.ensureDatabaseSchema();
        await db.createDefaultGlobalRoom();
        await db.migrateExistingDataToGlobalRoom();

        // Sync character files to database (prevents foreign key constraint errors)
        console.log('[Database] Syncing character files...');
        const syncResult = await db.syncCharactersToDatabase();
        console.log(`[Database] Character sync complete - Synced: ${syncResult.synced}, Skipped: ${syncResult.skipped}, Errors: ${syncResult.errors}`);
    } catch (error) {
        console.error('[Database] Failed to initialize PostgreSQL schema:', error.message);
        console.error('[Database] Please run: psql -U stmp_user -d stmp -f src/schema-postgres.sql');
        process.exit(1);
    }
} else {
    // Load SQLite module (default)
    const dbSqlite = await import('./db.js');
    db = dbSqlite.default;
    console.log('[Database] SQLite module loaded successfully');
}

export default db;
