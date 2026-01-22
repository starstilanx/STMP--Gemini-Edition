import express from 'express';
import db from './db.js';
import { dbLogger as logger } from './log.js';

const router = express.Router();

// ============================================================================
// UNIVERSAL ROUTE
// ============================================================================
router.get('/universal/:table', async (req, res) => {
    const tableName = req.params.table;
    try {
        // basic security check via getTableData which checks schema keys
        const data = await db.getTableData(tableName);
        res.json(data);
    } catch (err) {
        if (err.message === 'Invalid table name') {
            res.status(400).json({ error: 'Invalid table name' });
        } else {
            logger.error(`Error querying table ${tableName}:`, err);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
});

// ============================================================================
// SPECIFIC TABLE ROUTES
// ============================================================================

// --- Users ---
router.get('/users', async (req, res) => {
    try {
        // Custom query to exclude password_hash for security? 
        // For now, mirroring universal behavior but explicit endpoint
        const data = await db.getTableData('users');
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/users/:user_id', async (req, res) => {
    const userId = req.params.user_id;
    try {
        const result = await db.query(`
            SELECT user_id, username, username_color, persona, created_at, last_seen_at 
            FROM users WHERE user_id = $1
        `, [userId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }
        res.json(result.rows[0]);
    } catch (err) {
        logger.error('Error in /users/:user_id:', err);
        res.status(500).json({ error: err.message });
    }
});

router.get('/user_roles', async (req, res) => {
    try {
        res.json(await db.getTableData('user_roles'));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Chat Data ---
router.get('/aichats', async (req, res) => {
    try {
        // Optimized query with ordering
        const result = await db.query('SELECT * FROM aichats ORDER BY message_id DESC LIMIT 100');
        res.json(result.rows);
    } catch (err) {
        logger.error('Error in /aichats:', err);
        res.status(500).json({ error: err.message });
    }
});

router.get('/userchats', async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM userchats ORDER BY message_id DESC LIMIT 100');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/sessions', async (req, res) => {
    try { res.json(await db.getTableData('sessions')); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/userSessions', async (req, res) => {
    try { res.json(await db.getTableData('userSessions')); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Rooms ---
router.get('/rooms', async (req, res) => {
    try { res.json(await db.getTableData('rooms')); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/room_members', async (req, res) => {
    try { res.json(await db.getTableData('room_members')); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Content ---
router.get('/characters', async (req, res) => {
    try { res.json(await db.getTableData('characters')); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/lorebooks', async (req, res) => {
    try { res.json(await db.getTableData('lorebooks')); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/lorebook_entries', async (req, res) => {
    try { res.json(await db.getTableData('lorebook_entries')); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

// --- System ---
router.get('/apis', async (req, res) => {
    try {
        // Filter out sensitive keys?
        const data = await db.getTableData('apis');
        res.json(data);
    }
    catch (err) { res.status(500).json({ error: err.message }); }
});


export default router;
