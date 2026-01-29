import express from 'express';
import { dbLogger as logger } from './log.js';
import database from './db-loader.js';
import auth from "./auth.js";

const router = express.Router();


// ============================================================================
// SPECIFIC TABLE ROUTES
// ============================================================================

// --- Users ---
router.get('/users', async (req, res) => {
    const user = auth.verified(req.query.secret)
    if (!user) {
        res.status(403).send("Unauthorised");
        return
    }
    try {
        const data = await database.getUsers();
        res.json(data);
    }
    catch (err) {
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

//TODO compare all secrets
router.get('/checkcookie', async (req, res) => {
    const frontCookie = req.params.cookie;
    try {
        // const storedCookie = null;
        // const data = auth.verified(frontCookie, auth.getStoredCookie);
        const serverCookie = auth.getStoredCookie(frontCookie);
        if (frontCookie === serverCookie) {
            const data = auth.verified(frontCookie);
        //     const susdata = data;
            logger.info(data);
            if (!data) {
                res.status(200).json({valid: !data});
                logger.info("cookie verified");
            }
            else {
                res.status(403).send("Unauthorised ");
                logger.warn(`cookie ${frontCookie} rejected`);
            }
        }
        else {
            res.status(403).send("Unauthorised");
            logger.warn(`coookie ${frontCookie} is invalid`);
        }
    } catch (err) {
        logger.error('cookie erorrrrrr', err);
        res.status(500).json({ error: err.message });
    }
});

router.post('/users/register', async (req, res) => {
    const { flag, ...payload } = req.body;
        try {
            const { username, password } = payload;
            if (!username || !password) {
                return res.status(400).json({ error: 'Username and password are required' });
            }
            const result = await auth.register(username, password);
            return res.status(200).send("Registration success");
        } catch (err) {
            logger.error('Error in /users (register):', err);
            return res.status(500).json({ error: err.message });
        }
});

router.post('/users/login', async (req, res) => {
    const { flag, ...payload } = req.body;
        try {
            const { username, password } = payload;
            if (!username || !password) {
                return res.status(400).send('Username and password are required' );
            }
            const result = await auth.authenticate(username, password);
            return res.json(result);
        } catch (err) {
            logger.error('Error in /users (login):', err);
            return res.status(500).json({ error: err.message });
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
