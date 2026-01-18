/**
 * Lorebook / World Info Client UI Handler
 * 
 * Handles client-side lorebook management including:
 * - WebSocket message handling for CRUD operations
 * - UI population and event binding
 * - Entry editor modal
 */

// Get socket reference from window (set by script.js) to avoid circular import
function getSocket() {
    return window._stmpSocket || null;
}

// State
let lorebooks = [];
let selectedLorebookId = null;
let entries = [];


/**
 * Initialize lorebook UI handlers
 */
export function initLorebookUI() {
    // Toggle panel visibility
    $('#worldInfoToggle').on('click', function() {
        $('#worldInfoBlock').slideToggle(250);
        $(this).find('i').toggleClass('fa-toggle-on fa-toggle-off');
    });

    // Load lorebooks when panel opens
    $('#worldInfoToggle').on('click', function() {
        if ($('#worldInfoBlock').is(':visible') || !$('#worldInfoBlock').is(':animated')) {
            requestLorebooks();
        }
    });

    // Lorebook selection change
    $('#lorebookList').on('change', function() {
        const lorebookId = $(this).val();
        if (lorebookId) {
            selectedLorebookId = lorebookId;
            $('#lorebookSettingsBlock').show();
            $('#lorebookEntriesBlock').show();
            requestLorebookEntries(lorebookId);
            updateSettingsFromLorebook(lorebookId);
        } else {
            selectedLorebookId = null;
            $('#lorebookSettingsBlock').hide();
            $('#lorebookEntriesBlock').hide();
            $('#lorebookEntryList').empty();
        }
    });

    // Create new lorebook
    $('#newLorebookBtn').on('click', function() {
        const name = prompt('Enter lorebook name:', 'New Lorebook');
        if (name && name.trim()) {
            createLorebook(name.trim());
        }
    });

    // Delete selected lorebook
    $('#deleteLorebookBtn').on('click', function() {
        if (!selectedLorebookId) {
            alert('Please select a lorebook first.');
            return;
        }
        if (confirm('Delete this lorebook and all its entries? This cannot be undone.')) {
            deleteLorebook(selectedLorebookId);
        }
    });

    // Create new entry
    $('#newEntryBtn').on('click', function() {
        if (!selectedLorebookId) {
            alert('Please select a lorebook first.');
            return;
        }
        openEntryEditor(null); // null = new entry
    });

    // Settings changes
    $('#lorebookScanDepth, #lorebookTokenBudget').on('change', function() {
        if (selectedLorebookId) {
            updateLorebook(selectedLorebookId, {
                scan_depth: parseInt($('#lorebookScanDepth').val()) || 5,
                token_budget: parseInt($('#lorebookTokenBudget').val()) || 500
            });
        }
    });

    console.log('[Lorebook] UI initialized');
}

/**
 * Handle incoming WebSocket messages for lorebook operations
 */
export function handleLorebookMessage(parsedMessage) {
    switch (parsedMessage.type) {
        case 'lorebooksResponse':
            lorebooks = parsedMessage.lorebooks || [];
            populateLorebookDropdown();
            break;

        case 'lorebookCreated':
            lorebooks.push(parsedMessage.lorebook);
            populateLorebookDropdown();
            $('#lorebookList').val(parsedMessage.lorebook.lorebook_id).trigger('change');
            break;

        case 'lorebookUpdated':
            const idx = lorebooks.findIndex(l => l.lorebook_id === parsedMessage.lorebook.lorebook_id);
            if (idx !== -1) lorebooks[idx] = parsedMessage.lorebook;
            populateLorebookDropdown();
            break;

        case 'lorebookDeleted':
            lorebooks = lorebooks.filter(l => l.lorebook_id !== parsedMessage.lorebookId);
            populateLorebookDropdown();
            if (selectedLorebookId === parsedMessage.lorebookId) {
                selectedLorebookId = null;
                $('#lorebookSettingsBlock').hide();
                $('#lorebookEntriesBlock').hide();
                $('#lorebookEntryList').empty();
            }
            break;

        case 'lorebookEntriesResponse':
            entries = parsedMessage.entries || [];
            populateEntryList();
            break;

        case 'lorebookEntryCreated':
            entries.push(parsedMessage.entry);
            populateEntryList();
            break;

        case 'lorebookEntryUpdated':
            const entryIdx = entries.findIndex(e => e.entry_id === parsedMessage.entry.entry_id);
            if (entryIdx !== -1) entries[entryIdx] = parsedMessage.entry;
            populateEntryList();
            break;

        case 'lorebookEntryDeleted':
            entries = entries.filter(e => e.entry_id !== parsedMessage.entryId);
            populateEntryList();
            break;
    }
}

// WebSocket request functions
function requestLorebooks() {
    const socket = getSocket();
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'getLorebooksRequest' }));
    }
}

function requestLorebookEntries(lorebookId) {
    const socket = getSocket();
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'getLorebookEntriesRequest', lorebookId }));
    }
}

function createLorebook(name, description = '') {
    const socket = getSocket();
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'createLorebook', name, description }));
    }
}

function updateLorebook(lorebookId, updates) {
    const socket = getSocket();
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'updateLorebook', lorebookId, updates }));
    }
}

function deleteLorebook(lorebookId) {
    const socket = getSocket();
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'deleteLorebook', lorebookId }));
    }
}

function createLorebookEntry(lorebookId, entryData) {
    const socket = getSocket();
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'createLorebookEntry', lorebookId, entryData }));
    }
}

function updateLorebookEntry(entryId, updates) {
    const socket = getSocket();
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'updateLorebookEntry', entryId, updates }));
    }
}

function deleteLorebookEntry(entryId) {
    const socket = getSocket();
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'deleteLorebookEntry', entryId }));
    }
}


// UI population functions
function populateLorebookDropdown() {
    const $select = $('#lorebookList');
    const currentVal = $select.val();
    $select.empty().append('<option value="">Select Lorebook...</option>');
    
    lorebooks.forEach(lb => {
        const enabledIcon = lb.enabled ? '🟢' : '🔴';
        $select.append(`<option value="${lb.lorebook_id}">${enabledIcon} ${lb.name}</option>`);
    });

    // Restore selection if still valid
    if (currentVal && lorebooks.some(l => l.lorebook_id === currentVal)) {
        $select.val(currentVal);
    }
}

function updateSettingsFromLorebook(lorebookId) {
    const lb = lorebooks.find(l => l.lorebook_id === lorebookId);
    if (lb) {
        $('#lorebookScanDepth').val(lb.scan_depth || 5);
        $('#lorebookTokenBudget').val(lb.token_budget || 500);
    }
}

function populateEntryList() {
    const $list = $('#lorebookEntryList');
    $list.empty();

    if (entries.length === 0) {
        $list.append('<div class="mutedColor padding5 alignSelfCenter">No entries yet</div>');
        return;
    }

    entries.forEach(entry => {
        const enabledIcon = entry.enabled ? '🟢' : '🔴';
        const strategyIcon = entry.strategy === 'constant' ? '🔵' : (entry.strategy === 'disabled' ? '⚫' : '🟢');
        const keysList = (entry.keys || []).slice(0, 3).join(', ') + (entry.keys?.length > 3 ? '...' : '');
        
        const $item = $(`
            <div class="lorebookEntryItem flexbox justifySpaceBetween alignItemsCenter padding5 borderRad5 marginBot5 bgBrightUp" data-entry-id="${entry.entry_id}">
                <div class="flexbox flexFlowCol flex1">
                    <span class="fontWeightBold">${strategyIcon} ${entry.title || '(Untitled)'}</span>
                    <small class="mutedColor">${keysList || '(no keys)'}</small>
                </div>
                <div class="flexbox noWrap">
                    <button class="editEntryBtn bgTransparent" title="Edit Entry">✏️</button>
                    <button class="toggleEntryBtn bgTransparent" title="Toggle Enabled">${enabledIcon}</button>
                    <button class="deleteEntryBtn bgTransparent" title="Delete Entry" style="color:red;">🗑️</button>
                </div>
            </div>
        `);

        // Edit button
        $item.find('.editEntryBtn').on('click', function() {
            openEntryEditor(entry);
        });

        // Toggle enabled
        $item.find('.toggleEntryBtn').on('click', function() {
            updateLorebookEntry(entry.entry_id, { enabled: !entry.enabled });
        });

        // Delete button
        $item.find('.deleteEntryBtn').on('click', function() {
            if (confirm(`Delete entry "${entry.title || '(Untitled)'}"?`)) {
                deleteLorebookEntry(entry.entry_id);
            }
        });

        $list.append($item);
    });
}

/**
 * Open entry editor modal (using jQuery UI dialog)
 */
function openEntryEditor(entry) {
    const isNew = !entry;
    const title = isNew ? 'New Entry' : `Edit: ${entry.title || '(Untitled)'}`;

    // Create modal content
    const $content = $(`
        <div class="flexbox flexFlowCol">
            <label class="marginBot5">
                Title/Memo:
                <input type="text" id="entryTitle" class="width100p" value="${entry?.title || ''}" placeholder="Entry title (for your reference)">
            </label>
            <label class="marginBot5">
                Keys (comma-separated):
                <input type="text" id="entryKeys" class="width100p" value="${(entry?.keys || []).join(', ')}" placeholder="dragon, fire, scales">
            </label>
            <label class="marginBot5">
                Content:
                <textarea id="entryContent" class="width100p" rows="5" placeholder="The content to inject when keys are triggered...">${entry?.content || ''}</textarea>
            </label>
            <div class="flexbox justifySpaceAround">
                <label class="flexbox alignItemsCenter">
                    Strategy:
                    <select id="entryStrategy" class="marginLeft5">
                        <option value="keyword" ${entry?.strategy === 'keyword' ? 'selected' : ''}>🟢 Keyword</option>
                        <option value="constant" ${entry?.strategy === 'constant' ? 'selected' : ''}>🔵 Constant</option>
                        <option value="disabled" ${entry?.strategy === 'disabled' ? 'selected' : ''}>⚫ Disabled</option>
                    </select>
                </label>
                <label class="flexbox alignItemsCenter">
                    Order:
                    <input type="number" id="entryOrder" class="width3p5em marginLeft5" value="${entry?.insertion_order || 100}" min="0" max="999">
                </label>
                <label class="flexbox alignItemsCenter">
                    Trigger%:
                    <input type="number" id="entryTrigger" class="width3p5em marginLeft5" value="${entry?.trigger_percent || 100}" min="0" max="100">
                </label>
            </div>
        </div>
    `);

    // Use jQuery UI dialog
    $content.dialog({
        title: title,
        modal: true,
        width: 500,
        buttons: {
            'Save': function() {
                const entryData = {
                    title: $('#entryTitle').val().trim(),
                    keys: $('#entryKeys').val().split(',').map(k => k.trim()).filter(Boolean),
                    content: $('#entryContent').val(),
                    strategy: $('#entryStrategy').val(),
                    insertion_order: parseInt($('#entryOrder').val()) || 100,
                    trigger_percent: parseInt($('#entryTrigger').val()) || 100
                };

                if (isNew) {
                    createLorebookEntry(selectedLorebookId, entryData);
                } else {
                    updateLorebookEntry(entry.entry_id, entryData);
                }
                $(this).dialog('close');
            },
            'Cancel': function() {
                $(this).dialog('close');
            }
        },
        close: function() {
            $(this).dialog('destroy').remove();
        }
    });
}

export default {
    initLorebookUI,
    handleLorebookMessage
};
