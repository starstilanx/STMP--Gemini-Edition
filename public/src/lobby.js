// Lobby/Rooms functionality for STMP

import { socket, myUUID, myUsername, myUserColor } from '../script.js';

// State
export let currentRoomId = null;
export let currentRoom = null;
export let currentRoomMembers = [];
let roomsList = [];

// DOM Elements
const lobbyOverlay = document.getElementById('lobbyOverlay');
const lobbyRoomList = document.getElementById('lobbyRoomList');
const createRoomBtn = document.getElementById('createRoomBtn');
const createRoomDialog = document.getElementById('createRoomDialog');
const newRoomName = document.getElementById('newRoomName');
const newRoomDescription = document.getElementById('newRoomDescription');
const cancelCreateRoom = document.getElementById('cancelCreateRoom');
const confirmCreateRoom = document.getElementById('confirmCreateRoom');
const currentRoomHeader = document.getElementById('currentRoomHeader');
const currentRoomNameEl = document.getElementById('currentRoomName');
const currentRoomMemberCount = document.getElementById('currentRoomMemberCount');
const roomMembersList = document.getElementById('roomMembersList');
const roomSettingsBtn = document.getElementById('roomSettingsBtn');
const leaveRoomBtn = document.getElementById('leaveRoomBtn');

// Room Settings Dialog Elements
const roomSettingsDialog = document.getElementById('roomSettingsDialog');
const roomSettingsName = document.getElementById('roomSettingsName');
const roomSettingsDescription = document.getElementById('roomSettingsDescription');
const roomCharacterSelect = document.getElementById('roomCharacterSelect');
const cancelRoomSettings = document.getElementById('cancelRoomSettings');
const saveRoomSettings = document.getElementById('saveRoomSettings');
const deleteRoomBtn = document.getElementById('deleteRoomBtn');

// Initialize lobby event listeners
export function initLobby() {
    if (!lobbyOverlay) {
        console.warn('[Lobby] Lobby elements not found in DOM');
        return;
    }
    
    // Create room button
    createRoomBtn?.addEventListener('click', () => {
        showCreateRoomDialog();
    });
    
    // Cancel create room
    cancelCreateRoom?.addEventListener('click', () => {
        hideCreateRoomDialog();
    });
    
    // Confirm create room
    confirmCreateRoom?.addEventListener('click', () => {
        const name = newRoomName.value.trim();
        const description = newRoomDescription.value.trim();
        
        if (!name) {
            newRoomName.focus();
            return;
        }
        
        createRoom(name, description);
        hideCreateRoomDialog();
    });
    
    // Leave room button
    leaveRoomBtn?.addEventListener('click', () => {
        leaveRoom();
    });
    
    // Room settings button
    roomSettingsBtn?.addEventListener('click', () => {
        showRoomSettingsDialog();
    });
    
    // Cancel room settings
    cancelRoomSettings?.addEventListener('click', () => {
        hideRoomSettingsDialog();
    });
    
    // Save room settings
    saveRoomSettings?.addEventListener('click', () => {
        saveRoomSettingsHandler();
    });
    
    // Delete room button
    deleteRoomBtn?.addEventListener('click', () => {
        if (confirm('Are you sure you want to delete this room? This will remove all chat history.')) {
            deleteRoom();
        }
    });
    
    // Enter key to create room
    newRoomName?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            confirmCreateRoom?.click();
        }
    });
    
    console.log('[Lobby] Lobby initialized');
}

// Show the lobby overlay
export function showLobby() {
    lobbyOverlay.style.display = 'flex';
    currentRoomHeader.style.display = 'none';
    requestRoomsList();
}

// Hide the lobby overlay
export function hideLobby() {
    lobbyOverlay.style.display = 'none';
}

// Show create room dialog
function showCreateRoomDialog() {
    newRoomName.value = '';
    newRoomDescription.value = '';
    createRoomDialog.style.display = 'flex';
    newRoomName.focus();
}

// Hide create room dialog
function hideCreateRoomDialog() {
    createRoomDialog.style.display = 'none';
}

// Request rooms list from server
export function requestRoomsList() {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'listRooms' }));
    }
}

// Show room settings dialog
function showRoomSettingsDialog() {
    if (!currentRoom || !roomSettingsDialog) return;
    
    // Populate fields with current room data
    roomSettingsName.value = currentRoom.name || '';
    roomSettingsDescription.value = currentRoom.description || '';
    
    // Parse settings if available
    const settings = typeof currentRoom.settings === 'string' 
        ? JSON.parse(currentRoom.settings || '{}') 
        : (currentRoom.settings || {});
    
    // Populate character selector
    populateCharacterSelect(settings.selectedCharacter || '');
    
    roomSettingsDialog.style.display = 'flex';
}

// Hide room settings dialog
function hideRoomSettingsDialog() {
    if (roomSettingsDialog) {
        roomSettingsDialog.style.display = 'none';
    }
}

// Populate character select dropdown
function populateCharacterSelect(selectedValue = '') {
    if (!roomCharacterSelect) return;
    
    // Get cards from the main cardList selector if available
    const mainCardList = document.getElementById('cardList');
    if (mainCardList) {
        // Copy options from main card list
        roomCharacterSelect.innerHTML = '<option value="">Use server default</option>';
        Array.from(mainCardList.options).forEach(opt => {
            if (opt.value) {
                const option = document.createElement('option');
                option.value = opt.value;
                option.textContent = opt.textContent;
                if (opt.value === selectedValue) {
                    option.selected = true;
                }
                roomCharacterSelect.appendChild(option);
            }
        });
    }
}

// Save room settings
function saveRoomSettingsHandler() {
    if (!currentRoomId) return;
    
    const name = roomSettingsName.value.trim();
    if (!name) {
        roomSettingsName.focus();
        return;
    }
    
    const description = roomSettingsDescription.value.trim();
    const selectedCharacter = roomCharacterSelect?.value || '';
    
    // Build settings object
    const settings = {
        selectedCharacter: selectedCharacter
    };
    
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'roomSettingsUpdate',
            name: name,
            description: description,
            settings: settings
        }));
    }
    
    hideRoomSettingsDialog();
}

// Delete current room
function deleteRoom() {
    if (!currentRoomId) return;
    
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'deleteRoom',
            roomId: currentRoomId
        }));
    }
    
    hideRoomSettingsDialog();
}

// Create a new room
export function createRoom(name, description = '') {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'createRoom',
            name: name,
            description: description
        }));
    }
}

// Join a room
export function joinRoom(roomId) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'joinRoom',
            roomId: roomId
        }));
    }
}

// Leave current room
export function leaveRoom() {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'leaveRoom' }));
    }
}

// Render rooms list
export function renderRoomsList(rooms) {
    roomsList = rooms;
    
    if (!lobbyRoomList) return;
    
    if (!rooms || rooms.length === 0) {
        lobbyRoomList.innerHTML = `
            <div class="lobbyEmptyState">
                <div class="emptyIcon">🏠</div>
                <div>No rooms yet</div>
                <small class="mutedColor">Create the first room to get started!</small>
            </div>
        `;
        return;
    }
    
    lobbyRoomList.innerHTML = rooms.map(room => `
        <div class="roomCard" data-room-id="${room.room_id}">
            <div class="roomCardHeader">
                <span class="roomName">${escapeHtml(room.name)}</span>
                <span class="roomMemberCount">👥 ${room.member_count || 0}</span>
            </div>
            ${room.description ? `<div class="roomDescription">${escapeHtml(room.description)}</div>` : ''}
            ${room.member_names ? `<div class="roomMembers">In room: ${escapeHtml(room.member_names)}</div>` : ''}
        </div>
    `).join('');
    
    // Add click listeners to room cards
    lobbyRoomList.querySelectorAll('.roomCard').forEach(card => {
        card.addEventListener('click', () => {
            const roomId = card.dataset.roomId;
            joinRoom(roomId);
        });
    });
}

// Handle room joined
export function handleRoomJoined(data) {
    currentRoomId = data.room.room_id;
    currentRoom = data.room;
    
    // Hide lobby, show room header
    hideLobby();
    showRoomHeader(data.room, data.members);
    
    // Update chat display with room's chat history
    if (data.chatHistory) {
        // Clear existing chat and load room chat
        const AIChatEl = document.getElementById('AIChat');
        if (AIChatEl) {
            AIChatEl.innerHTML = '';
            // The chat history will be handled by the normal appendMessages flow
        }
    }
    
    console.log(`[Lobby] Joined room: ${data.room.name}`);
}

// Handle room created
export function handleRoomCreated(data) {
    currentRoomId = data.room.room_id;
    currentRoom = data.room;
    
    // Hide dialogs and lobby
    hideCreateRoomDialog();
    hideLobby();
    showRoomHeader(data.room, []);
    
    console.log(`[Lobby] Created room: ${data.room.name}`);
}

// Handle room left
export function handleRoomLeft(data) {
    currentRoomId = null;
    currentRoom = null;
    
    // Show lobby again
    showLobby();
    
    console.log('[Lobby] Left room');
}

// Handle room deleted
export function handleRoomDeleted(data) {
    if (currentRoomId === data.roomId) {
        currentRoomId = null;
        currentRoom = null;
        showLobby();
        console.log('[Lobby] Current room was deleted');
    }
}

// Show room header
function showRoomHeader(room, members) {
    if (!currentRoomHeader) return;
    
    currentRoomNameEl.textContent = `🏠 ${room.name}`;
    currentRoomHeader.style.display = 'flex';
    
    currentRoomMembers = members || [];
    updateMemberCount();
    renderRoomMembers();
}

// Update member count display
function updateMemberCount() {
    if (currentRoomMemberCount) {
        currentRoomMemberCount.textContent = `(${currentRoomMembers.length} members)`;
    }
}

// Render room members list
function renderRoomMembers() {
    if (!roomMembersList) return;
    
    roomMembersList.innerHTML = currentRoomMembers.map(member => `
        <div class="roomMemberAvatar" title="${escapeHtml(member.username)}">
            <div class="userAvatarSmall" style="background-color: ${member.username_color || '#ccc'}">
                ${(member.username || '?').charAt(0).toUpperCase()}
            </div>
        </div>
    `).join('');
}

// Handle member joined room
export function handleMemberJoined(data) {
    console.log(`[Lobby] ${data.user.username} joined the room`);
    
    // Check if already in list to avoid duplicates
    if (!currentRoomMembers.find(m => m.user_id === data.user.user_id)) {
        currentRoomMembers.push(data.user);
        updateMemberCount();
        renderRoomMembers();
    }
}

// Handle member left room
export function handleMemberLeft(data) {
    console.log(`[Lobby] ${data.user.username} left the room`);
    
    currentRoomMembers = currentRoomMembers.filter(m => m.user_id !== data.user.user_id);
    updateMemberCount();
    renderRoomMembers();
}

// Handle room settings changed
export function handleRoomSettingsChanged(data) {
    if (currentRoomId === data.room.room_id) {
        currentRoom = data.room;
        showRoomHeader(data.room, []);
    }
}

// Handle room chat update (new message in room)
export function handleRoomChatUpdate(data) {
    // This will be integrated with the existing appendMessages flow
    console.log('[Lobby] Room chat update received');
}

// Handle room error
export function handleRoomError(data) {
    console.error('[Lobby] Room error:', data.error);
    // Could show a toast notification
}

// Utility: escape HTML
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Check if user is currently in a room
export function isInRoom() {
    return currentRoomId !== null;
}

// Get current room ID
export function getCurrentRoomId() {
    return currentRoomId;
}

// Export for use in other modules
export default {
    initLobby,
    showLobby,
    hideLobby,
    requestRoomsList,
    createRoom,
    joinRoom,
    leaveRoom,
    renderRoomsList,
    handleRoomJoined,
    handleRoomCreated,
    handleRoomLeft,
    handleRoomDeleted,
    handleMemberJoined,
    handleMemberLeft,
    handleRoomSettingsChanged,
    handleRoomChatUpdate,
    handleRoomError,
    isInRoom,
    getCurrentRoomId,
    currentRoom
};
