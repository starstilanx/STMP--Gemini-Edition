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

async function findLostMessages() {
    try {
        console.log('\n🔍 Looking for lost messages...\n');

        // Check all sessions (not just active ones)
        console.log('=== ALL SESSIONS (INCLUDING INACTIVE) ===');
        const allSessions = await pool.query(
            `SELECT session_id, room_id, is_active, started_at, ended_at
             FROM sessions
             ORDER BY session_id ASC`
        );
        console.table(allSessions.rows);

        // Check messages in ALL sessions
        console.log('\n=== MESSAGES IN ALL SESSIONS ===');
        const allMessages = await pool.query(
            `SELECT s.session_id, s.is_active, s.room_id,
                    a.message_id, a.username, LEFT(a.message, 80) as message_preview,
                    a.entity, a.timestamp
             FROM sessions s
             LEFT JOIN aichats a ON s.session_id = a.session_id
             ORDER BY s.session_id ASC, a.message_id ASC`
        );

        // Group by session
        const sessionMap = {};
        allMessages.rows.forEach(row => {
            if (!sessionMap[row.session_id]) {
                sessionMap[row.session_id] = {
                    session_id: row.session_id,
                    is_active: row.is_active,
                    room_id: row.room_id,
                    messages: []
                };
            }
            if (row.message_id) {
                sessionMap[row.session_id].messages.push({
                    id: row.message_id,
                    from: `${row.username} (${row.entity})`,
                    preview: row.message_preview,
                    time: row.timestamp
                });
            }
        });

        Object.values(sessionMap).forEach(session => {
            console.log(`\n━━━━ Session ${session.session_id} (${session.is_active ? 'ACTIVE' : 'inactive'}) ━━━━`);
            console.log(`Room: ${session.room_id}`);
            console.log(`Messages: ${session.messages.length}`);
            session.messages.forEach((msg, i) => {
                console.log(`\n  ${i + 1}. ${msg.from}`);
                console.log(`     ${msg.preview}`);
                console.log(`     ${msg.time}`);
            });
        });

        await pool.end();
        process.exit(0);

    } catch (error) {
        console.error('\n❌ Error:', error.message);
        await pool.end();
        process.exit(1);
    }
}

findLostMessages();
