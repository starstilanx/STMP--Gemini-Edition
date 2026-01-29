import database from "./db-loader.js";
import { config } from 'dotenv';
import { logger } from './log.js';
import bcrypt from 'bcrypt';
import crypto from 'crypto';

const BCRYPT_SALT_ROUNDS = 10;

let secrets = new Map();

function genUUID() {
    return crypto.randomUUID();
}

function genSecret() {
    return Buffer.from(crypto.randomBytes(32)).toString('base64');
}

function checkPasswordStyle(password) {
    return /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z]).{8,32}$/.test(password);
}

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
            logger.warn('User already registered');
            return null;
        }
    } catch (error) {
        console.error(error);
        return null;
    }
    return uuid;
}

async function authenticate(username, password) {
    try {
        const gotUsername = await database.getUserAuth(username)
        if (!gotUsername) {
            logger.info("Wrong username input")
            return {
                success: false,
                failure: "Username doesn't exist",
            };
        }
        const isCorrect = bcrypt.compareSync(password, gotUsername.password_hash);
        if (!isCorrect) {
            logger.info("Wrong password input")

            return {
                success: false,
                failure: "lol get rekd",
            };
        }
        const secret = genSecret();
        secrets.set(secret, {uuid: gotUsername.user_id, username: username});
        logger.info("secret set")

        return {
            success: true,
            secret: secret,
        }

    } catch (error) {
        console.error(error);
        return {
            success: false,
            failure: "error occured",
        }
    }
}

function verified(secret) {
    logger.info(secrets, "verified");
    return secrets.get(secret)
}

function getStoredCookie(secret) {
    logger.info(secrets, "getStoredCookie");
    return secrets.get(secret)
}

function logOut(secret) {
    secrets.delete(secret)
}

export default {
    register,
    authenticate,
    verified,
    getStoredCookie,
}