import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import router from './src/db_routes.js';


const localApp = express();


localApp.use(cors()); // Enable CORS for local app
localApp.use(bodyParser.json());



localApp.use('/api', router);

localApp.get('/', async (req, res) => {
    const filePath = path.join(__dirname, 'public/client.html');
    try {
        const data = await readFile(filePath, 'utf8');
        res.status(200).send(data);
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

