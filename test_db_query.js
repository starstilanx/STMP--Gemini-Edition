import db from './src/db.js';

async function test() {
    console.log('Waiting for DB init...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    console.log('Testing getTableData...');
    try {
        const users = await db.getTableData('users');
        console.log(`Successfully retrieved ${users.length} users.`);

        console.log('Testing Room Creation...');
        const room = await db.createRoom('Test Room', 'A test room', null);
        console.log('Created room:', room);

        const rooms = await db.getAllActiveRooms();
        console.log(`Found ${rooms.length} active rooms.`);
    } catch (err) {
        console.error('Error testing db:', err);
    }
}

test();
