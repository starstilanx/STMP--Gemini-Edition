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

async function fixModelLists() {
    try {
        console.log('\n🔧 Fixing modelList data in database...\n');

        // Get all APIs
        const result = await pool.query('SELECT name, "modelList" FROM apis');

        console.log(`Found ${result.rows.length} API(s)\n`);

        for (const api of result.rows) {
            console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
            console.log(`API: ${api.name}`);
            console.log(`Current modelList (raw): ${api.modelList}`);

            if (!api.modelList) {
                console.log('  ⚠️  No modelList, skipping');
                continue;
            }

            try {
                // Try to parse as JSON first
                const parsed = JSON.parse(api.modelList);
                if (Array.isArray(parsed)) {
                    console.log('  ✅ Already valid JSON array, no fix needed');
                    continue;
                }
            } catch (e) {
                // Not valid JSON, might be malformed
                console.log('  ⚠️  Invalid JSON detected');
            }

            // Extract model names from the malformed string
            // Format: {"model1","model2","model3"} needs to become ["model1","model2","model3"]
            const modelListStr = api.modelList;

            // Check if it looks like a Set serialization (curly braces without colons)
            if (modelListStr.startsWith('{') && modelListStr.endsWith('}') && !modelListStr.includes(':')) {
                // Extract the model names
                const content = modelListStr.slice(1, -1); // Remove { and }
                const models = content.split(',').map(m => m.trim().replace(/^"|"$/g, ''));

                console.log('  🔧 Extracted models:', models);

                // Convert to proper JSON array
                const fixedModelList = JSON.stringify(models);
                console.log('  ✅ Fixed modelList:', fixedModelList);

                // Update the database
                await pool.query(
                    'UPDATE apis SET "modelList" = $1 WHERE name = $2',
                    [fixedModelList, api.name]
                );

                console.log('  ✅ Database updated successfully');
            } else {
                console.log('  ⚠️  Unknown format, skipping');
            }
        }

        console.log('\n\n✅ Finished fixing modelList data!');
        console.log('\nNext steps:');
        console.log('  1. Restart your STMP server');
        console.log('  2. Refresh your browser');
        console.log('  3. Model lists should now load correctly!\n');

        await pool.end();
        process.exit(0);

    } catch (error) {
        console.error('\n❌ Error:', error.message);
        console.error('\nTroubleshooting:');
        console.error('  - Check your .env file has correct PostgreSQL credentials');
        console.error('  - Make sure PostgreSQL is running');
        console.error('  - Verify the database schema is created\n');
        await pool.end();
        process.exit(1);
    }
}

fixModelLists();
