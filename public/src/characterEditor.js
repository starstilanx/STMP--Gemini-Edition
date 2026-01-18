/**
 * Character Editor Module
 * Provides a dedicated tab UI for viewing and editing SillyTavern character card metadata.
 * Supports full v2 character card spec including alternate greetings.
 */

import util from './utils.js';
import { myUUID } from '../script.js';

// Current character state
let currentCharPath = null;
let currentCharData = null;
let isDirty = false;

/**
 * Initialize the Character Editor UI bindings
 */
function initCharacterEditor() {
    console.debug('[CharacterEditor] Initializing...');

    // Toggle visibility of Character Editor block
    $('#characterEditorToggle').off('click.charEditor').on('click.charEditor', function() {
        const $icon = $(this).find('i');
        util.toggleControlPanelBlocks($icon, 'single');
    });

    // Character selector change
    $('#charEditorSelect').off('change.charEditor').on('change.charEditor', async function() {
        const charPath = $(this).val();
        if (charPath && charPath !== '') {
            await loadCharacterData(charPath);
        } else {
            clearEditorFields();
            $('#charEditorFields').hide();
        }
    });

    // Refresh button - sync card list and reload current character
    $('#charEditorRefresh').off('click.charEditor').on('click.charEditor', async function() {
        syncFromMainCardList();
        if (currentCharPath) {
            await loadCharacterData(currentCharPath);
            setStatus('Reloaded character data', 'good');
        } else {
            setStatus('Character list refreshed', 'good');
        }
    });

    // Save button
    $('#charEditorSave').off('click.charEditor').on('click.charEditor', async function() {
        await saveCharacterData();
    });

    // Revert button
    $('#charEditorRevert').off('click.charEditor').on('click.charEditor', async function() {
        if (currentCharPath && currentCharData) {
            populateFields(currentCharData);
            isDirty = false;
            setStatus('Changes reverted', 'good');
        }
    });

    // Add alternate greeting
    $('#charEditorAddGreeting').off('click.charEditor').on('click.charEditor', function() {
        addGreetingField('');
        isDirty = true;
    });

    // Track changes for dirty state
    $('#charEditorFields').on('input change', 'input, textarea', function() {
        isDirty = true;
        setStatus('Unsaved changes', 'warning');
    });

    // Initial sync from existing cardList (in case it was already populated)
    syncFromMainCardList();

    console.debug('[CharacterEditor] Initialized');
}

/**
 * Sync Character Editor selector from the main #cardList dropdown
 * This pulls options directly from the existing cardList in the DOM
 */
function syncFromMainCardList() {
    const $mainCardList = $('#cardList');
    if ($mainCardList.length === 0) {
        console.debug('[CharacterEditor] Main cardList not found');
        return;
    }
    
    const cardList = [];
    $mainCardList.find('option').each(function() {
        const $opt = $(this);
        cardList.push({ name: $opt.text(), value: $opt.val() });
    });
    
    if (cardList.length > 0) {
        syncCardList(cardList);
        console.debug('[CharacterEditor] Synced', cardList.length, 'cards from main cardList');
    }
}

/**
 * Sync the character editor selector with the main card list
 * @param {Array} cardList - Array of {name, value} card objects
 */
function syncCardList(cardList) {
    const $select = $('#charEditorSelect');
    const currentVal = $select.val();
    
    $select.empty();
    $select.append('<option value="">Select Character...</option>');
    
    if (cardList && cardList.length > 0) {
        cardList.forEach(card => {
            if (card.value && card.value !== 'None') {
                $select.append(`<option value="${card.value}">${card.name}</option>`);
            }
        });
    }
    
    // Restore selection if still valid
    if (currentVal && $select.find(`option[value="${currentVal}"]`).length) {
        $select.val(currentVal);
    }
}

/**
 * Load character data from server
 * @param {string} charPath - Path to the character PNG file
 */
async function loadCharacterData(charPath) {
    if (!charPath) return;
    
    setStatus('Loading...', 'info');
    currentCharPath = charPath;

    try {
        const charData = await requestCharacterData(charPath);
        currentCharData = charData;
        populateFields(charData);
        $('#charEditorFields').show();
        isDirty = false;
        setStatus('Loaded: ' + (charData?.data?.name || charData?.name || 'Unknown'), 'good');
    } catch (err) {
        console.error('[CharacterEditor] Failed to load character:', err);
        setStatus('Failed to load character', 'bad');
        $('#charEditorFields').hide();
    }
}

/**
 * Request character data from server via WebSocket
 * @param {string} charPath - Path to character file
 * @returns {Promise<Object>} - Parsed character data
 */
function requestCharacterData(charPath) {
    return new Promise((resolve, reject) => {
        const socket = window._stmpSocket;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            reject(new Error('WebSocket not connected'));
            return;
        }

        const messageHandler = (event) => {
            try {
                const response = JSON.parse(event.data);
                if (response.type === 'charDefsResponse') {
                    socket.removeEventListener('message', messageHandler);
                    const charData = JSON.parse(response.content);
                    resolve(charData);
                }
            } catch (e) {
                // Ignore non-matching messages
            }
        };

        socket.addEventListener('message', messageHandler);
        
        // Timeout after 10 seconds
        setTimeout(() => {
            socket.removeEventListener('message', messageHandler);
            reject(new Error('Request timeout'));
        }, 10000);

        socket.send(JSON.stringify({
            type: 'displayCharDefs',
            UUID: myUUID,
            value: charPath
        }));
    });
}

/**
 * Populate editor fields with character data
 * @param {Object} charData - Character data object (v1 or v2 format)
 */
function populateFields(charData) {
    // Use v2 data object if available, otherwise fall back to v1 root
    const data = charData?.data || charData || {};
    
    // Core fields
    $('#charEditorName').val(data.name || '');
    $('#charEditorDescription').val(data.description || '');
    $('#charEditorFirstMes').val(data.first_mes || '');
    
    // Extended v2 fields
    $('#charEditorPersonality').val(data.personality || '');
    $('#charEditorScenario').val(data.scenario || '');
    $('#charEditorSystemPrompt').val(data.system_prompt || '');
    $('#charEditorPostHistory').val(data.post_history_instructions || '');
    $('#charEditorCreatorNotes').val(data.creator_notes || '');
    $('#charEditorMesExample').val(data.mes_example || '');
    
    // Alternate greetings
    $('#charEditorGreetingsList').empty();
    const altGreetings = data.alternate_greetings || [];
    altGreetings.forEach((greeting, index) => {
        addGreetingField(greeting, index);
    });
}

/**
 * Add an alternate greeting field to the UI
 * @param {string} text - Greeting text
 * @param {number} index - Optional index for labeling
 */
function addGreetingField(text = '', index = null) {
    const $list = $('#charEditorGreetingsList');
    const count = $list.children().length;
    const label = index !== null ? index + 1 : count + 1;
    
    const $entry = $(`
        <div class="charEditorGreetingEntry flexbox alignItemsStart marginBot5" data-index="${count}">
            <textarea class="flex1 charEditorGreetingText" rows="2" placeholder="Alternate greeting ${label}...">${text}</textarea>
            <button class="charEditorRemoveGreeting bgBrightUp marginLeft5" title="Remove this greeting" style="color:red;">✕</button>
        </div>
    `);
    
    $entry.find('.charEditorRemoveGreeting').on('click', function() {
        $(this).closest('.charEditorGreetingEntry').remove();
        isDirty = true;
        setStatus('Unsaved changes', 'warning');
    });
    
    $list.append($entry);
}

/**
 * Collect all greeting texts from the UI
 * @returns {Array<string>} - Array of greeting strings
 */
function collectGreetings() {
    const greetings = [];
    $('#charEditorGreetingsList .charEditorGreetingText').each(function() {
        const text = $(this).val().trim();
        if (text) {
            greetings.push(text);
        }
    });
    return greetings;
}

/**
 * Save character data to server
 */
async function saveCharacterData() {
    if (!currentCharPath || !currentCharData) {
        setStatus('No character loaded', 'bad');
        return;
    }
    
    setStatus('Saving...', 'info');
    
    // Build updated character data object
    const updatedData = {
        name: $('#charEditorName').val().trim(),
        description: $('#charEditorDescription').val(),
        first_mes: $('#charEditorFirstMes').val(),
        personality: $('#charEditorPersonality').val(),
        scenario: $('#charEditorScenario').val(),
        system_prompt: $('#charEditorSystemPrompt').val(),
        post_history_instructions: $('#charEditorPostHistory').val(),
        creator_notes: $('#charEditorCreatorNotes').val(),
        mes_example: $('#charEditorMesExample').val(),
        alternate_greetings: collectGreetings()
    };
    
    try {
        const socket = window._stmpSocket;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            throw new Error('WebSocket not connected');
        }
        
        socket.send(JSON.stringify({
            type: 'charEditRequest',
            UUID: myUUID,
            char: currentCharPath,
            newCharDefs: updatedData
        }));
        
        // Update local cache
        if (currentCharData.data) {
            Object.assign(currentCharData.data, updatedData);
        } else {
            Object.assign(currentCharData, updatedData);
        }
        
        isDirty = false;
        setStatus('Saved successfully!', 'good');
        await util.flashElement('charEditorSave', 'good');
    } catch (err) {
        console.error('[CharacterEditor] Save failed:', err);
        setStatus('Save failed: ' + err.message, 'bad');
        await util.flashElement('charEditorSave', 'bad');
    }
}

/**
 * Clear all editor fields
 */
function clearEditorFields() {
    $('#charEditorName').val('');
    $('#charEditorDescription').val('');
    $('#charEditorFirstMes').val('');
    $('#charEditorPersonality').val('');
    $('#charEditorScenario').val('');
    $('#charEditorSystemPrompt').val('');
    $('#charEditorPostHistory').val('');
    $('#charEditorCreatorNotes').val('');
    $('#charEditorMesExample').val('');
    $('#charEditorGreetingsList').empty();
    currentCharPath = null;
    currentCharData = null;
    isDirty = false;
    setStatus('');
}

/**
 * Set status message in the editor
 * @param {string} message - Status text
 * @param {string} type - 'good', 'bad', 'warning', or 'info'
 */
function setStatus(message, type = '') {
    const $status = $('#charEditorStatus');
    $status.text(message);
    
    $status.removeClass('goodFlash badFlash');
    if (type === 'good') {
        $status.css('color', '#6AFF9E');
    } else if (type === 'bad') {
        $status.css('color', '#FF8A8A');
    } else if (type === 'warning') {
        $status.css('color', '#FFEC8A');
    } else {
        $status.css('color', '');
    }
}

export default {
    initCharacterEditor,
    syncCardList,
    loadCharacterData
};
