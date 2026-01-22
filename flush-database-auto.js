import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

const pool = new Pool({
    host: process.env.PG_HOST || process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || process.env.DB_PORT || '5432'),
    database: process.env.PG_DATABASE || process.env.DB_NAME || 'stmp',
    user: process.env.PG_USER || process.env.DB_USER || 'stmp_user',
    password: process.env.PG_PASSWORD || process.env.DB_PASSWORD,
});

async function flushDatabase() {
    try {
        console.log('\n🔄 Flushing database...\n');

        // Delete in order to respect foreign key constraints
        console.log('Deleting chat messages...');
        try {
            await pool.query('DELETE FROM aichats');
            console.log('  ✓ aichats cleared');
        } catch (err) {
            console.error('  ✗ aichats error:', err.message);
        }

        try {
            await pool.query('DELETE FROM userchats');
            console.log('  ✓ userchats cleared');
        } catch (err) {
            console.error('  ✗ userchats error:', err.message);
        }

        console.log('\nDeleting sessions...');
        try {
            await pool.query('DELETE FROM sessions');
            console.log('  ✓ sessions cleared');
        } catch (err) {
            console.error('  ✗ sessions error:', err.message);
        }

        try {
            await pool.query('DELETE FROM "userSessions"');
            console.log('  ✓ userSessions cleared');
        } catch (err) {
            console.error('  ✗ userSessions error:', err.message);
        }

        console.log('\nDeleting lorebook entries...');
        try {
            await pool.query('DELETE FROM lorebook_entries');
            console.log('  ✓ lorebook_entries cleared');
        } catch (err) {
            console.error('  ✗ lorebook_entries error:', err.message);
        }

        console.log('\nDeleting lorebooks...');
        try {
            await pool.query('DELETE FROM lorebooks');
            console.log('  ✓ lorebooks cleared');
        } catch (err) {
            console.error('  ✗ lorebooks error:', err.message);
        }

        console.log('\nDeleting room memberships...');
        try {
            await pool.query('DELETE FROM room_members');
            console.log('  ✓ room_members cleared');
        } catch (err) {
            console.error('  ✗ room_members error:', err.message);
        }

        console.log('\nDeleting room configurations...');
        try {
            await pool.query('DELETE FROM room_configs');
            console.log('  ✓ room_configs cleared');
        } catch (err) {
            console.error('  ✗ room_configs error:', err.message);
        }

        console.log('\nDeleting rooms...');
        try {
            await pool.query('DELETE FROM rooms');
            console.log('  ✓ rooms cleared');
        } catch (err) {
            console.error('  ✗ rooms error:', err.message);
        }

        console.log('\nDeleting characters...');
        try {
            await pool.query('DELETE FROM characters');
            console.log('  ✓ characters cleared');
        } catch (err) {
            console.error('  ✗ characters error:', err.message);
        }

        console.log('\nDeleting user roles...');
        try {
            await pool.query('DELETE FROM user_roles');
            console.log('  ✓ user_roles cleared');
        } catch (err) {
            console.error('  ✗ user_roles error:', err.message);
        }

        console.log('\nDeleting users without passwords...');
        try {
            await pool.query('DELETE FROM users WHERE password_hash IS NULL');
            console.log('  ✓ passwordless users cleared');
        } catch (err) {
            console.error('  ✗ users error:', err.message);
        }

        console.log('\nDeleting API configurations...');
        try {
            await pool.query('DELETE FROM apis');
            console.log('  ✓ apis cleared');
        } catch (err) {
            console.error('  ✗ apis error:', err.message);
        }

        // Reset sequences
        console.log('\nResetting auto-increment sequences...');
        try {
            await pool.query(`SELECT setval('sessions_session_id_seq', 1, false)`);
            await pool.query(`SELECT setval('"userSessions_session_id_seq"', 1, false)`);
            await pool.query(`SELECT setval('aichats_message_id_seq', 1, false)`);
            await pool.query(`SELECT setval('userchats_message_id_seq', 1, false)`);
            console.log('  ✓ Sequences reset');
        } catch (err) {
            console.error('  ✗ Sequence reset error:', err.message);
        }

        console.log('\n✅ Database flush completed!\n');
        console.log('Next steps:');
        console.log('1. Restart your STMP server');
        console.log('2. Refresh your browser (Ctrl + Shift + R)');
        console.log('3. You may need to log in again\n');

        await pool.end();
        process.exit(0);

    } catch (error) {
        console.error('\n❌ Fatal error:', error.message);
        console.error('Stack:', error.stack);
        await pool.end();
        process.exit(1);
    }
}

flushDatabase();
