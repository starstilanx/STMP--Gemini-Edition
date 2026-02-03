import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';
import router from './src/general_routes.js';
import path from 'path';
import { logger } from './src/log.js';
import { fileURLToPath } from 'url';
import secureRouter from "./src/secure_routes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const localApp = express();

localApp.use(cors());
localApp.use(bodyParser.json());
localApp.use(cookieParser());

localApp.use('/api', router);
localApp.use('/api/secure', secureRouter);

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

