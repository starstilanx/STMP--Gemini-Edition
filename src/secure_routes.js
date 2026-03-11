import auth from "./auth.js";
import database from "./db-loader.js";
import {dbLogger as logger} from "./log.js";
import express from "express";
import router from "./general_routes.js";
import {broadcast} from "../new_ws.js";
import { writeUserChatMessage } from "./db-pg.js";

const secureRouter = express.Router();

secureRouter.use(auth.checkSecret)

secureRouter.get('/users', async (req, res) => {
    try {
        const data = await database.getUsers();
        res.json(data);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});

secureRouter.post('/users/logout', async (req, res) => {
    const secret = req.body;
    try {
        if (secret) {
            auth.logOut(secret);
            return res.status(200).send('logged out' );
        }
        else {
            return res.status(400).send('invalid payload');
        }
    } catch (err) {
        logger.error('Error in /users (logout):', err);
        return res.status(500).json({ error: err.message });
    }
});

secureRouter.get('/users/active', async (req, res) => {
    logger.warn(req.cookies['secret'])
    const userSecret = auth.getServerSecret(req.cookies['secret']);
    logger.info(userSecret, "user secret");
    // if (!userSecret) {
    //     res.status(403).send("bad cookie");
    //     logger.error("No cookie provided");
    //     return {
    //         success: false,
    //     }
    // }
    // else {
        try {
            const data = await auth.getActiveUser(userSecret);
            logger.info("getactiveuser data " + JSON.stringify(data));
            if (!data) {
                res.status(500).send("error");
            }
            else {
                res.status(200).send(data.uuid);
                logger.info(`User ${JSON.stringify(data.uuid)} is active`);
            }
        } catch (err) {
            res.status(500).json({error: err.message});
        }
    // }
});

secureRouter.get('/secure/users/:user_id', async (req, res) => {
    const userId = req.params.user_id;
    try {
        const data = await database.getUser(userId);
        res.json(data);

    } catch (err) {
        logger.error('Error in /users/:user_id:', err);
        res.status(500).json({ error: err.message });
    }
});

secureRouter.get('/aichats', async (req, res) => {
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

secureRouter.post('/aichats', async (req, res) => {
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


secureRouter.get('/userchats', async (req, res) => {
    try {
        const result = await database.readUserChat();
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

secureRouter.post('/userchats', async (req, res) => {
    logger.info('Received POST request to /userchats');
    logger.info('Request body:', req.body);
    res.status(200).send('request received');
//TODO store msg in database
    const writtenMsg = await writeUserChatMessage(req.body.user_id, req.body.message, req.body.room_id);
    broadcast({type: "usermsg", content: { message_id: writtenMsg.message_id, room_id: req.body.room_id, user_id: req.body.user_id, message: req.body.message, timestamp: writtenMsg.timestamp }});
});


// --- Rooms ---
secureRouter.get('/rooms', async (req, res) => {
    try { res.json(await database.getRooms()); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

secureRouter.get('/room_members', async (req, res) => {
    try { res.json(await database.getRoomMembers()); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Content ---
secureRouter.get('/characters', async (req, res) => {
    try { res.json(await database.getCharacters()); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

secureRouter.get('/lorebooks', async (req, res) => {
    try { res.json(await database.getLorebooks()); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

secureRouter.get('/lorebook_entries', async (req, res) => {
    try { res.json(await database.getLorebookEntries()); }
    catch (err) { res.status(500).json({ error: err.message }); }
});


secureRouter.get('/apis', async (req, res) => {
    try {
        // Filter out sensitive keys?
        const data = await database.getApis();
        res.json(data);
    }
    catch (err) { res.status(500).json({ error: err.message }); }
});

export default secureRouter;