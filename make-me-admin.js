/**
 * Quick Admin Setup Script
 * Run this once to make yourself a host
 *
 * Usage: node make-me-admin.js
 */

import { config } from 'dotenv';
import pg from 'pg';
const { Pool } = pg;

// Load environment variables
config();

const pool = new Pool({
    host: process.env.PG_HOST || process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || process.env.DB_PORT || '5432'),
    database: process.env.PG_DATABASE || process.env.DB_NAME || 'stmp',
    user: process.env.PG_USER || process.env.DB_USER || 'stmp_user',
    password: process.env.PG_PASSWORD || process.env.DB_PASSWORD,
});

async function makeAllUsersHost() {
    try {
        console.log('Connecting to PostgreSQL...');

        // Get all users
        const users = await pool.query('SELECT user_id, username FROM users');

        if (users.rows.length === 0) {
            console.log('❌ No users found in database');
            process.exit(1);
        }

        console.log(`\nFound ${users.rows.length} user(s):\n`);

        // Make each user a host
        for (const user of users.rows) {
            await pool.query(`
                INSERT INTO user_roles (user_id, role)
                VALUES ($1, 'host')
                ON CONFLICT (user_id) DO UPDATE SET role = 'host'
            `, [user.user_id]);

            console.log(`  ✅ ${user.username} is now a host`);
        }

        console.log(`\n✅ Success! All users are now hosts.`);
        console.log('\nNext steps:');
        console.log('  1. Restart your STMP server (close STMP.bat and run it again)');
        console.log('  2. Refresh your browser (Ctrl + Shift + R)');
        console.log('  3. You should now see the control panel!\n');

    } catch (error) {
        console.error('\n❌ Error:', error.message);
        console.error('\nTroubleshooting:');
        console.error('  - Check your .env file has correct PostgreSQL credentials');
        console.error('  - Make sure PostgreSQL is running');
        console.error('  - Verify the database schema is created (run schema-postgres.sql)\n');
        process.exit(1);
    } finally {
        await pool.end();
    }
}

makeAllUsersHost();
