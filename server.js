import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import router from './src/db_routes.js';
import path from 'path';
import { logger } from './src/log.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const localApp = express();


localApp.use(cors()); // Enable CORS for local app
localApp.use(bodyParser.json());



localApp.use('/api', router);

localApp.get('/', async (req, res) => {
    const filePath = path.join(__dirname, 'public/client.html');
    try {
        res.sendFile(filePath);
    } catch (err) {
        logger.error('Error loading client HTML:', err);
        res.status(500).send('Error loading the client HTML file');
    }
});

localApp.use(express.static('public'));

localApp.listen(8181, (error) => {

    if (error) {
        console.error('Error starting server:', error);
    }
    else {
        console.log('server running on port 8181');
    }
});

