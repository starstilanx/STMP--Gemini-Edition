import express from 'express';
import { dbLogger as logger } from './log.js';
import database from './db-loader.js';

const router = express.Router();


// ============================================================================
// SPECIFIC TABLE ROUTES
// ============================================================================

// --- Users ---
router.get('/users', async (req, res) => {
    try {
        // Custom query to exclude password_hash for security? 
        // For now, mirroring universal behavior but explicit endpoint
        const data = await database.getUsers();
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/users/:user_id', async (req, res) => {
    const userId = req.params.user_id;
    try {
        const data = await database.getUser(userId);
        res.json(data);

    } catch (err) {
        logger.error('Error in /users/:user_id:', err);
        res.status(500).json({ error: err.message });
    }
});

// --- Chat Data ---
router.get('/aichats', async (req, res) => {
    try {
        // Optimized query with ordering
        const result = await database.readAIChat();
        res.json(result);
    } catch (err) {
        logger.error('Error in /aichats:', err);
        console.error('Error in /aichats:', err);
        res.status(500).json({ error: err.message });
    }
});

router.post('/aichats', async (req, res) => {
    logger.info('Received POST request to /aichats');
    logger.info('Request body:', req.body);
    res.status(200).send('request received');

    // try {
    //     const result = await database.query('INSERT INTO aichats (message_id, session_id, room_id, user_id, username, message, entity, timestamp) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *', [
    //         req.body.message_id,
    //         req.body.session_id,
    //         req.body.room_id,
    //         req.body.user_id,
    //         req.body.username,
    //         req.body.message,
    //         req.body.entity,
    //         req.body.timestamp
    //     ]);
    //     res.json(result.rows[0]);
    // } catch (err) {
    //     logger.error('Error in /aichats:', err);
    //     res.status(500).json({ error: err.message });
    // }
});

router.get('/userchats', async (req, res) => {
    try {
        const result = await database.readUserChat();
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/userchats', async (req, res) => {
    logger.info('Received POST request to /userchats');
    logger.info('Request body:', req.body);
    res.status(200).send('request received');

    // try {
    //     const result = await db.query('INSERT INTO userchats (message_id, session_id, room_id, user_id, username, message, entity, timestamp) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *', [
    //         req.body.message_id,
    //         req.body.session_id,
    //         req.body.room_id,
    //         req.body.user_id,
    //         req.body.username,
    //         req.body.message,
    //         req.body.entity,
    //         req.body.timestamp
    //     ]);
    //     res.json(result.rows[0]);
    // } catch (err) {
    //     logger.error('Error in /userchats:', err);
    //     res.status(500).json({ error: err.message });
    // }
});


// --- Rooms ---
router.get('/rooms', async (req, res) => {
    try { res.json(await database.getRooms()); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/room_members', async (req, res) => {
    try { res.json(await database.getRoomMembers()); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Content ---
router.get('/characters', async (req, res) => {
    try { res.json(await database.getCharacters()); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/lorebooks', async (req, res) => {
    try { res.json(await database.getLorebooks()); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/lorebook_entries', async (req, res) => {
    try { res.json(await database.getLorebookEntries()); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

// --- System ---
router.get('/apis', async (req, res) => {
    try {
        // Filter out sensitive keys?
        const data = await database.getApis();
        res.json(data);
    }
    catch (err) { res.status(500).json({ error: err.message }); }
});


export default router;
