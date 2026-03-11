import auth from "./src/auth.js"
import { logger } from "./src/log.js"
import { writeUserChatMessage } from "./src/db-pg.js";

const sessions = new Map();
const clientConnections = new Map();

function cookieParser(cookieString) {
    if (!cookieString) return {};

    let pairs = cookieString.split(";");

    let splittedPairs = pairs.map(cookie => cookie.split("="));

    return splittedPairs.reduce(function (obj, cookie) {
        obj[decodeURIComponent(cookie[0].trim())]
            = decodeURIComponent(cookie[1].trim());

        return obj;
    }, {});
}

export function handleSocket(ws, req) {
    logger.info("client opened connection")
    // const urlParams = new URLSearchParams(ws.url.split('?')[1]);

    // const clientSecret = urlParams.get('client-secret');
    const headers = req.headers['cookie'];
    const cookies = cookieParser(headers);
    const clientSecret = cookies['secret'];

    // logger.info(JSON.stringify(headers));
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

    // ws.on('message', message => {
    //     ws.send(message)
    // })

    ws.on('message', async raw => {
        let msg;
        try {
            msg = JSON.parse(raw)
        } catch {
            ws.send(JSON.stringify({ type: 'error', error: 'invalid JSON' }))
            return
        }

        switch (msg.type) {
            case 'join':
                // msg.roomID
                break
            case 'message':
                // msg.content
                await writeUserChatMessage(req.body.user_id, req.body.message, req.body.room_id);
                broadcast({ type: "message", content: req.body });
                break
            case 'leave':
                break
            default:
                ws.send(JSON.stringify({ type: 'error', error: `unknown type: ${msg.type}` }))
        }
    })

    ws.on('ping', ws.pong) //TODO properly close sockets

    ws.send(JSON.stringify({ type: 'auth', content: 'welcome :D' })) //successful socket auth
}

export function broadcast(message) {
    logger.info('broadcast start')
    logger.info(sessions)
    logger.info(sessions.size)
    for (let [sessionID, ws] of sessions) {
        logger.info('broadcast')
        ws.send(JSON.stringify(message))
    }
}