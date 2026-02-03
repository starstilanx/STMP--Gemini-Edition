import express from 'express';
import { dbLogger as logger } from './log.js';
import database from './db-loader.js';
import auth from "./auth.js";

const router = express.Router();
//TODO new middleware for securing api

// ============================================================================
// SPECIFIC TABLE ROUTES
// ============================================================================

// --- Users ---

router.get('/checkcookie', async (req, res) => {
    const frontCookie = req.query.cookie;
    logger.info(JSON.stringify(frontCookie) + " Front has a cooker")
    try {
        if (!frontCookie) {
            logger.warn(`no cookie`);
            res.status(403).send("Not a ckookie" + {valid: false});
        }
        else {
            const hasServerCookie = auth.hasServerSecret(frontCookie);
            logger.info(hasServerCookie + " Server has cook");
            if (hasServerCookie) {
                const serverCookie = auth.GetServerSecret(frontCookie)
                if ((serverCookie === frontCookie)) {
                    res.status(200).json({valid: true});
                    logger.info("cookie verified " + frontCookie);
                }
                else {
                res.status(200).send({valid: false});
                logger.warn(`cookie ${frontCookie} rejected`);
                }
            } else {
                res.status(200).send({valid: false});
                logger.warn(`cookie ${frontCookie} is invalid`);
            }
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
    const payload = req.body;
        try {
            const { username, password } = payload;
            if (!username || !password) {
                return res.status(400).send('Username and password are required' );
            }
            const result = await auth.authenticate(username, password);
            return res.cookie('secret', result.secret).send(result);
        } catch (err) {
            logger.error('Error in /users (login):', err);
            return res.status(500).json({ error: err.message });
        }
});









export default router;
