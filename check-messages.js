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

async function checkMessages() {
    try {
        console.log('\n🔍 Checking chat messages...\n');

        // Check messages in session 1
        console.log('=== MESSAGES IN SESSION 1 ===');
        const messages = await pool.query(
            `SELECT message_id, session_id, username, message, entity, timestamp
             FROM aichats
             WHERE session_id = 1
             ORDER BY message_id ASC`
        );

        console.log(`\nFound ${messages.rows.length} messages:\n`);
        messages.rows.forEach((msg, i) => {
            console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
            console.log(`Message ${i + 1} (ID: ${msg.message_id})`);
            console.log(`From: ${msg.username} (${msg.entity})`);
            console.log(`Time: ${msg.timestamp}`);
            console.log(`\nContent:`);
            console.log(msg.message);
        });

        // Check all messages in all sessions
        console.log('\n=== ALL MESSAGES (ALL SESSIONS) ===');
        const allMessages = await pool.query(
            `SELECT session_id, COUNT(*) as message_count,
                    MIN(timestamp) as first_message,
                    MAX(timestamp) as last_message
             FROM aichats
             GROUP BY session_id
             ORDER BY session_id DESC`
        );
        console.table(allMessages.rows);

        await pool.end();
        process.exit(0);

    } catch (error) {
        console.error('\n❌ Error:', error.message);
        await pool.end();
        process.exit(1);
    }
}

checkMessages();
