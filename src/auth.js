import database from "./db-loader.js";
import {logger} from './log.js';
import bcrypt from 'bcrypt';
import crypto from 'crypto';

const BCRYPT_SALT_ROUNDS = 10;

let secrets = new Map();

//generates a uuid
function genUUID() {
    return crypto.randomUUID();
}

//generates secret for the map
function genSecret() {
    return Buffer.from(crypto.randomBytes(32)).toString('base64');
}

//confirms password style
function checkPasswordStyle(password) {
    return /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z]).{8,32}$/.test(password);
}

//registration logic
//TODO improve user responsiveness
async function register(username, password) {
    const hashedPassword = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
    const uuid = genUUID();
    try {
        const susUsername = await database.checkUsernameAvailable()
        const susPassword = checkPasswordStyle(password);
        if (susUsername) {
            await database.insertUser(uuid, username, hashedPassword);

            const secret = genSecret();

            secrets.set(secret, {uuid: uuid, username: username});
            logger.info(`new user registered with username: ${username}`);
        }
        else if (susPassword) {
            await database.insertUser(uuid, username, hashedPassword);

            const secret = genSecret();

            secrets.set(secret, {uuid: uuid, username: username});
            logger.info(`new user registered with username: ${username}`);
        }
        else {
            logger.error('User already registered');
            return null;
        }
    } catch (error) {
        logger.error(error);
        return null;
    }
    return uuid;
}

//basically login logic
async function authenticate(username, password) {
    try {
        const gotUsername = await database.getUserAuth(username)
        if (!gotUsername) {
            logger.info("Wrong username input");
            return {
                success: false,
                failure: "Username doesn't exist",
            };
        }
        const isCorrect = bcrypt.compareSync(password, gotUsername.password_hash);
        if (!isCorrect) {
            logger.info("Wrong password input");

            return {
                success: false,
                failure: "lol get rekd",
            };
        }
        const secret = genSecret();
        secrets.set(secret, {uuid: gotUsername.user_id, username: username});
        logger.info("secret set");

        return {
            success: true,
            secret: secret,
        }

    } catch (error) {
        console.error(error);
        return {
            success: false,
            failure: "error occurred",
        }
    }
}

//returns data from map using key as param
function verified(secret) {
    logger.info(secrets);
    const data = secrets.get(secret);
    logger.info(data);
    if (data) {
        return data
    }
}

//deletes param secret from map
function logOut(secret) {
    secrets.delete(secret);
    logger.warn(`Secret ${JSON.stringify(secret)} deleted, user logged out`);
}

//returns param secret if secret is in map
function getServerSecret(key) {
    if (secrets.has(key)) {
        return key;
    } else {
        return false;
    }
}

//returns bool based on presence of the param key in map
function hasServerSecret(key) {
    return secrets.has(key);
}

//returns user data based on the secret in the map
async function getActiveUser(secret) {
    const gotUsername = await verified(secret);
    logger.info(JSON.stringify(gotUsername), " getActiveUser");
    if (!gotUsername) {
        return null
    }
    else {
        logger.info(`user ${secrets} accessed` );
        logger.info("auth 115 + secrets " + gotUsername);
        return gotUsername;
    }
}

const checkSecret = (req, res, next) => {
    const clientSecret = req.cookies['secret'];

    if (!clientSecret) {
        logger.warn(JSON.stringify(req.cookies) + "failed login attempt");
        return res.status(403).send({ error: "No secret provided" });
    }
    const isValid = secrets.has(clientSecret);
    if (isValid && (clientSecret === getServerSecret(clientSecret))) {
        next();
    } else {
        res.status(403).send({ error: "Invalid or expired secret" });
    }
};

export default {
    register,
    authenticate,
    logOut,
    checkSecret,
    getActiveUser,
    hasServerSecret,
    getServerSecret,
    verified,
}