# CLAUDE.MD - SillyTavern MultiPlayer (STMP) AI Assistant Reference

> **Purpose**: This document provides comprehensive technical documentation for AI assistants (particularly Claude Code) working with the SillyTavern MultiPlayer codebase.

**Version**: 1.0.2
**Branch**: experimental-Verinax (Gemini Edition)
**Original Creator**: RossAscends

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Architecture Overview](#architecture-overview)
3. [Database Schema](#database-schema)
4. [WebSocket Protocol Reference](#websocket-protocol-reference)
5. [API Integration System](#api-integration-system)
6. [File Structure & Module Guide](#file-structure--module-guide)
7. [Gemini Edition Features](#gemini-edition-features)
8. [Configuration Files](#configuration-files)
9. [Key Technical Patterns](#key-technical-patterns)
10. [Development Guidelines](#development-guidelines)

---

## Project Overview

### What is STMP?

**SillyTavern MultiPlayer** is a Node.js-based LLM chat interface that enables multiple users to chat together with one or more AI characters simultaneously. It features:

- **Multi-user real-time chat** with shared AI characters
- **Sidebar user-only chat** for off-topic discussion
- **Host-controlled moderation** and AI behavior management
- **Support for multiple LLM APIs** (OpenAI, Claude, Gemini, Horde, local backends)

### Technology Stack

**Backend**:
- Node.js (ES6 modules)
- Express.js for HTTP server
- WebSocket (ws) for real-time communication
- SQLite3 for data persistence
- bcrypt for password hashing

**Frontend**:
- jQuery 3.6.0
- Showdown (markdown parser)
- DOMPurify (HTML sanitization)
- Vanilla JavaScript modules

**Key Dependencies**:
- `jimp` - Image processing
- `png-chunks-extract/encode/text` - PNG metadata manipulation
- `log4js` - Logging framework
- `iconv-lite` - Character encoding

### Key Capabilities

- Multi-user simultaneous chat with AI characters
- Character card import/export (SillyTavern v1 & v2 specs)
- World Info/Lorebook system with keyword triggers
- User personas for personalized roleplay
- Streaming responses from LLM APIs
- Host moderation tools (message editing, deletion, user roles)
- Remote access via Cloudflare tunnels

---

## Architecture Overview

### System Design

```
┌─────────────────────────────────────────────────────────────┐
│                    CLIENT BROWSERS                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                 │
│  │ User 1   │  │ User 2   │  │ Host     │                 │
│  │ (Guest)  │  │ (Guest)  │  │ (Admin)  │                 │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘                 │
│       │             │              │                        │
│       └─────────────┼──────────────┘                        │
│                     │ WebSocket                             │
└─────────────────────┼───────────────────────────────────────┘
                      │
┌─────────────────────┼───────────────────────────────────────┐
│                     ▼                                        │
│              ┌──────────────┐                               │
│              │   server.js  │  (Express + WebSocket)        │
│              └──────┬───────┘                               │
│                     │                                        │
│       ┌─────────────┼─────────────┐                         │
│       │             │             │                         │
│       ▼             ▼             ▼                         │
│  ┌────────┐   ┌─────────┐   ┌──────────┐                  │
│  │ db.js  │   │ api-    │   │ file-io  │                  │
│  │(SQLite)│   │calls.js │   │  .js     │                  │
│  └────────┘   └────┬────┘   └──────────┘                  │
│                     │                                        │
│                     ▼                                        │
│            ┌────────────────┐                               │
│            │  LLM API       │                               │
│            │ (OpenAI,       │                               │
│            │  Claude,       │                               │
│            │  Gemini,       │                               │
│            │  Horde, etc.)  │                               │
│            └────────────────┘                               │
└──────────────────────────────────────────────────────────────┘
```

### Data Flow

**User Message Flow**:
1. Client sends WebSocket message `{ type: 'chatMessage', userInput: "Hello" }`
2. Server validates and sanitizes input
3. Message saved to `aichats` or `userchats` table
4. Server broadcasts message to all connected clients
5. If AutoAI enabled, triggers AI response generation

**AI Response Flow**:
1. Server receives `requestAIResponse` message
2. Builds prompt with character definition, chat history, lorebook entries
3. Calls LLM API (TC, CC, or Horde)
4. Streams response tokens via WebSocket or waits for completion
5. Saves response to database
6. Broadcasts to all clients

---

## Database Schema

All tables use SQLite3 with WAL mode enabled for concurrent reads.

### Core Tables

#### `users`
Stores user account information with authentication support.

| Field | Type | Description |
|-------|------|-------------|
| `user_id` | TEXT PRIMARY KEY | UUID identifier |
| `username` | TEXT | User's display name |
| `username_color` | TEXT | Hex color for username in UI |
| `persona` | TEXT | User's character persona/description |
| `password_hash` | TEXT | bcrypt-hashed password (null for legacy accounts) |
| `email` | TEXT | Optional email for account recovery |
| `created_at` | DATETIME | Account creation timestamp |
| `last_seen_at` | DATETIME | Last activity timestamp |

#### `user_roles`
Role-based access control.

| Field | Type | Description |
|-------|------|-------------|
| `user_id` | TEXT PRIMARY KEY, FOREIGN KEY→users | User identifier |
| `role` | TEXT | 'user', 'mod', or 'host' |

#### `characters`
AI character definitions and metadata.

| Field | Type | Description |
|-------|------|-------------|
| `char_id` | TEXT PRIMARY KEY | Character identifier |
| `displayname` | TEXT | Display name in chat |
| `display_color` | TEXT | Hex color for character messages |
| `created_at` | DATETIME | Creation timestamp |
| `last_seen_at` | DATETIME | Last activity timestamp |

#### `sessions`
AI chat session management.

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | INTEGER PRIMARY KEY | Auto-increment |
| `started_at` | DATETIME | Session start |
| `ended_at` | DATETIME | Session end (null if active) |
| `is_active` | BOOLEAN | Whether session is current |

#### `userSessions`
User chat session tracking (separate from AI chat).

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | INTEGER PRIMARY KEY | Auto-increment |
| `started_at` | DATETIME | Session start |
| `ended_at` | DATETIME | Session end |
| `is_active` | BOOLEAN | Whether session is current |

#### `aichats`
AI conversation history.

| Field | Type | Description |
|-------|------|-------------|
| `message_id` | INTEGER PRIMARY KEY | Auto-increment |
| `session_id` | INTEGER, FOREIGN KEY→sessions | Session reference |
| `user_id` | TEXT, FOREIGN KEY→users | Author ID (can be character ID) |
| `username` | TEXT | Author's display name |
| `message` | TEXT | Message content |
| `entity` | TEXT | 'AI', 'user', or other |
| `timestamp` | DATETIME | Message timestamp |

#### `userchats`
User-to-user chat history (parallel to AI chat).

| Field | Type | Description |
|-------|------|-------------|
| `message_id` | INTEGER PRIMARY KEY | Auto-increment |
| `session_id` | INTEGER, FOREIGN KEY→userSessions | Session reference |
| `user_id` | TEXT, FOREIGN KEY→users | Sender ID |
| `message` | TEXT | Message content |
| `timestamp` | DATETIME | Message timestamp |
| `active` | BOOLEAN | Whether message is active in current session |

#### `apis`
API configuration and credentials.

| Field | Type | Description |
|-------|------|-------------|
| `name` | TEXT PRIMARY KEY | Unique API name |
| `endpoint` | TEXT | API endpoint URL |
| `key` | TEXT | API authentication key |
| `type` | TEXT | 'TC', 'CC', 'horde', or 'Gemini' |
| `claude` | BOOLEAN | Whether this is an Anthropic Claude API |
| `useTokenizer` | BOOLEAN | Whether to use local/remote tokenizer |
| `created_at` | DATETIME | Creation timestamp |
| `last_used_at` | DATETIME | Last usage timestamp |
| `modelList` | TEXT | JSON array of available models |
| `selectedModel` | TEXT | Currently selected model |

#### `lorebooks`
World Info / Context Management.

| Field | Type | Description |
|-------|------|-------------|
| `lorebook_id` | TEXT PRIMARY KEY | UUID |
| `name` | TEXT | Lorebook name |
| `description` | TEXT | Purpose/description |
| `enabled` | BOOLEAN | Whether lorebook is active |
| `scan_depth` | INTEGER | How many messages back to scan for triggers |
| `token_budget` | INTEGER | Maximum tokens to insert |
| `created_at` | DATETIME | Creation timestamp |

#### `lorebook_entries`
Individual entries within lorebooks (triggered context).

| Field | Type | Description |
|-------|------|-------------|
| `entry_id` | TEXT PRIMARY KEY | UUID |
| `lorebook_id` | TEXT, FOREIGN KEY→lorebooks | Lorebook reference |
| `title` | TEXT | Entry title/name |
| `keys` | TEXT | JSON array of trigger keywords |
| `content` | TEXT | Context content to inject |
| `enabled` | BOOLEAN | Whether entry is active |
| `strategy` | TEXT | 'constant', 'keyword', or 'disabled' |
| `position` | TEXT | Where to insert (e.g., 'afterCharDefs') |
| `insertion_order` | INTEGER | Sort priority |
| `depth` | INTEGER | Context window depth for this entry |
| `trigger_percent` | INTEGER | Probability of triggering (0-100) |
| `created_at` | DATETIME | Creation timestamp |

### Key Database Operations

**Database Write Queue**: All write operations are serialized through a queue system to prevent race conditions:
- `queueDatabaseWrite()`: Enqueues operations with transaction support
- `processWriteQueue()`: Processes queue sequentially with BEGIN/COMMIT/ROLLBACK

**Authentication Functions**:
- `registerUser(username, password, email)`: Creates new account with bcrypt-hashed password
- `authenticateUser(username, password)`: Validates credentials
- `checkUsernameAvailable(username)`: Case-insensitive availability check
- `getUserByUsername(username)`: Retrieves user by username

---

## WebSocket Protocol Reference

All WebSocket messages are JSON objects with a required `type` field:

```javascript
{
  type: "messagetype",    // Message type identifier
  UUID: "sender-uuid",    // Sender's UUID
  // ... type-specific fields
}
```

### Message Types by Category

#### Authentication & Identity

**`checkUsername`**
- **Direction**: Client → Server
- **Purpose**: Check if username is available
- **Request**: `{ type: 'checkUsername', username: string }`
- **Response**: `{ type: 'checkUsernameResponse', available: boolean }`

**`registerUser`**
- **Direction**: Client → Server
- **Purpose**: Create new user account
- **Request**: `{ type: 'registerUser', username: string, password: string, email?: string }`
- **Response**: `{ type: 'registerResponse', success: boolean, error?: string, user?: {...} }`

**`loginUser`**
- **Direction**: Client → Server
- **Purpose**: Authenticate existing user
- **Request**: `{ type: 'loginUser', username: string, password: string }`
- **Response**: `{ type: 'loginResponse', success: boolean, error?: string, user?: {...} }`

**`identityUpdate`**
- **Direction**: Client → Server
- **Purpose**: Update user identity in session
- **Request**: `{ type: 'identityUpdate', ... }`
- **Effect**: Updates `clientsObject` with user info, broadcasts user list

**`updatePersona`**
- **Direction**: Client → Server
- **Purpose**: Update user's persona
- **Request**: `{ type: 'updatePersona', persona: string }`
- **Effect**: Updates database, broadcasts new user list

**`usernameChange`**
- **Direction**: Client → Server
- **Purpose**: Change username
- **Request**: `{ type: 'usernameChange', newUsername: string }`
- **Effect**: Updates database, broadcasts to all clients

#### Host Configuration (role === 'host')

**`clientStateChange`**
- **Direction**: Client → Server (Host only)
- **Purpose**: Update entire configuration
- **Request**: `{ type: 'clientStateChange', value: liveConfig }`
- **Effect**: Broadcasts `hostStateChange` to hosts, `guestStateChange` to guests

**`modelSelect`**
- **Direction**: Client → Server
- **Purpose**: Change selected model for current API
- **Request**: `{ type: 'modelSelect', value: string }`
- **Effect**: Broadcasts `modelChangeForGuests`

**`testNewAPI`**
- **Direction**: Client → Server
- **Purpose**: Test API configuration
- **Request**: `{ type: 'testNewAPI', api: {...} }`
- **Response**: `{ type: 'testAPIResult', ... }`

**`modelListRequest`**
- **Direction**: Client → Server
- **Purpose**: Fetch available models from Horde
- **Response**: `{ type: 'modelLoadResponse', models: [...] }`

**`modeChange`**
- **Direction**: Client → Server
- **Purpose**: Switch API mode
- **Request**: `{ type: 'modeChange', value: 'TC' | 'horde' | 'CC' }`
- **Effect**: Broadcasts `modeChange` to all

**`disableGuestInput` / `allowGuestInput`**
- **Direction**: Client → Server
- **Purpose**: Toggle guest messaging ability
- **Effect**: Broadcasts `toggleGuestInputState`

#### Chat Control (role === 'host')

**`requestAIResponse`**
- **Direction**: Client → Server
- **Purpose**: Initiate AI response generation
- **Request**:
  ```javascript
  {
    type: 'requestAIResponse',
    trigger: 'auto' | 'manual' | 'force' | 'regenerate',
    latestUserMessageText?: string,
    character?: {...},
    ...
  }
  ```
- **Response**: Streaming or one-off `chatMessage`

**`AIRetry`**
- **Direction**: Client → Server
- **Purpose**: Regenerate last AI message
- **Effect**: Deletes last message, triggers new response

**`continueFromMessage`**
- **Direction**: Client → Server
- **Purpose**: Continue a previous message from specific point
- **Request**: `{ type: 'continueFromMessage', mesID: number, ... }`

**`deleteLast`**
- **Direction**: Client → Server
- **Purpose**: Delete most recent AI message

**`changeCharacterRequest`**
- **Direction**: Client → Server
- **Purpose**: Change active character(s)
- **Request**: `{ type: 'changeCharacterRequest', character: {...} }`
- **Effect**: Broadcasts `changeCharacter`

#### Chat Management

**`chatMessage`**
- **Direction**: Bidirectional
- **Purpose**: Send or receive chat message
- **Client → Server**: `{ type: 'chatMessage', chatID: 'AIChat' | 'userChat', userInput: string }`
- **Server → Client**: `{ type: 'chatMessage', content: string, username: string, ... }`
- **Effect**: Saves to database, broadcasts to all clients, may trigger AI response

**`messageDelete`**
- **Direction**: Client → Server
- **Purpose**: Delete message from chat
- **Request**: `{ type: 'messageDelete', deleteType: 'AIChat' | 'userChat', mesID: number, sessionID: number }`

**`messageEdit`**
- **Direction**: Client → Server
- **Purpose**: Edit existing message
- **Request**: `{ type: 'messageEdit', mesID: number, newMessage: string, sessionID: number }`

**`messageContentRequest`**
- **Direction**: Client → Server
- **Purpose**: Retrieve full message content
- **Request**: `{ type: 'messageContentRequest', mesID: number, sessionID: number }`
- **Response**: `{ type: 'messageContentResponse', content: string }`

#### Chat History

**`pastChatsRequest`**
- **Direction**: Client → Server
- **Purpose**: Retrieve list of past chat sessions
- **Response**: `{ type: 'pastChatsList', chats: [{session_id, started_at, aiName, messageCount, ...}, ...] }`

**`loadPastChat`**
- **Direction**: Client → Server
- **Purpose**: Load all messages from session
- **Request**: `{ type: 'loadPastChat', sessionID: number }`
- **Response**: `{ type: 'pastChatToLoad', ... }`

**`pastChatDelete`**
- **Direction**: Client → Server
- **Purpose**: Delete entire session
- **Request**: `{ type: 'pastChatDelete', sessionID: number, deleteType: 'AIChat' | 'userChat' }`

#### Lorebook / World Info

**`getLorebooksRequest`**
- **Direction**: Client → Server
- **Response**: `{ type: 'lorebooksResponse', lorebooks: [...] }`

**`createLorebook`**
- **Direction**: Client → Server
- **Request**: `{ type: 'createLorebook', name: string, description?: string }`
- **Response**: `{ type: 'lorebookCreated', lorebook: {...} }`

**`updateLorebook`**
- **Direction**: Client → Server
- **Request**: `{ type: 'updateLorebook', lorebookId: string, ...updates }`
- **Response**: `{ type: 'lorebookUpdated' }`

**`deleteLorebook`**
- **Direction**: Client → Server
- **Request**: `{ type: 'deleteLorebook', lorebookId: string }`
- **Response**: `{ type: 'lorebookDeleted' }`

**`getLorebookEntriesRequest`**
- **Direction**: Client → Server
- **Request**: `{ type: 'getLorebookEntriesRequest', lorebookId: string }`
- **Response**: `{ type: 'lorebookEntriesResponse', entries: [...] }`

**`createLorebookEntry`**
- **Direction**: Client → Server
- **Request**:
  ```javascript
  {
    type: 'createLorebookEntry',
    lorebookId: string,
    title: string,
    keys: string[],
    content: string,
    enabled: boolean,
    strategy: 'keyword' | 'constant' | 'disabled',
    position: string,
    insertion_order: number,
    trigger_percent: number
  }
  ```
- **Response**: `{ type: 'lorebookEntryCreated', entry: {...} }`

**`updateLorebookEntry` / `deleteLorebookEntry`**
- Similar patterns for modifying/removing entries

#### File Operations

**`fileUpload`**
- **Direction**: Client → Server
- **Purpose**: Upload character card or other files
- **Request**: `{ type: 'fileUpload', fileName: string, fileData: Buffer, ... }`
- **Response**: `{ type: 'fileUploadSuccess' | 'fileUploadError', ... }`

**`cardListRequest`**
- **Direction**: Client → Server
- **Purpose**: Retrieve list of available character cards
- **Response**: `{ type: 'cardListResponse', cards: [...] }`

#### Utility

**`heartbeat`**
- **Direction**: Client → Server
- **Purpose**: Keepalive ping
- **Response**: `{ type: 'heartbeatResponse' }`

**`submitKey`**
- **Direction**: Client → Server
- **Purpose**: Submit Horde API key or host key
- **Request**: `{ type: 'submitKey', key: string }`
- **Response**: `{ type: 'keyAccepted' | 'keyRejected' }`

**`hostToastRequest`**
- **Direction**: Client → Server (Host only)
- **Purpose**: Send notification toast to all users
- **Request**: `{ type: 'hostToastRequest', message: string, ... }`
- **Response**: `{ type: 'hostToastResponse' }`

### Broadcast Function

```javascript
async function broadcast(message, role = 'all') {
  // Sends message to all connected clients
  // If role specified, filters by user.role
  // Checks WebSocket.OPEN state
}
```

### Response Queue State

**Queue State Broadcast**:
```javascript
{
  type: 'responseQueueUpdate',
  active: boolean,
  current: { value: string, displayName: string } | null,
  remaining: [{value, displayName}, ...]
}
```

---

## API Integration System

### Supported API Types

#### Text Completion (TC)
Traditional text-completion endpoints (KoboldCPP, Ollama, TabbyAPI, etc.)

**Request Format**:
```javascript
{
  prompt: string,
  max_tokens: number,
  temperature: number,
  top_p: number,
  top_k: number,
  stop: string[],
  // ... other sampler parameters
}
```

**Streaming**: Supported via SSE or chunked responses

#### Chat Completion (CC)
Chat-based APIs (OpenAI, Claude, Gemini, etc.)

**Request Format**:
```javascript
{
  messages: [
    { role: 'system' | 'user' | 'assistant', content: string },
    ...
  ],
  max_tokens: number,
  temperature: number,
  stream: boolean,
  stop: string[] | stop_sequences: string[],
  // ... other parameters
}
```

**API-Specific Variants**:
- **OpenAI**: `max_output_tokens`, `stop`
- **Claude**: `max_tokens_to_sample`, `stop_sequences`
- **Gemini**: Standard CC format with Gemini-specific endpoint detection

#### Horde (KoboldAI Horde)
Distributed GPU inference service

**Request Format**:
```javascript
{
  models: [string],
  prompt: string,
  params: {
    max_context_length: number,
    max_length: number,
    temperature: number,
    // ... sampler settings
  },
  trusted_workers: boolean
}
```

**Async Polling**:
1. Submit job → receive `task_id`
2. Poll `/api/v2/generate/text/status/{task_id}` every 5 seconds
3. Max 240 retries (20 minutes)
4. Extract response from `statusResponse.generations[0].text`

**Endpoint**: `https://aihorde.net/api/v2/generate/text/async`

### Core API Functions

#### `getAIResponse()`
Main function orchestrating AI responses.

**Parameters**:
```javascript
async function getAIResponse(
  isStreaming,       // boolean: stream response or wait for full completion
  hordeKey,          // string: Horde API key
  engineMode,        // 'TC' | 'horde' | 'CC'
  user,              // { uuid, username, color, persona, role }
  liveConfig,        // full configuration object
  liveAPI,           // selected API config
  preInitCallback,   // optional: called before network request
  parsedMessage,     // message metadata
  shouldContinue     // boolean: continue previous response
)
```

**Flow**:
1. Load character card file and parse JSON
2. Build full prompt with character defs, chat history, lorebook entries
3. Load sampler preset (temperature, top_p, etc.)
4. Set stop strings from instruct template
5. Call appropriate backend (Horde, TC, or CC)
6. Post-process response (trim incomplete sentences, normalize whitespace)

#### `addCharDefsToPrompt()`
Constructs full prompt context.

**Components**:
1. **Character Definition** (from PNG card):
   - Name, description, personality
   - Example dialogue
   - System prompt

2. **Chat History** (trimmed to context budget):
   - Scanned backwards from most recent
   - Filtered by token budget
   - For CC: formatted as `[{role: 'user'|'assistant', content: ...}, ...]`
   - For TC: formatted with instruct sequences

3. **Lorebook Injection**:
   - Scans enabled lorebooks
   - Matches entry triggers against recent messages
   - Injects content at specified position
   - Respects token budget per lorebook

4. **System Message**:
   - Supports macro replacement: `{{user}}`, `{{char}}`

5. **User Persona**:
   - Injected for personalization

#### `setStopStrings()`
Generates stop sequences from instruct template.

**Template Fields**:
- `input_sequence`: Character name prefix (e.g., "User:")
- `output_sequence`: AI name prefix (e.g., "Assistant:")
- `system_sequence`: System message marker
- `end_sequence`: Message separator
- `extras_for_stops`: Additional stop patterns

**Generated Stops**:
- All template sequences
- Dynamic: `\n{username}:` for each entity
- API-specific parameter naming (Claude: `stop_sequences`, TC: `stop`)

### Streaming Implementation

**Server-Side** (`src/stream.js`):
- `createTextListener()`: EventEmitter for streaming tokens
- `autoMendMarkdown(text)`: Auto-balances unclosed markdown delimiters
- `responseLifecycleEmitter`: Signals when responses complete

**Client-Side** (`public/src/streamUpdater.js`):
- `ensureTextNode($el, dataKey)`: Stable text node for token updates
- `setTextNodeValue($el, text)`: Update text without re-rendering
- Throttles updates to 16ms (60 FPS)

### Multi-Character Support

**Character Queue System**:
- `buildResponseQueue()`: Parses user message for character names, builds response order
- Characters respond sequentially
- On completion, `responseLifecycleEmitter.emit('responseComplete')` triggers next

**Queue State**:
```javascript
let responseQueue = [];           // Array of { value, displayName }
let queueActive = false;          // Processing in progress
let currentResponder = null;      // Character currently generating
```

---

## File Structure & Module Guide

### Directory Organization

```
dreamy-poitras/
├── src/                           # Server-side modules (Node.js)
│   ├── api-calls.js              # API request handling
│   ├── character-card-parser.js   # PNG character card parsing
│   ├── db.js                      # SQLite database operations
│   ├── file-io.js                 # File operations
│   ├── localTokenizer.js          # Local token estimation
│   ├── remoteTokenizer.js         # Remote tokenizer API
│   ├── stream.js                  # Streaming response handling
│   ├── lorebook.js                # Lorebook activation engine
│   ├── purify.js                  # HTML sanitization
│   └── log.js                     # Logging configuration
├── public/                        # Client-side code
│   ├── script.js                  # Main client initialization
│   ├── client.html                # Main HTML template
│   ├── src/                       # Client-side modules
│   │   ├── controls.js            # UI control panel
│   │   ├── handleconfig.js        # Configuration state
│   │   ├── streamUpdater.js       # Streaming UI
│   │   ├── utils.js               # Utility functions
│   │   ├── characterEditor.js     # Character editor UI
│   │   ├── lorebook.js            # Lorebook UI
│   │   ├── theme.js               # Theme management
│   │   └── ... (other modules)
│   └── css/                       # Stylesheets
├── characters/                    # Character PNG files
├── chats/                         # Chat history JSON exports
├── api-presets/                   # Sampler presets
├── instructFormats/               # Prompt format templates
├── server.js                      # Main Express server
├── package.json                   # Dependencies
└── CLAUDE.MD                      # This file
```

### Server-Side Modules (`src/`)

#### `api-calls.js` - API Request Handler
**Purpose**: Core API communication and prompt generation

**Key Functions**:
- `getAIResponse()`: Main response generation orchestrator
- `requestToTCorCC()`: Handles TC and CC API requests
- `requestToHorde()`: Async request submission to KoboldAI Horde
- `addCharDefsToPrompt()`: Constructs full prompt context
- `setStopStrings()`: Generates stop sequences from instruct template
- `testAPI()`: Tests API connectivity
- `getHordeModelList()`: Fetches available models from Horde

**Handles**: Tokenization, prompt building, continuation logic, character definitions, lorebook injection

#### `character-card-parser.js` - Card Parsing
**Purpose**: Extract metadata from SillyTavern character PNG files

**Key Functions**:
- `characterCardParser(cardUrl, format, buffer)`: Parse PNG metadata

**Validates**: v1 and v2 character card specifications
**Extracts**: Base64-encoded character data from PNG tEXt chunks
**See also**: [Gemini Edition Features - Character System](#character-editor-system)

#### `db.js` - Database Layer
**Purpose**: SQLite database for persistent data

**Key Functions**:
- `queueDatabaseWrite()`: Enqueues operations with transaction support
- `processWriteQueue()`: Serialized processing
- `registerUser()`: Create account with bcrypt hashing
- `authenticateUser()`: Validate credentials
- `upsertUser()`: Insert or update user
- `getAllEnabledEntries()`: Retrieve active lorebook entries

**Features**: WAL mode, foreign keys, password hashing

#### `file-io.js` - File Operations
**Purpose**: Character card upload validation and file management

**Key Functions**:
- `validateAndAcceptPNGUploads()`: Validates PNG character cards
- `charaRead()`: Read character metadata from PNG
- `charaWrite()`: Update character PNG metadata
- `sanitizeFilename()`: Remove unsafe characters
- `getUniqueFilename()`: Generate unique filenames

**Handles**: PNG metadata extraction, file validation, character card imports

#### `localTokenizer.js` - Local Token Estimation
**Purpose**: Lightweight token counting without external API calls

**Key Functions**:
- `approxTokensFromChars(str)`: Basic char-to-token conversion (4.4 chars/token)
- `getTemplateNameFromInstructFile()`: Detects prompt format (ChatML, Llama3, etc.)
- `estimateMessageTokens_CC()`: Estimate message tokens
- `buildRenderedCCPrompt()`: Build full rendered prompt
- `computeCCBudget()`: Calculate available prompt budget

**Template Support**: ChatML, Llama3, Gemma, Mixtral, Alpaca, Command-R

#### `remoteTokenizer.js` - Remote Tokenization
**Purpose**: Query backend tokenizer API for accurate token counts

**Key Functions**:
- `tryRemoteTokenize()`: POST to `<endpoint>/v1/token/encode/`
- `calibrateFactor()`: Calibrate local estimator against remote

**Compatibility**: TabbyAPI, KoboldCPP, Ollama (partial), LM Studio (partial)

#### `stream.js` - Streaming Response Handler
**Purpose**: Handles real-time streaming token output from APIs

**Key Functions**:
- `autoMendMarkdown(text)`: Auto-balances unclosed markdown delimiters
- `createTextListener()`: Emits incremental tokens
- `textEmitter`: EventEmitter for streaming tokens
- `responseLifecycleEmitter`: Signals when responses complete

**Handles**: Incomplete markdown, streaming state management, token accumulation

#### `lorebook.js` - Lorebook Activation Engine
**Purpose**: Scan chat history and activate contextual entries

**Key Functions**:
- `getActivatedEntries(chatHistory, options)`: Find matching entries
- `keywordMatches()`: Regex-based whole-word matching
- `buildScanBuffer()`: Extract text for scanning
- `formatEntriesForPrompt()`: Format entries for injection

**Features**: Token budget tracking, trigger probability, insertion ordering
**See also**: [Gemini Edition Features - Lorebook System](#lorebook-system)

#### `purify.js` - HTML Sanitization
**Purpose**: Markdown to HTML conversion with security

**Features**:
- DOMPurify integration
- Custom tag handling: `<think>`, `<reasoning>` (rendered as literals)
- Blocks: `<style>`, `<script>`, `<iframe>`, `<form>`, etc.
- Markdown parsing via Showdown

#### `log.js` - Logging
**Purpose**: Centralized logging with categories

**Loggers**: `logger`, `dbLogger`, `apiLogger`, `fileLogger`, `charLogger`
**Framework**: log4js

### Client-Side Modules (`public/src/`)

#### `controls.js` - Control Panel UI
**Purpose**: API configuration, model selection, key management

**Key Functions**:
- `updateSelectedModel()`: Update model selector
- `submitKey()`: Send API key
- `showAddNewAPIDiv()` / `hideAddNewAPIDiv()`: API form visibility
- `testNewAPI()`: Validate API credentials

#### `handleconfig.js` - Configuration State
**Purpose**: Master configuration object synchronization

**Structure** (`liveConfig`):
```javascript
{
  promptConfig: {
    // Character selection, presets, instruction format, response settings
  },
  APIConfig: {
    // Active API endpoint, key, type, model
  },
  crowdControl: {
    // Chat delays, image permissions, guest restrictions
  }
}
```

#### `streamUpdater.js` - Stream Rendering
**Purpose**: Real-time rendering of streamed responses

**Key Functions**:
- `ensureTextNode()`: Stable text node for token updates
- `setTextNodeValue()`: Update text without re-rendering
- `splitInlineAndBlocks()`: Split HTML into inline/block sections
- `markContextBoundary()`: Highlight context cutoff

**Performance**: Throttles updates to 16ms (60 FPS)

#### `utils.js` - Utility Functions
**Purpose**: DOM, storage, and messaging helpers

**Key Functions**:
- `delay()`, `debounce()`, `throttle()`: Timing utilities
- `saveLocalStorage()` / `getLocalStorage()`: Browser storage
- `isValidURL()`: URL validation
- `flashElement()`: Flash highlighting
- `messageServer()`: WebSocket send wrapper

#### `characterEditor.js` - Character Editor
**Purpose**: View and edit character card metadata

**Supports**: v2 fields (name, description, first message, personality, scenario, system prompt, etc.), alternate greetings

**See also**: [Gemini Edition Features - Character Editor System](#character-editor-system)

#### `lorebook.js` - Lorebook UI
**Purpose**: Manage World Info entries and lorebooks

**Features**: Create entries, set keywords, enable/disable, assign scan depth

**See also**: [Gemini Edition Features - Lorebook System](#lorebook-system)

#### Other Client Modules
- `theme.js`: Dark/Light theme management
- `hotkeys.js`: Keyboard shortcuts
- `hostToast.js`: Toast notifications
- `allowImages.js`: Image filtering
- `disableGuestInput.js`: Guest restrictions
- `muteCharButtons.js`: Mute character responses
- `keepAliveAudio.js`: Silent audio to prevent browser idle

---

## Gemini Edition Features

This section documents features specific to the Gemini Edition fork (dreamy-poitras branch).

### Character Editor System

#### PNG Metadata Parsing (`src/character-card-parser.js`)

**Data Extraction Flow**:
1. Read PNG file using `png-chunks-extract`
2. Search for tEXt chunks with keyword `"chara"`
3. Extract base64-encoded JSON from chunk data
4. Validate base64 format with regex: `/^[A-Za-z0-9+/=\s]+$/`
5. Decode to UTF-8 and parse as JSON

**Dual Format Support (v1 & v2)**:

**v1 Format** (flat structure):
```javascript
{
  "name": "character_name",        // Required, non-empty string
  "description": "desc",           // Optional string
  "first_mes": "opening message",  // Optional string
  "personality": "",
  "scenario": "",
  "mes_example": ""
}
```

**v2 Format** (nested structure - SillyTavern compatible):
```javascript
{
  "spec": "chara_card_v2",         // Required exact value
  "spec_version": "2.0",           // Required exact value
  "data": {
    "name": "character_name",
    "description": "desc",
    "first_mes": "opening message",
    "personality": "",
    "scenario": "",
    "system_prompt": "",           // v2 extension
    "post_history_instructions": "", // v2 extension
    "creator_notes": "",
    "mes_example": "",
    "alternate_greetings": [],     // Array of alternate opening messages
    "character_book": {            // Embedded lorebook
      "entries": [...]
    },
    "extensions": {
      "talkativeness": 0.5,
      "depth_prompt": {
        "prompt": "",
        "depth": 4,
        "role": "system"
      }
    }
  }
}
```

**Validation Mechanism**:
- Parser checks v1 compliance: name must exist and be non-empty string
- Parser checks v2 compliance: spec and spec_version must exist, data must be object with valid name
- Card accepted if it passes EITHER v1 OR v2 validation

#### Character Editor UI (`public/src/characterEditor.js`)

**State Management**:
```javascript
let currentCharPath = null;      // Path to currently loaded character PNG
let currentCharData = null;      // Parsed character object (v1 or v2)
let isDirty = false;             // Tracks unsaved changes
```

**Loading Flow**:
1. User selects character from dropdown
2. Client sends WebSocket: `{ type: 'displayCharDefs', value: charPath }`
3. Server reads PNG and returns: `{ type: 'charDefsResponse', content: jsonString }`
4. Client parses and populates form fields

**Editable Fields**:
- Core: `name`, `description`, `first_mes`
- Extended v2: `personality`, `scenario`, `system_prompt`, `post_history_instructions`, `creator_notes`, `mes_example`
- Collections: `alternate_greetings` (dynamic list - can add/remove)

**Saving Flow**:
1. Collect all form values into `updatedData` object
2. Send WebSocket: `{ type: 'charEditRequest', char: charPath, newCharDefs: updatedData }`
3. Server processes via `charaWrite()` function
4. Updates local cache optimistically
5. Dirty flag reset when save completes

**Alternate Greetings Implementation**:
- Stored as array in `data.alternate_greetings`
- UI renders dynamic textarea fields with remove buttons
- Supports unlimited alternate greetings

#### File I/O Processing (`src/file-io.js`)

**charaWrite() Function**:
1. Acquires file lock to prevent concurrent writes
2. Reads existing PNG buffer and extracts chunks
3. Parses existing embedded data
4. Updates specific fields only (v1 fields at root, v2 fields in `.data`)
5. Handles `alternate_greetings` array specially
6. Encodes updated data:
   - Serializes to JSON string
   - Converts to UTF-8 buffer
   - Encodes as base64
   - Creates new tEXt chunk with keyword "chara"
7. Re-encodes PNG with modified chunks
8. Writes back to disk with file lock

**Character Upload Validation**:
- MIME type: Only `image/png` allowed
- File size: Max 1MB
- Metadata: Must pass character card parser validation
- Filename: Sanitized to alphanumeric + underscore + hyphen + dot
- Duplicate handling: Appends `_1`, `_2`, etc.

### Lorebook System

#### Database Schema

**Lorebooks Table**:
```javascript
{
  lorebook_id: "TEXT UNIQUE PRIMARY KEY",  // UUID v4
  name: "TEXT",
  description: "TEXT",
  enabled: "BOOLEAN DEFAULT TRUE",
  scan_depth: "INTEGER DEFAULT 5",        // How many recent messages to scan
  token_budget: "INTEGER DEFAULT 500",    // Max tokens to inject
  created_at: "DATETIME DEFAULT CURRENT_TIMESTAMP"
}
```

**Lorebook Entries Table**:
```javascript
{
  entry_id: "TEXT UNIQUE PRIMARY KEY",    // UUID v4
  lorebook_id: "TEXT",                    // Foreign key
  title: "TEXT",                          // User-friendly name
  keys: "TEXT",                           // JSON array of trigger keywords
  content: "TEXT",                        // Content to inject
  enabled: "BOOLEAN DEFAULT TRUE",
  strategy: "TEXT DEFAULT 'keyword'",     // 'keyword', 'constant', or 'disabled'
  position: "TEXT DEFAULT 'afterCharDefs'",
  insertion_order: "INTEGER DEFAULT 100", // Higher = later in prompt
  depth: "INTEGER",
  trigger_percent: "INTEGER DEFAULT 100", // Probability 0-100
  created_at: "DATETIME DEFAULT CURRENT_TIMESTAMP"
}
```

#### Server-Side Activation Engine (`src/lorebook.js`)

**Core Function: `getActivatedEntries(chatHistory, options)`**

**Algorithm**:
1. Retrieve all enabled entries from enabled lorebooks
2. Build scan buffer from recent chat messages (last N messages concatenated)
3. Sort entries by `insertion_order` (ascending)
4. For each entry, determine activation via strategy:
   - **"constant"**: Always activated
   - **"disabled"**: Never activated
   - **"keyword"**: Checks if any key matches in text buffer
5. **Keyword matching** uses whole-word regex:
   ```javascript
   const regex = new RegExp(`\\b${escapedKeyword}\\b`, flags);
   ```
6. Apply trigger probability (0-100%)
7. Token budgeting (approximate: 4 chars = 1 token)
8. Return activated entries + token count + matched keywords

**Configuration Options**:
```javascript
{
  scanDepth: 5,                   // Default: scan last 5 messages
  tokenBudget: 500,               // Default: 500 tokens max
  caseSensitive: false,           // Default: case-insensitive
  includeNames: true              // Default: include usernames in scan
}
```

**Output Format**:
```javascript
{
  activatedEntries: [entry1, entry2, ...],
  totalTokens: 145,
  matched: [
    { title: "Entry Title", key: "matched_keyword" },
    ...
  ]
}
```

#### Client-Side UI Handler (`public/src/lorebook.js`)

**WebSocket Message Types**:
- `getLorebooksRequest` / `lorebooksResponse`
- `createLorebook` / `lorebookCreated`
- `updateLorebook` / `lorebookUpdated`
- `deleteLorebook` / `lorebookDeleted`
- `getLorebookEntriesRequest` / `lorebookEntriesResponse`
- `createLorebookEntry` / `lorebookEntryCreated`
- `updateLorebookEntry` / `lorebookEntryUpdated`
- `deleteLorebookEntry` / `lorebookEntryDeleted`

**Entry Editor Modal**:
```javascript
{
  title: "string",              // User memo/reference name
  keys: ["keyword1", "keyword2"], // Trigger keywords
  content: "string",            // Content to inject
  strategy: "keyword|constant|disabled",
  insertion_order: 0-999,       // Processing order
  trigger_percent: 0-100        // Activation probability
}
```

**UI State Management**:
```javascript
let lorebooks = [];              // List of all lorebooks
let selectedLorebookId = null;   // Currently selected lorebook
let entries = [];                // Entries for selected lorebook
```

### Persona System

#### Database Storage

**Users Table Field**:
```javascript
{
  user_id: "TEXT UNIQUE PRIMARY KEY",
  username: "TEXT",
  username_color: "TEXT",
  persona: "TEXT",              // Persona description (empty string default)
  password_hash: "TEXT",
  email: "TEXT",
  created_at: "DATETIME DEFAULT CURRENT_TIMESTAMP",
  last_seen_at: "DATETIME DEFAULT CURRENT_TIMESTAMP"
}
```

**Persona Persistence**:
- `upsertUser()` preserves existing persona if not provided in update
- Persona included in chat history responses for prompt building

#### Client-Side Management

**Global State**:
```javascript
export var myPersona = "";        // User persona string
```

**Initialization Flow**:
1. On user connection, server sends personas in `readAIChat()` response
2. Client extracts from chat history: `myPersona = myUserEntry.persona || ""`
3. On authenticated login: `myPersona = user.persona || ''`

**Update Flow**:
1. User edits persona in textarea
2. On input change, send WebSocket: `{ type: 'updatePersona', persona: newPersona }`
3. Server updates database via `upsertUser()`
4. Server updates `clientsObject` cache
5. Persona included in subsequent prompts

#### Integration with Prompt Building

Persona is retrieved for prompt injection via SQL join:
```sql
SELECT
  a.username,
  a.message,
  u.persona AS userPersona,  -- Retrieved here
  ...
FROM aichats a
LEFT JOIN users u ON a.user_id = u.user_id
WHERE a.session_id = ?
```

### Gemini API Support

**Detection**: Endpoint URL includes `'gemini'` or explicit API type selection

**Format**: Standard Chat Completion (CC) format with Gemini-specific endpoint

**Implementation**: Handled by `requestToTCorCC()` with CC message array format

---

## Configuration Files

### `config.json`
**Purpose**: Persistent application configuration
**Location**: Root directory (created at first run)
**Contains**: User-editable settings for behaviors, defaults, and toggles

### `secrets.json`
**Purpose**: Sensitive data storage
**Location**: Root directory (created at first run)
**Contains**: API keys, host passwords, mod keys
**Security**: Listed in `.gitignore`

**Example Structure**:
```json
{
  "horde_key": "YourKeyHere",
  "openai_key": "sk-...",
  "claude_key": "sk-ant-..."
}
```

### `default-API-Parameters.json`
**Purpose**: Default sampling parameters for API types
**Location**: Root directory

**Structure**:
```json
[
  {
    "TCAPICallParams": {
      "prompt": "",
      "seed": -1
    },
    "HordeAPICallParams": {
      "prompt": "",
      "params": {
        "max_context_length": 2048,
        "max_length": 400,
        "temperature": 1,
        "top_p": 0.9,
        "top_k": 100,
        ...
      },
      "trusted_workers": true,
      "models": ["koboldcpp/llama2-13b-tiefighter.Q6_K", ...]
    }
  }
]
```

### Preset Files

**Sampler Presets** (`/public/api-presets/`):
- JSON files with sampling parameters (temperature, top_p, top_k, etc.)
- Example: `Divine-Intellect.json`, `LLaMA-Precise.json`

**Instruct Presets** (`/public/instructFormats/`):
- Prompt format templates (ChatML, Llama3, Alpaca, etc.)
- Defines: `input_sequence`, `output_sequence`, `system_sequence`, `end_sequence`

**Example Instruct Format**:
```json
{
  "name": "ChatML",
  "system_sequence": "<|im_start|>system\n",
  "input_sequence": "<|im_start|>user\n",
  "output_sequence": "<|im_start|>assistant\n",
  "end_sequence": "<|im_end|>\n",
  "extras_for_stops": []
}
```

---

## Key Technical Patterns

### Database Write Queue

**Problem**: Race conditions with concurrent database writes
**Solution**: Serialized write queue with transaction support

**Implementation**:
```javascript
// Queue structure
let writeQueue = [];
let isProcessing = false;

// Enqueue write operation
async function queueDatabaseWrite(operation) {
  writeQueue.push(operation);
  if (!isProcessing) {
    processWriteQueue();
  }
}

// Process queue sequentially
async function processWriteQueue() {
  isProcessing = true;
  while (writeQueue.length > 0) {
    const operation = writeQueue.shift();
    await db.run('BEGIN TRANSACTION');
    try {
      await operation();
      await db.run('COMMIT');
    } catch (error) {
      await db.run('ROLLBACK');
      logger.error('Database write failed:', error);
    }
  }
  isProcessing = false;
}
```

### File Locking for Concurrent PNG Writes

**Problem**: Concurrent character card edits can corrupt PNG files
**Solution**: File lock mechanism

**Implementation** (`src/file-io.js`):
```javascript
let fileLock = false;

async function charaWrite(charPath, updatedData) {
  // Acquire lock
  while (fileLock) {
    await delay(100);
  }
  fileLock = true;

  try {
    // Read, modify, write PNG
    // ...
  } finally {
    // Release lock
    fileLock = false;
  }
}
```

### Token Budgeting and Estimation

**Local Estimation**:
- **Approximation**: 1 char ≈ 0.25 tokens (4.4 chars/token)
- **Template Overhead**: Per-message wrappers calculated from instruct format
- **Function**: `approxTokensFromChars(str)`

**Remote Calibration**:
- Query backend tokenizer API: `POST <endpoint>/v1/token/encode/`
- Calculate calibration factor: `actualTokens / estimatedTokens`
- Apply factor to future estimates

**Context Window Trimming**:
1. Start from most recent message
2. Work backwards, accumulating token counts
3. Stop when budget exceeded
4. Return trimmed message array

### Streaming Response Handling

**Server-Side Flow** (`src/stream.js`):
1. Create `textEmitter` EventEmitter
2. Listen to API stream chunks
3. Emit tokens as `text` events
4. Auto-fix markdown with `autoMendMarkdown()`
5. Emit `responseComplete` on finish

**Client-Side Rendering** (`public/src/streamUpdater.js`):
1. Listen to WebSocket `streamedAIResponse` messages
2. Ensure stable text node in DOM
3. Update text node value (avoids re-rendering)
4. Throttle updates to 16ms (60 FPS)
5. Auto-scroll to bottom

**Markdown Auto-Fixing**:
- Balances unclosed quotes
- Closes code blocks
- Fixes bold/italic/strikethrough

### Multi-Character Response Queuing

**Queue Structure**:
```javascript
let responseQueue = [];           // Array of { value, displayName }
let queueActive = false;          // Processing in progress
let currentResponder = null;      // Character currently generating
```

**Flow**:
1. User sends message mentioning characters
2. `buildResponseQueue()` parses message for character names
3. Matched characters added to queue (in order of appearance)
4. Unmatched characters randomized and appended
5. First character generates response
6. On `responseComplete` event, pop next character from queue
7. Repeat until queue empty

**State Broadcasting**:
```javascript
{
  type: 'responseQueueUpdate',
  active: queueActive,
  current: currentResponder,
  remaining: responseQueue
}
```

---

## Development Guidelines

### Common Operations

#### Adding a New API Type

1. **Update Database Schema** (`src/db.js`):
   - Add new API type to `apis.type` enum (if needed)

2. **Add API Call Handler** (`src/api-calls.js`):
   - Implement `requestToNewAPI()` function
   - Add case to `getAIResponse()` switch statement

3. **Update Client UI** (`public/src/controls.js`):
   - Add API type to selector
   - Update form validation

4. **Add Default Parameters** (`default-API-Parameters.json`):
   - Define default sampler settings

#### Adding a New WebSocket Message Type

1. **Server Handler** (`server.js`):
   ```javascript
   if (parsedMessage.type === 'newMessageType') {
     // Handle message
     // Query database if needed
     // Broadcast response
   }
   ```

2. **Client Sender** (`public/script.js` or module):
   ```javascript
   socket.send(JSON.stringify({
     type: 'newMessageType',
     UUID: myUUID,
     // ... data
   }));
   ```

3. **Client Listener** (`public/script.js`):
   ```javascript
   socket.addEventListener('message', (event) => {
     const data = JSON.parse(event.data);
     if (data.type === 'newResponseType') {
       // Handle response
     }
   });
   ```

#### Adding a New Database Table

1. **Define Schema** (`src/db.js`):
   ```javascript
   await db.run(`
     CREATE TABLE IF NOT EXISTS new_table (
       id TEXT PRIMARY KEY,
       field1 TEXT,
       created_at DATETIME DEFAULT CURRENT_TIMESTAMP
     )
   `);
   ```

2. **Add CRUD Functions**:
   ```javascript
   async function createEntry(id, field1) {
     await queueDatabaseWrite(async () => {
       await db.run(
         'INSERT INTO new_table (id, field1) VALUES (?, ?)',
         [id, field1]
       );
     });
   }
   ```

3. **Add WebSocket Handlers** (see above)

#### Adding a New Lorebook Entry Strategy

1. **Update Database** (`src/db.js`):
   - Add strategy to `lorebook_entries.strategy` documentation

2. **Update Activation Engine** (`src/lorebook.js`):
   ```javascript
   if (entry.strategy === 'newStrategy') {
     // Implement activation logic
     activated = someCondition;
   }
   ```

3. **Update UI** (`public/src/lorebook.js`):
   - Add option to strategy selector
   - Update UI indicators

### Testing Patterns

#### Testing API Connections

1. Use Control Panel → API Config → Edit → Test button
2. Sends simple "Ping?" message
3. Checks response format and connectivity
4. View results in browser console

#### Testing Database Operations

1. Check `stmp.db` file in root directory
2. Use SQLite browser tool to inspect tables
3. Enable database logging via `dbLogger.level = 'debug'` in `src/log.js`

#### Testing WebSocket Protocol

1. Open browser DevTools → Network → WS tab
2. Monitor WebSocket messages
3. Use `logger.info()` in `server.js` to log messages
4. Check server console output

#### Testing Streaming

1. Enable streaming in Control Panel
2. Monitor `streamedAIResponse` WebSocket messages
3. Check for markdown auto-fixing
4. Verify throttling (should update ~60 FPS)

### Debugging Tips

#### Common Issues

**Issue**: "Database locked" errors
**Solution**: Check write queue, ensure operations are queued properly

**Issue**: Character card not updating
**Solution**: Check file lock, verify PNG encoding, check for invalid JSON

**Issue**: Lorebook entries not activating
**Solution**: Verify keywords, check scan depth, ensure lorebook enabled

**Issue**: Streaming responses cut off
**Solution**: Check stop sequences, verify API response format

**Issue**: WebSocket disconnections
**Solution**: Check heartbeat, verify network stability, enable keepalive audio

#### Logging

**Enable Verbose Logging**:
```javascript
// In src/log.js
logger.level = 'debug';
dbLogger.level = 'debug';
apiLogger.level = 'debug';
```

**Log File Locations**:
- Server logs: Console output
- Database logs: Via `dbLogger`
- API logs: Via `apiLogger`

#### Browser Console

**Useful Commands**:
```javascript
// Check WebSocket connection
socket.readyState  // 1 = OPEN

// Inspect configuration
liveConfig

// Check user state
myUUID, myUsername, myPersona

// Force state refresh
location.reload()
```

### Where to Add New Features

**Character-Related**: `src/character-card-parser.js`, `public/src/characterEditor.js`
**API Integration**: `src/api-calls.js`
**Database Schema**: `src/db.js`
**Lorebook Logic**: `src/lorebook.js`, `public/src/lorebook.js`
**UI Controls**: `public/src/controls.js`
**WebSocket Protocol**: `server.js`
**Streaming**: `src/stream.js`, `public/src/streamUpdater.js`

---

## File References

**Critical Files**:
- `server.js:1-100` - Server initialization and WebSocket setup
- `src/db.js:1-50` - Database schema definitions
- `src/api-calls.js:1-200` - Core API integration logic
- `public/script.js:1-100` - Client initialization and WebSocket connection

**Configuration**:
- `package.json` - Dependencies and scripts
- `default-API-Parameters.json` - API defaults
- `config.json` - Application settings (created at runtime)
- `secrets.json` - Sensitive data (created at runtime)

---

**Last Updated**: 2026-01-18
**Document Version**: 1.0
**Branch**: dreamy-poitras (Gemini Edition)

For user-facing documentation, see `README.md`.
For issues and support, visit: https://github.com/RossAscends/STMP
