import database from "./db-loader.js";
import { config } from 'dotenv';
import { dbLogger as logger } from './log.js';
import bcrypt from 'bcrypt';
import crypto from 'crypto';

const BCRYPT_SALT_ROUNDS = 10;

let secrets = new Map();

function genUUID() {
    return crypto.randomUUID();
}

function genSecret() {
    return Buffer.from(crypto.randomBytes(32)).toString('hex');
}

//TODO improve user responsiveness
async function register(username, password) {
    const hashedPassword = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
    const uuid = genUUID();
    try {
        await database.insertUser(uuid, username, hashedPassword);

        const secret = genSecret();

        secrets.set(secret, {uuid: uuid, username: username});
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
            return {
                success: false,
                failure: "Username doesn't exists",
            };
        }
        const isCorrect = bcrypt.compareSync(password, gotUsername.password_hash);
        if (!isCorrect) {
            return {
                success: false,
                failure: "lol get rekd",
            };
        }
        const secret = genSecret();
        secrets.set(secret, {uuid: gotUsername.user_id, username: username});
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
    return secrets.get(secret)
}

export default {
    register,
    authenticate,
    verified,
}