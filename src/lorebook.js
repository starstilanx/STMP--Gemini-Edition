/**
 * Lorebook / World Info Activation Engine
 * 
 * This module handles scanning chat history for keywords and returning
 * activated lorebook entries to inject into the AI prompt.
 */

import db from './db.js';
import { apiLogger as logger } from './log.js';

/**
 * Approximate token count from character length
 * Uses a simple heuristic of ~4 chars per token
 */
function approxTokensFromChars(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
}

/**
 * Check if a keyword matches in the text buffer
 * Uses whole-word matching with word boundaries
 * @param {string} keyword - The keyword to search for
 * @param {string} textBuffer - The text to search in
 * @param {boolean} caseSensitive - Whether matching is case-sensitive
 * @returns {boolean} - True if keyword matches
 */
function keywordMatches(keyword, textBuffer, caseSensitive = false) {
    if (!keyword || !textBuffer) return false;
    
    const flags = caseSensitive ? 'g' : 'gi';
    // Escape special regex characters in keyword
    const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Create word boundary regex
    const regex = new RegExp(`\\b${escapedKeyword}\\b`, flags);
    
    return regex.test(textBuffer);
}

/**
 * Build a text buffer from chat history for scanning
 * @param {Array} chatHistory - Array of chat message objects
 * @param {number} scanDepth - How many messages to include
 * @param {boolean} includeNames - Whether to include character names
 * @returns {string} - Concatenated text buffer
 */
function buildScanBuffer(chatHistory, scanDepth, includeNames = true) {
    if (!chatHistory || !Array.isArray(chatHistory)) return '';
    
    // Take the last N messages based on scan depth
    const messagesToScan = chatHistory.slice(-scanDepth);
    
    const buffer = messagesToScan.map(msg => {
        if (includeNames && msg.username) {
            return `${msg.username}: ${msg.content || ''}`;
        }
        return msg.content || '';
    }).join('\n');
    
    return buffer;
}

/**
 * Main function to get activated entries from lorebooks
 * @param {Array} chatHistory - Array of chat message objects
 * @param {Object} options - Configuration options
 * @param {number} options.scanDepth - How many messages to scan (default: 5)
 * @param {number} options.tokenBudget - Max tokens for World Info (default: 500)
 * @param {boolean} options.caseSensitive - Case-sensitive matching (default: false)
 * @param {boolean} options.includeNames - Include names in scan buffer (default: true)
 * @returns {Promise<Object>} - Object with activatedEntries array and metadata
 */
async function getActivatedEntries(chatHistory, options = {}) {
    const {
        scanDepth = 5,
        tokenBudget = 500,
        caseSensitive = false,
        includeNames = true
    } = options;

    logger.info(`[WorldInfo] Scanning with depth=${scanDepth}, budget=${tokenBudget} tokens`);

    try {
        // Get all enabled entries from enabled lorebooks
        const allEntries = await db.getAllEnabledEntries();
        
        if (allEntries.length === 0) {
            logger.debug('[WorldInfo] No enabled entries found');
            return { activatedEntries: [], totalTokens: 0, matched: [] };
        }

        // Build text buffer for scanning
        const textBuffer = buildScanBuffer(chatHistory, scanDepth, includeNames);
        
        if (!textBuffer) {
            logger.debug('[WorldInfo] Empty text buffer, no messages to scan');
            return { activatedEntries: [], totalTokens: 0, matched: [] };
        }

        logger.debug(`[WorldInfo] Scanning buffer (${textBuffer.length} chars) against ${allEntries.length} entries`);

        const activatedEntries = [];
        const matchedKeywords = [];
        let totalTokens = 0;

        // Sort entries by insertion_order (higher = later in prompt = more impact)
        const sortedEntries = [...allEntries].sort((a, b) => {
            return (a.insertion_order || 100) - (b.insertion_order || 100);
        });

        for (const entry of sortedEntries) {
            // Skip if we've exceeded token budget
            const entryTokens = approxTokensFromChars(entry.content);
            if (totalTokens + entryTokens > tokenBudget) {
                logger.debug(`[WorldInfo] Token budget exceeded, skipping entry: ${entry.title}`);
                continue;
            }

            let shouldActivate = false;
            let matchedKey = null;

            // Handle different strategies
            switch (entry.strategy) {
                case 'constant':
                    // Always activate constant entries
                    shouldActivate = true;
                    matchedKey = '(constant)';
                    break;

                case 'disabled':
                    // Never activate disabled entries
                    shouldActivate = false;
                    break;

                case 'keyword':
                default:
                    // Check if any key matches
                    const keys = entry.keys || [];
                    for (const key of keys) {
                        if (keywordMatches(key, textBuffer, caseSensitive)) {
                            shouldActivate = true;
                            matchedKey = key;
                            break;
                        }
                    }
                    break;
            }

            if (shouldActivate) {
                // Apply trigger probability
                const triggerPercent = entry.trigger_percent ?? 100;
                if (triggerPercent < 100) {
                    const roll = Math.random() * 100;
                    if (roll > triggerPercent) {
                        logger.debug(`[WorldInfo] Entry "${entry.title}" failed trigger roll (${roll.toFixed(1)} > ${triggerPercent})`);
                        continue;
                    }
                }

                // Entry is activated!
                activatedEntries.push(entry);
                matchedKeywords.push({ title: entry.title, key: matchedKey });
                totalTokens += entryTokens;

                logger.info(`[WorldInfo] Activated: "${entry.title}" via key "${matchedKey}" (~${entryTokens} tokens)`);
            }
        }

        logger.info(`[WorldInfo] Activated ${activatedEntries.length} entries using ~${totalTokens} tokens`);

        return {
            activatedEntries,
            totalTokens,
            matched: matchedKeywords
        };

    } catch (err) {
        logger.error('[WorldInfo] Error getting activated entries:', err);
        return { activatedEntries: [], totalTokens: 0, matched: [], error: err.message };
    }
}

/**
 * Format activated entries into a string for prompt injection
 * @param {Array} entries - Array of activated entry objects
 * @param {Object} options - Formatting options
 * @returns {string} - Formatted string ready for injection
 */
function formatEntriesForPrompt(entries, options = {}) {
    if (!entries || entries.length === 0) return '';

    const {
        separator = '\n',
        wrapWithBrackets = true
    } = options;

    const contents = entries.map(entry => entry.content).filter(Boolean);
    
    if (contents.length === 0) return '';

    let result = contents.join(separator);
    
    if (wrapWithBrackets) {
        result = `[World Info]\n${result}`;
    }

    return result;
}

export default {
    getActivatedEntries,
    formatEntriesForPrompt,
    buildScanBuffer,
    keywordMatches,
    approxTokensFromChars
};
