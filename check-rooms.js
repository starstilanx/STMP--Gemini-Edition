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

async function checkRooms() {
    try {
        console.log('\n🔍 Checking rooms table...\n');

        // Check all rooms (including inactive ones)
        console.log('=== ALL ROOMS ===');
        const allRooms = await pool.query(
            `SELECT room_id, name, description, created_by, created_at, is_active
             FROM rooms
             ORDER BY created_at DESC`
        );
        console.table(allRooms.rows);

        // Check active rooms with member counts
        console.log('\n=== ACTIVE ROOMS WITH MEMBERS ===');
        const activeRooms = await pool.query(
            `SELECT
                r.room_id,
                r.name,
                r.description,
                r.created_by,
                r.created_at,
                r.is_active,
                COUNT(DISTINCT rm.user_id) AS member_count,
                STRING_AGG(DISTINCT u.username, ', ') AS member_names
             FROM rooms r
             LEFT JOIN room_members rm ON r.room_id = rm.room_id
             LEFT JOIN users u ON rm.user_id = u.user_id
             WHERE r.is_active = TRUE
             GROUP BY r.room_id, r.name, r.description, r.created_by, r.created_at, r.is_active
             ORDER BY r.created_at DESC`
        );
        console.table(activeRooms.rows);

        // Check for NULL names
        console.log('\n=== ROOMS WITH NULL NAMES ===');
        const nullNames = await pool.query(
            `SELECT room_id, name, description, is_active
             FROM rooms
             WHERE name IS NULL`
        );

        if (nullNames.rows.length > 0) {
            console.log('⚠️  Found rooms with NULL names:');
            console.table(nullNames.rows);
            console.log('\n💡 These should be fixed or deleted.');
        } else {
            console.log('✅ No rooms with NULL names found.');
        }

        // Check room members
        console.log('\n=== ROOM MEMBERS ===');
        const members = await pool.query(
            `SELECT rm.room_id, r.name as room_name, u.username, rm.role, rm.joined_at
             FROM room_members rm
             JOIN rooms r ON rm.room_id = r.room_id
             JOIN users u ON rm.user_id = u.user_id
             ORDER BY r.name, rm.joined_at`
        );

        if (members.rows.length > 0) {
            console.table(members.rows);
        } else {
            console.log('No room members found.');
        }

        await pool.end();
        process.exit(0);

    } catch (error) {
        console.error('\n❌ Error:', error.message);
        await pool.end();
        process.exit(1);
    }
}

checkRooms();
