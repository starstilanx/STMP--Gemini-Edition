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

async function checkSessions() {
    try {
        console.log('\n🔍 Checking database sessions...\n');

        // Check all sessions
        console.log('=== ALL SESSIONS ===');
        const allSessions = await pool.query(
            `SELECT session_id, room_id, is_active, started_at, ended_at
             FROM sessions
             ORDER BY session_id DESC
             LIMIT 20`
        );
        console.table(allSessions.rows);

        // Check active sessions
        console.log('\n=== ACTIVE SESSIONS ===');
        const activeSessions = await pool.query(
            `SELECT session_id, room_id, is_active, started_at
             FROM sessions
             WHERE is_active = TRUE
             ORDER BY session_id DESC`
        );
        console.table(activeSessions.rows);

        // Check message counts per session
        console.log('\n=== MESSAGE COUNTS PER SESSION ===');
        const messageCounts = await pool.query(
            `SELECT s.session_id, s.room_id, s.is_active, COUNT(a.message_id) as message_count
             FROM sessions s
             LEFT JOIN aichats a ON s.session_id = a.session_id
             GROUP BY s.session_id, s.room_id, s.is_active
             ORDER BY s.session_id DESC
             LIMIT 20`
        );
        console.table(messageCounts.rows);

        // Check for multiple active sessions in same room
        console.log('\n=== ROOMS WITH MULTIPLE ACTIVE SESSIONS ===');
        const multipleActive = await pool.query(
            `SELECT room_id, COUNT(*) as active_count
             FROM sessions
             WHERE is_active = TRUE
             GROUP BY room_id
             HAVING COUNT(*) > 1`
        );

        if (multipleActive.rows.length > 0) {
            console.log('❌ PROBLEM FOUND: Multiple active sessions in same room!');
            console.table(multipleActive.rows);
        } else {
            console.log('✅ No duplicate active sessions found');
        }

        await pool.end();
        process.exit(0);

    } catch (error) {
        console.error('\n❌ Error:', error.message);
        await pool.end();
        process.exit(1);
    }
}

checkSessions();
