import auth from "./src/auth.js"
import {logger} from "./src/log.js"

const sessions = new Map();
const clientConnections = new Map();

function cookieParser(cookieString) {
    if (cookieString === "")
        return {};

    let pairs = cookieString.split(";");

    let splittedPairs = pairs.map(cookie => cookie.split("="));

    const cookieObj = splittedPairs.reduce(function (obj, cookie) {
        obj[decodeURIComponent(cookie[0].trim())]
            = decodeURIComponent(cookie[1].trim());

        return obj;
    }, {})

    return cookieObj;
}

export function handleSocket(ws, req) {
    logger.warn("client opened connection")
    // const urlParams = new URLSearchParams(ws.url.split('?')[1]);

    // const clientSecret = urlParams.get('client-secret');
    const headers = req.headers['cookie'];
    const cookies = cookieParser(headers);
    const clientSecret = cookies['secret'];

    logger.info(JSON.stringify(headers));
    // const clientSecret = cookieParser(headers);
    logger.warn(clientSecret)
    if (!clientSecret) {
        ws.send('no secret')
        ws.close()
        return;
    }
    const verifiedData = auth.verified(clientSecret);
    if (!verifiedData) {
        ws.send('unauthorized')
        ws.close()
        return;
    }
    if (sessions.size > 100) {
        ws.send('sessions limit reached')
        ws.close()
        return;
    }
    let count = clientConnections.get(verifiedData.uuid) || 0
    if (count > 5) {
        ws.send('too many connections');
        ws.close();
        return;
    }

    let sessionID = 1234567890;

    do {
        sessionID = verifiedData.uuid + '%' + Math.floor(Math.random() * 99999)
    } while (sessions.has(sessionID)); //this was cursed because I can :D

    sessions.set(sessionID, ws)
    clientConnections.set(verifiedData.uuid, count++);

    ws.on('message', message => {
        ws.send(message)
    })

    ws.on('ping', ws.pong)

    ws.send(':D') //successful socket auth
}