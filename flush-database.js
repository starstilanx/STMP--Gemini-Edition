import pg from 'pg';
import dotenv from 'dotenv';
import readline from 'readline';

dotenv.config();

const { Pool } = pg;

const pool = new Pool({
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5432'),
    database: process.env.PG_DATABASE || 'stmp',
    user: process.env.PG_USER || 'stmp_user',
    password: process.env.PG_PASSWORD,
});

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

async function flushDatabase() {
    try {
        console.log('\n⚠️  WARNING: This will DELETE ALL DATA from your PostgreSQL database!');
        console.log('This includes:');
        console.log('  - All chat messages (AI and user)');
        console.log('  - All sessions');
        console.log('  - All users (except those with passwords)');
        console.log('  - All characters');
        console.log('  - All lorebooks and entries');
        console.log('  - All API configurations');
        console.log('  - All room data');
        console.log('\n⚠️  This CANNOT be undone!\n');

        const answer = await new Promise((resolve) => {
            rl.question('Type "FLUSH" to confirm deletion: ', (answer) => {
                resolve(answer);
            });
        });

        if (answer !== 'FLUSH') {
            console.log('\n❌ Cancelled. No data was deleted.');
            rl.close();
            await pool.end();
            process.exit(0);
        }

        console.log('\n🔄 Flushing database...\n');

        // Delete in order to respect foreign key constraints
        console.log('Deleting chat messages...');
        await pool.query('DELETE FROM aichats');
        await pool.query('DELETE FROM userchats');

        console.log('Deleting sessions...');
        await pool.query('DELETE FROM sessions');
        await pool.query('DELETE FROM "userSessions"');

        console.log('Deleting lorebook entries...');
        await pool.query('DELETE FROM lorebook_entries');

        console.log('Deleting lorebooks...');
        await pool.query('DELETE FROM lorebooks');

        console.log('Deleting room memberships...');
        await pool.query('DELETE FROM room_members');

        console.log('Deleting room configurations...');
        await pool.query('DELETE FROM room_configs');

        console.log('Deleting rooms...');
        await pool.query('DELETE FROM rooms');

        console.log('Deleting characters...');
        await pool.query('DELETE FROM characters');

        console.log('Deleting user roles...');
        await pool.query('DELETE FROM user_roles');

        console.log('Deleting users without passwords...');
        await pool.query('DELETE FROM users WHERE password_hash IS NULL');

        console.log('Deleting API configurations...');
        await pool.query('DELETE FROM apis');

        // Reset sequences
        console.log('\nResetting auto-increment sequences...');
        await pool.query(`SELECT setval('sessions_session_id_seq', 1, false)`);
        await pool.query(`SELECT setval('"userSessions_session_id_seq"', 1, false)`);
        await pool.query(`SELECT setval('aichats_message_id_seq', 1, false)`);
        await pool.query(`SELECT setval('userchats_message_id_seq', 1, false)`);

        console.log('\n✅ Database flushed successfully!\n');
        console.log('Next steps:');
        console.log('1. Restart your STMP server');
        console.log('2. Refresh your browser (Ctrl + Shift + R)');
        console.log('3. You may need to log in again\n');

        rl.close();
        await pool.end();
        process.exit(0);

    } catch (error) {
        console.error('\n❌ Error flushing database:', error.message);
        rl.close();
        await pool.end();
        process.exit(1);
    }
}

flushDatabase();
