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


console.log(`[Database] Loading PostgreSQL database module...`);

let database;

const dbPg = await import('./db-pg.js');
database = dbPg.default;
console.log('[Database] PostgreSQL module loaded successfully');

// Initialize schema
try {
    await database.ensureDatabaseSchema();
    await database.createDefaultGlobalRoom();
    await database.migrateExistingDataToGlobalRoom();

    // Sync character files to database (prevents foreign key constraint errors)
    console.log('[Database] Syncing character files...');
    const syncResult = await database.syncCharactersToDatabase();
    console.log(`[Database] Character sync complete - Synced: ${syncResult.synced}, Skipped: ${syncResult.skipped}, Errors: ${syncResult.errors}`);
} catch (error) {
    console.error('[Database] Failed to initialize PostgreSQL schema:', error.message);
    console.error('[Database] Please run: psql -U stmp_user -d stmp -f src/schema-postgres.sql');
    process.exit(1);
}


console.log("DB initialized");

export default database;
