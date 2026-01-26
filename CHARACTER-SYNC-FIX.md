# Character Synchronization Fix for PostgreSQL

## The Problem

When migrating from SQLite to PostgreSQL, you may encounter this error:

```
error: insert or update on table "aichats" violates foreign key constraint "aichats_user_id_fkey"
Key (user_id)=(Winter) is not present in table "users".
```

### Why This Happens

In STMP, **AI characters send messages just like users do**. When a character like "Winter" sends a message, the system tries to insert a row into the `aichats` table with `user_id='Winter'`.

**The Issue**:
- PostgreSQL enforces foreign key constraints strictly
- The `aichats.user_id` field has a foreign key constraint to `users.user_id`
- Character names (like "Winter") don't exist in the `users` table
- SQLite allowed this because foreign keys weren't enforced by default
- PostgreSQL **strictly enforces** this constraint → error!

## The Solution

We've implemented **automatic character synchronization** that runs when the server starts. This ensures all character PNG files in the `characters/` directory have corresponding entries in the `users` table.

### What It Does

1. **On Server Startup** (`src/db-loader.js`):
   - Scans `./public/characters/` directory for PNG files
   - For each character file (e.g., `Winter.png`):
     - Creates an entry in the `users` table with `user_id='Winter'`
     - Sets a default purple color (`#8B4789`)
     - Marks it as `persona='Character: Winter'`
   - Logs how many characters were synced, skipped, or had errors

2. **Before Writing Messages** (`src/db-pg.js` → `writeAIChatMessage()`):
   - When a character sends a message (`entity === 'AI'`)
   - Calls `ensureCharacterExists(characterName)` first
   - Creates the character entry if it doesn't exist
   - Then writes the message → no more foreign key errors!

### Modified Files

1. **`src/db-pg.js`**:
   - Added `syncCharactersToDatabase()` function
   - Added `ensureCharacterExists()` function
   - Modified `writeAIChatMessage()` to call `ensureCharacterExists()`
   - Exported both new functions

2. **`src/db-loader.js`**:
   - Added call to `syncCharactersToDatabase()` during PostgreSQL initialization
   - Logs sync results to console

3. **`CHARACTER-SYNC-FIX.md`** (this file):
   - Documentation for the fix

## How It Works

### Startup Sync (`syncCharactersToDatabase`)

```javascript
// Pseudocode
async function syncCharactersToDatabase(charactersDir) {
  // 1. Read all PNG files from characters directory
  const pngFiles = await readDirectory(charactersDir);

  // 2. For each character file:
  for (const file of pngFiles) {
    const charName = removeExtension(file); // "Winter.png" → "Winter"

    // 3. Check if character already exists in users table
    const exists = await checkUserExists(charName);

    if (!exists) {
      // 4. Create character entry
      await createUser({
        user_id: charName,       // "Winter"
        username: charName,      // "Winter"
        username_color: '#8B4789', // Purple
        persona: `Character: ${charName}` // "Character: Winter"
      });
    }
  }
}
```

### Runtime Check (`ensureCharacterExists`)

```javascript
// Pseudocode
async function ensureCharacterExists(characterName) {
  // Check if character exists
  const exists = await checkUserExists(characterName);

  if (!exists) {
    // Create on-the-fly
    await createUser({
      user_id: characterName,
      username: characterName,
      username_color: '#8B4789',
      persona: `Character: ${characterName}`
    });
  }
}
```

### Message Writing (`writeAIChatMessage`)

```javascript
async function writeAIChatMessage(username, userId, message, entity, roomId) {
  // NEW: Ensure character exists BEFORE writing message
  if (entity === 'AI') {
    await ensureCharacterExists(userId);
  }

  // Now write the message (foreign key constraint will pass)
  await insertMessage({
    user_id: userId,  // "Winter" - now guaranteed to exist in users table
    username: username,
    message: message,
    entity: entity,
    room_id: roomId
  });
}
```

## Verification

### Check Characters Were Synced

```sql
-- Connect to database
psql -U stmp_user -d stmp

-- List all characters (identified by persona prefix)
SELECT user_id, username, username_color, persona
FROM users
WHERE persona LIKE 'Character:%'
ORDER BY user_id;
```

**Expected Output**:
```
  user_id  |  username  | username_color |     persona
-----------+------------+----------------+------------------
 Winter    | Winter     | #8B4789        | Character: Winter
 Summer    | Summer     | #8B4789        | Character: Summer
 ...
```

### Check Server Logs

When you start the server, you should see:

```
[Database] Loading POSTGRES database module...
[Database] PostgreSQL module loaded successfully
[INFO] PostgreSQL connected successfully at 2026-01-21T...
[INFO] Checking PostgreSQL schema...
[INFO] PostgreSQL schema verified successfully
[Database] Syncing character files...
[INFO] [syncCharacters] Syncing character files to database...
[INFO] [syncCharacters] Found 5 character PNG files
[INFO] [syncCharacters] Synced character: Winter
[INFO] [syncCharacters] Synced character: Summer
[INFO] [syncCharacters] Sync complete - Synced: 2, Skipped: 3, Errors: 0
[Database] Character sync complete - Synced: 2, Skipped: 3, Errors: 0
```

### Test Character Messages

1. Start server: `npm start`
2. Open browser: `http://localhost:5433`
3. Create/join a room
4. Select a character (e.g., "Winter")
5. Send a message
6. Trigger AI response

**Before Fix**:
```
❌ error: insert or update on table "aichats" violates foreign key constraint
```

**After Fix**:
```
✅ Message sent successfully
✅ AI response generated
✅ No foreign key errors!
```

## Manual Character Addition

If you add new character PNG files after the server has started, you have two options:

### Option 1: Restart Server (Recommended)

```bash
# Stop server (Ctrl+C)
npm start
# Characters will be auto-synced on startup
```

### Option 2: Manual SQL Insert

```sql
-- Connect to database
psql -U stmp_user -d stmp

-- Add character manually
INSERT INTO users (user_id, username, username_color, persona, created_at, last_seen_at)
VALUES ('NewCharacter', 'NewCharacter', '#8B4789', 'Character: NewCharacter', NOW(), NOW())
ON CONFLICT (user_id) DO NOTHING;
```

## Troubleshooting

### Character Still Not Working

**Check 1**: Verify character exists in database
```sql
SELECT * FROM users WHERE user_id = 'Winter';
```

If not found, add manually (see Option 2 above).

**Check 2**: Check character PNG file exists
```bash
# Windows
dir public\characters\Winter.png

# Linux/Mac
ls public/characters/Winter.png
```

**Check 3**: Check server logs for sync errors
```bash
grep "syncCharacters" server-logs.txt
```

### Sync Errors

If you see `Errors: X` in the sync output:

1. Check PostgreSQL connection:
   ```bash
   psql -U stmp_user -d stmp -c "SELECT 1"
   ```

2. Check permissions:
   ```bash
   psql -U postgres -d stmp -f fix-postgres-permissions.sql
   ```

3. Check file read permissions:
   ```bash
   # Make sure Node.js can read the characters directory
   ls -la public/characters/
   ```

## Technical Details

### Database Schema

```sql
-- users table (simplified)
CREATE TABLE users (
  user_id TEXT PRIMARY KEY,           -- Character name goes here
  username TEXT,
  username_color TEXT,
  persona TEXT,
  password_hash TEXT,                 -- NULL for characters
  created_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ
);

-- aichats table (simplified)
CREATE TABLE aichats (
  message_id SERIAL PRIMARY KEY,
  user_id TEXT REFERENCES users(user_id),  -- Foreign key constraint
  username TEXT,
  message TEXT,
  entity TEXT,                             -- 'AI' or 'user'
  timestamp TIMESTAMPTZ
);
```

### Foreign Key Constraint

```sql
-- This is what was causing the error:
ALTER TABLE aichats
  ADD CONSTRAINT aichats_user_id_fkey
  FOREIGN KEY (user_id)
  REFERENCES users(user_id);
```

**Before Fix**: "Winter" not in `users` table → Constraint violation → Error
**After Fix**: "Winter" added to `users` table → Constraint satisfied → Success!

## Why This Works

1. **PostgreSQL Requirement**: Foreign keys must reference existing rows
2. **STMP Design**: Characters use `user_id` just like human users
3. **Solution**: Pre-populate `users` table with all character names
4. **Safety**: `ON CONFLICT DO NOTHING` prevents duplicates
5. **Automation**: Runs on every server start (idempotent)

## Benefits

- ✅ No more foreign key constraint errors
- ✅ Automatic synchronization on server start
- ✅ Works with any number of characters
- ✅ Handles new characters added dynamically
- ✅ Idempotent (safe to run multiple times)
- ✅ No manual database work required
- ✅ Zero configuration needed

## Migration Notes

### Migrating from SQLite

If you migrated existing data from SQLite:

1. **Character messages in old data**: The migration script should have preserved them
2. **New characters after migration**: Auto-synced on next server start
3. **Rollback**: Characters remain in `users` table (harmless)

### Fresh PostgreSQL Install

If you're starting fresh:

1. Characters automatically synced on first server start
2. No manual work needed
3. Just add PNG files to `characters/` directory

## Credits

**Issue**: Foreign key constraint violation for AI character messages
**Root Cause**: PostgreSQL strictly enforces foreign keys (unlike SQLite)
**Solution**: Automatic character synchronization
**Implemented**: 2026-01-21
**Files Modified**: `src/db-pg.js`, `src/db-loader.js`

---

**For more information**, see:
- `POSTGRESQL-SETUP.md` - PostgreSQL installation guide
- `TROUBLESHOOTING-POSTGRES.md` - General PostgreSQL troubleshooting
- `CLAUDE.md` - Complete technical documentation
