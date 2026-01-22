-- PostgreSQL Schema for SillyTavern MultiPlayer
-- Migration from SQLite schema
-- This file creates all tables with proper PostgreSQL types and constraints

-- Enable UUID extension for UUID generation (optional, if needed)
-- CREATE EXTENSION IF NOT EXISTS "uuid-ossp"; (Created manually by superuser)

-- =============================================================================
-- USERS AND ROLES
-- =============================================================================

CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    username TEXT,
    username_color TEXT,
    persona TEXT,
    password_hash TEXT, -- bcrypt hashed password (null for legacy/anonymous users)
    email TEXT, -- Optional email for account recovery
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_roles (
    user_id TEXT PRIMARY KEY,
    role TEXT DEFAULT 'user',
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- =============================================================================
-- ROOMS AND MEMBERS
-- =============================================================================

CREATE TABLE IF NOT EXISTS rooms (
    room_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    created_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    settings TEXT, -- JSON: room-specific config (character, API, etc.)
    is_active BOOLEAN DEFAULT TRUE -- Soft delete flag
);

CREATE TABLE IF NOT EXISTS room_members (
    id SERIAL PRIMARY KEY,
    room_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    role TEXT DEFAULT 'member', -- 'creator', 'moderator', 'member'
    FOREIGN KEY (room_id) REFERENCES rooms(room_id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    UNIQUE(room_id, user_id) -- Prevent duplicate memberships
);

-- =============================================================================
-- CHARACTERS
-- =============================================================================

CREATE TABLE IF NOT EXISTS characters (
    char_id TEXT PRIMARY KEY,
    displayname TEXT,
    display_color TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- CHAT SESSIONS
-- =============================================================================

CREATE TABLE IF NOT EXISTS sessions (
    session_id SERIAL PRIMARY KEY,
    room_id TEXT, -- Room isolation - CRITICAL for sync safety
    started_at TIMESTAMPTZ DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    is_active BOOLEAN DEFAULT TRUE,
    FOREIGN KEY (room_id) REFERENCES rooms(room_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "userSessions" (
    session_id SERIAL PRIMARY KEY,
    room_id TEXT, -- Room isolation - CRITICAL for sync safety
    started_at TIMESTAMPTZ DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    is_active BOOLEAN DEFAULT TRUE,
    FOREIGN KEY (room_id) REFERENCES rooms(room_id) ON DELETE CASCADE
);

-- =============================================================================
-- CHAT MESSAGES
-- =============================================================================

CREATE TABLE IF NOT EXISTS aichats (
    message_id SERIAL PRIMARY KEY,
    session_id INTEGER,
    room_id TEXT, -- Room isolation - CRITICAL for sync safety
    user_id TEXT,
    username TEXT,
    message TEXT,
    entity TEXT,
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE SET NULL,
    FOREIGN KEY (room_id) REFERENCES rooms(room_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS userchats (
    message_id SERIAL PRIMARY KEY,
    session_id INTEGER,
    room_id TEXT, -- Room isolation - CRITICAL for sync safety
    user_id TEXT,
    message TEXT,
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    active BOOLEAN DEFAULT TRUE,
    FOREIGN KEY (session_id) REFERENCES "userSessions"(session_id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE SET NULL,
    FOREIGN KEY (room_id) REFERENCES rooms(room_id) ON DELETE CASCADE
);

-- =============================================================================
-- API CONFIGURATIONS
-- =============================================================================

CREATE TABLE IF NOT EXISTS apis (
    name TEXT PRIMARY KEY,
    endpoint TEXT,
    key TEXT,
    type TEXT,
    claude BOOLEAN DEFAULT FALSE,
    "useTokenizer" BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_used_at TIMESTAMPTZ DEFAULT NOW(),
    "modelList" TEXT,
    "selectedModel" TEXT
);

-- =============================================================================
-- LOREBOOKS (World Info)
-- =============================================================================

CREATE TABLE IF NOT EXISTS lorebooks (
    lorebook_id TEXT PRIMARY KEY,
    name TEXT,
    description TEXT,
    enabled BOOLEAN DEFAULT TRUE,
    scan_depth INTEGER DEFAULT 5,
    token_budget INTEGER DEFAULT 500,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lorebook_entries (
    entry_id TEXT PRIMARY KEY,
    lorebook_id TEXT,
    title TEXT,
    keys TEXT, -- JSON array of trigger keywords
    content TEXT,
    enabled BOOLEAN DEFAULT TRUE,
    strategy TEXT DEFAULT 'keyword', -- 'constant', 'keyword', or 'disabled'
    position TEXT DEFAULT 'afterCharDefs',
    insertion_order INTEGER DEFAULT 100,
    depth INTEGER,
    trigger_percent INTEGER DEFAULT 100,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    FOREIGN KEY (lorebook_id) REFERENCES lorebooks(lorebook_id) ON DELETE CASCADE
);

-- =============================================================================
-- INDEXES FOR PERFORMANCE
-- =============================================================================

-- Room-based queries
CREATE INDEX IF NOT EXISTS idx_aichats_room_session ON aichats(room_id, session_id);
CREATE INDEX IF NOT EXISTS idx_userchats_room_session ON userchats(room_id, session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_room_active ON sessions(room_id, is_active);
CREATE INDEX IF NOT EXISTS idx_userSessions_room_active ON "userSessions"(room_id, is_active);

-- Message ordering
CREATE INDEX IF NOT EXISTS idx_aichats_session_timestamp ON aichats(session_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_userchats_session_timestamp ON userchats(session_id, timestamp);

-- User lookups
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_room_members_user ON room_members(user_id);

-- Lorebook lookups
CREATE INDEX IF NOT EXISTS idx_lorebook_entries_lorebook ON lorebook_entries(lorebook_id);
CREATE INDEX IF NOT EXISTS idx_lorebooks_enabled ON lorebooks(enabled);
CREATE INDEX IF NOT EXISTS idx_lorebook_entries_enabled ON lorebook_entries(enabled);

-- Room lookups
CREATE INDEX IF NOT EXISTS idx_rooms_active ON rooms(is_active);

-- =============================================================================
-- COMMENTS FOR DOCUMENTATION
-- =============================================================================

COMMENT ON TABLE rooms IS 'Chat rooms for message isolation';
COMMENT ON TABLE room_members IS 'Room membership tracking';
COMMENT ON TABLE users IS 'User accounts with authentication';
COMMENT ON TABLE user_roles IS 'User permission roles';
COMMENT ON TABLE characters IS 'AI character definitions';
COMMENT ON TABLE sessions IS 'AI chat sessions';
COMMENT ON TABLE "userSessions" IS 'User-to-user chat sessions';
COMMENT ON TABLE aichats IS 'AI chat message history';
COMMENT ON TABLE userchats IS 'User-to-user chat message history';
COMMENT ON TABLE apis IS 'LLM API configurations';
COMMENT ON TABLE lorebooks IS 'World Info / Context management';
COMMENT ON TABLE lorebook_entries IS 'Individual lorebook entries with trigger keywords';

-- =============================================================================
-- INITIAL DATA (Optional)
-- =============================================================================

-- Create global room if it doesn't exist
INSERT INTO rooms (room_id, name, description, is_active, created_at)
VALUES (
    'global-room-00000000-0000-0000-0000-000000000000',
    'Global Room',
    'Default room for all users (backward compatibility)',
    TRUE,
    NOW()
) ON CONFLICT (room_id) DO NOTHING;
