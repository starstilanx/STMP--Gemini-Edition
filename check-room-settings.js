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

async function checkRoomSettings() {
    try {
        console.log('\n🔍 Checking room settings...\n');

        // Check all rooms
        console.log('=== ALL ROOMS ===');
        const rooms = await pool.query(
            `SELECT room_id, name, settings, created_at
             FROM rooms
             ORDER BY created_at DESC`
        );

        rooms.rows.forEach(room => {
            console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
            console.log(`Room: ${room.name} (${room.room_id})`);
            console.log(`Created: ${room.created_at}`);
            console.log(`\nSettings (raw):`);
            console.log(room.settings);

            if (room.settings) {
                try {
                    const parsed = JSON.parse(room.settings);
                    console.log(`\nSettings (parsed):`);
                    console.log(JSON.stringify(parsed, null, 2));
                } catch (e) {
                    console.log('Failed to parse settings:', e.message);
                }
            }
        });

        await pool.end();
        process.exit(0);

    } catch (error) {
        console.error('\n❌ Error:', error.message);
        await pool.end();
        process.exit(1);
    }
}

checkRoomSettings();
