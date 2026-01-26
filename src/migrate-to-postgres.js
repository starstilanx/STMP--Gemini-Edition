/**
 * Data Migration Script: SQLite → PostgreSQL
 *
 * This script migrates all existing data from stmp.db (SQLite) to PostgreSQL
 * Preserves: users, characters, rooms, messages, sessions, APIs, lorebooks
 *
 * Usage: node src/migrate-to-postgres.js
 */

import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import pg from 'pg';
const { Pool } = pg;
import { config } from 'dotenv';

// Load environment variables
config();

// SQLite connection
const sqliteDb = await open({
    filename: './stmp.db',
    driver: sqlite3.Database
});

// PostgreSQL connection
const pgPool = new Pool({
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5432'),
    database: process.env.PG_DATABASE || 'stmp',
    user: process.env.PG_USER || 'stmp_user',
    password: process.env.PG_PASSWORD,
});

console.log('='.repeat(60));
console.log('STMP Data Migration: SQLite → PostgreSQL');
console.log('='.repeat(60));

// Test connections
async function testConnections() {
    console.log('\n[1/10] Testing database connections...');

    try {
        // Test SQLite
        const sqliteTest = await sqliteDb.get('SELECT 1 as test');
        console.log('  ✓ SQLite connection OK');

        // Test PostgreSQL
        const pgTest = await pgPool.query('SELECT 1 as test');
        console.log('  ✓ PostgreSQL connection OK');

        return true;
    } catch (error) {
        console.error('  ✗ Connection test failed:', error.message);
        return false;
    }
}

// Migrate tables
async function migrateTable(tableName, transformer = null) {
    console.log(`\n  Migrating ${tableName}...`);

    try {
        // Read from SQLite
        const rows = await sqliteDb.all(`SELECT * FROM ${tableName}`);
        console.log(`    Found ${rows.length} records`);

        if (rows.length === 0) {
            console.log(`    (no data to migrate)`);
            return { success: true, count: 0 };
        }

        // Transform data if needed
        const processedRows = transformer ? rows.map(transformer) : rows;

        // Get column names from first row
        const columns = Object.keys(processedRows[0]);
        const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');

        // Build insert query
        const insertQuery = `
            INSERT INTO ${tableName === 'userSessions' ? '"userSessions"' : tableName}
            (${columns.join(', ')})
            VALUES (${placeholders})
            ON CONFLICT DO NOTHING
        `;

        // Insert into PostgreSQL
        let successCount = 0;
        for (const row of processedRows) {
            try {
                const values = columns.map(col => row[col]);
                await pgPool.query(insertQuery, values);
                successCount++;
            } catch (err) {
                console.warn(`    ⚠ Failed to insert row:`, err.message);
            }
        }

        console.log(`    ✓ Migrated ${successCount}/${rows.length} records`);
        return { success: true, count: successCount };

    } catch (error) {
        console.error(`    ✗ Migration failed:`, error.message);
        return { success: false, count: 0, error };
    }
}

// Main migration function
async function migrate() {
    const results = {};

    if (!(await testConnections())) {
        console.error('\n✗ Migration aborted due to connection errors');
        process.exit(1);
    }

    console.log('\n[2/10] Migrating users...');
    results.users = await migrateTable('users');

    console.log('\n[3/10] Migrating user roles...');
    results.user_roles = await migrateTable('user_roles');

    console.log('\n[4/10] Migrating characters...');
    results.characters = await migrateTable('characters');

    console.log('\n[5/10] Migrating rooms...');
    results.rooms = await migrateTable('rooms');

    console.log('\n[6/10] Migrating room members...');
    results.room_members = await migrateTable('room_members');

    console.log('\n[7/10] Migrating sessions...');
    results.sessions = await migrateTable('sessions', (row) => ({
        ...row,
        is_active: row.is_active === 1
    }));

    console.log('\n[8/10] Migrating user sessions...');
    results.userSessions = await migrateTable('userSessions', (row) => ({
        ...row,
        is_active: row.is_active === 1
    }));

    console.log('\n[9/10] Migrating AI chat messages...');
    results.aichats = await migrateTable('aichats');

    console.log('\n[10/10] Migrating user chat messages...');
    results.userchats = await migrateTable('userchats', (row) => ({
        ...row,
        active: row.active === 1
    }));

    console.log('\n[11/12] Migrating APIs...');
    results.apis = await migrateTable('apis', (row) => ({
        ...row,
        claude: row.claude === 1,
        useTokenizer: row.useTokenizer === 1
    }));

    console.log('\n[12/12] Migrating lorebooks...');
    results.lorebooks = await migrateTable('lorebooks', (row) => ({
        ...row,
        enabled: row.enabled === 1
    }));

    console.log('\n[13/13] Migrating lorebook entries...');
    results.lorebook_entries = await migrateTable('lorebook_entries', (row) => ({
        ...row,
        enabled: row.enabled === 1
    }));

    // Fix PostgreSQL sequences
    console.log('\n[Final] Fixing PostgreSQL sequences...');
    try {
        // Get max IDs from SQLite
        const maxSessionId = await sqliteDb.get('SELECT MAX(session_id) as max FROM sessions');
        const maxUserSessionId = await sqliteDb.get('SELECT MAX(session_id) as max FROM userSessions');
        const maxAIChatId = await sqliteDb.get('SELECT MAX(message_id) as max FROM aichats');
        const maxUserChatId = await sqliteDb.get('SELECT MAX(message_id) as max FROM userchats');
        const maxRoomMemberId = await sqliteDb.get('SELECT MAX(id) as max FROM room_members');

        // Update PostgreSQL sequences
        if (maxSessionId.max) {
            await pgPool.query(`SELECT setval('sessions_session_id_seq', $1)`, [maxSessionId.max]);
            console.log(`  ✓ sessions sequence set to ${maxSessionId.max}`);
        }

        if (maxUserSessionId.max) {
            await pgPool.query(`SELECT setval('"userSessions_session_id_seq"', $1)`, [maxUserSessionId.max]);
            console.log(`  ✓ userSessions sequence set to ${maxUserSessionId.max}`);
        }

        if (maxAIChatId.max) {
            await pgPool.query(`SELECT setval('aichats_message_id_seq', $1)`, [maxAIChatId.max]);
            console.log(`  ✓ aichats sequence set to ${maxAIChatId.max}`);
        }

        if (maxUserChatId.max) {
            await pgPool.query(`SELECT setval('userchats_message_id_seq', $1)`, [maxUserChatId.max]);
            console.log(`  ✓ userchats sequence set to ${maxUserChatId.max}`);
        }

        if (maxRoomMemberId.max) {
            await pgPool.query(`SELECT setval('room_members_id_seq', $1)`, [maxRoomMemberId.max]);
            console.log(`  ✓ room_members sequence set to ${maxRoomMemberId.max}`);
        }
    } catch (err) {
        console.warn('  ⚠ Warning: Could not fix sequences:', err.message);
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('MIGRATION SUMMARY');
    console.log('='.repeat(60));

    let totalRecords = 0;
    for (const [table, result] of Object.entries(results)) {
        const status = result.success ? '✓' : '✗';
        console.log(`  ${status} ${table.padEnd(20)} ${result.count} records`);
        totalRecords += result.count;
    }

    console.log('='.repeat(60));
    console.log(`  Total: ${totalRecords} records migrated`);
    console.log('='.repeat(60));

    // Verification
    console.log('\nVerifying migration...');
    try {
        const userCount = await pgPool.query('SELECT COUNT(*) FROM users');
        const roomCount = await pgPool.query('SELECT COUNT(*) FROM rooms');
        const messageCount = await pgPool.query('SELECT COUNT(*) FROM aichats');

        console.log(`  PostgreSQL now has:`);
        console.log(`    - ${userCount.rows[0].count} users`);
        console.log(`    - ${roomCount.rows[0].count} rooms`);
        console.log(`    - ${messageCount.rows[0].count} AI messages`);

        console.log('\n✓ Migration completed successfully!');
        console.log('\nNext steps:');
        console.log('  1. Update .env to set DB_TYPE=postgres');
        console.log('  2. Restart the server with: npm start');
        console.log('  3. Test all functionality');
        console.log('  4. Backup your SQLite database: cp stmp.db stmp.db.backup');

    } catch (error) {
        console.error('\n✗ Verification failed:', error.message);
    }
}

// Run migration
migrate()
    .then(() => {
        sqliteDb.close();
        pgPool.end();
        process.exit(0);
    })
    .catch((error) => {
        console.error('\n✗ Fatal error:', error);
        sqliteDb.close();
        pgPool.end();
        process.exit(1);
    });
