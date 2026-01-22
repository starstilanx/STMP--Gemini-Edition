# PostgreSQL Migration Troubleshooting Guide

## Quick Fixes Applied

The following issues have been fixed in the codebase:

### 1. ✅ Null API Reference Errors (FIXED)
**Error**: `Cannot read properties of null (reading 'selectedModel')`

**What was wrong**: Code was trying to access `liveConfig.APIConfig.selectedModel` when no APIs were configured yet.

**Fixed in**:
- `server.js` lines 1361, 1546, 1557-1559
- `src/api-calls.js` line 1510

**Changes made**: Added null checks with optional chaining (`?.`) and fallback values.

### 2. ⚠️ PostgreSQL Permission Errors (NEEDS MANUAL FIX)
**Error**: `permission denied for schema public`

**What's wrong**: The `stmp_user` doesn't have CREATE privileges on the public schema.

**How to fix**: Run the permission fix script as the postgres superuser.

---

## Step-by-Step Fix Instructions

### Fix 1: PostgreSQL Permissions (REQUIRED)

Run this command in your terminal:

```bash
psql -U postgres -d stmp -f fix-postgres-permissions.sql
```

**Or manually in psql:**

```sql
-- Connect as postgres superuser
psql -U postgres -d stmp

-- Run these commands:
GRANT ALL ON SCHEMA public TO stmp_user;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO stmp_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO stmp_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO stmp_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO stmp_user;

-- Exit
\q
```

After fixing permissions, **re-run the schema creation**:

```bash
psql -U stmp_user -d stmp -f src/schema-postgres.sql
```

You should see:
```
CREATE TABLE
CREATE TABLE
CREATE INDEX
...
INSERT 0 1
```

### Fix 2: Character Cards Not Showing

**Possible causes**:
1. Database not initialized properly
2. Permission issues
3. File system paths

**How to diagnose**:

Check if character files exist:
```bash
dir public\characters
```

Check database for characters:
```bash
psql -U stmp_user -d stmp
SELECT * FROM characters;
\q
```

**If characters table is empty but files exist:**

The character loading happens when you click "Add Character" button. The files should be automatically scanned.

### Fix 3: API Dropdown Empty

**Why**: After migrating to PostgreSQL, the APIs table is empty.

**How to fix**: You need to re-add your APIs through the UI.

**Steps**:
1. Click "API Config" button
2. Click "Add New API"
3. Fill in your API details (name, endpoint, key, type)
4. Click "Test" to verify connection
5. Click "Save"

Your previous APIs from SQLite need to be manually re-configured OR you can migrate the data.

### Fix 4: Migrate Existing Data

If you want to preserve your existing APIs, characters, and messages from SQLite:

```bash
# Make sure SQLite database exists
ls stmp.db

# Run migration
npm run migrate
```

This will copy all data from SQLite → PostgreSQL.

---

## Verification Checklist

After applying fixes, verify everything works:

### 1. Check Database Connection

```bash
psql -U stmp_user -d stmp
\dt  # Should show all tables
SELECT COUNT(*) FROM users;
SELECT COUNT(*) FROM rooms;
\q
```

### 2. Start Server

```bash
npm start
```

**Look for these SUCCESS messages:**
```
[Database] Loading POSTGRES database module...
[INFO] PostgreSQL connected successfully at [timestamp]
[INFO] PostgreSQL schema verified successfully
[INFO] Host Server: http://localhost:8181/
```

**Should NOT see**:
- ❌ `permission denied for schema public`
- ❌ `Cannot read properties of null`
- ❌ `relation "users" does not exist`

### 3. Test UI Features

Open http://localhost:8181/ and test:

- [ ] **Login/Registration** - Create a new account
- [ ] **API Configuration** - Add an API
- [ ] **Character Cards** - Click "Add Character" - cards should load
- [ ] **Create Room** - Create a new chat room
- [ ] **Send Message** - Type and send a test message
- [ ] **AI Response** - Configure API and trigger AI response

---

## Common Errors and Solutions

### Error: `password authentication failed for user "stmp_user"`

**Cause**: Wrong password in `.env` file

**Fix**:
```bash
# Edit .env and double-check password
notepad .env

# Or reset the password in PostgreSQL:
psql -U postgres
ALTER USER stmp_user WITH PASSWORD 'your_new_password';
\q

# Update .env with new password
```

### Error: `relation "users" does not exist`

**Cause**: Schema not created or permission denied during creation

**Fix**:
1. Fix permissions first (see Fix 1 above)
2. Re-run schema creation:
   ```bash
   psql -U stmp_user -d stmp -f src/schema-postgres.sql
   ```

### Error: `could not receive data from client`

**Cause**: Client disconnected (this is normal when refreshing browser)

**Not an error** - just informational logging.

### Error: `No API configured`

**Cause**: APIs table is empty

**Fix**: Add an API through the UI (see Fix 3 above) or run migration.

---

## Testing Sequence

Follow this sequence to ensure everything works:

1. **Fix permissions** → `psql -U postgres -d stmp -f fix-postgres-permissions.sql`
2. **Create schema** → `psql -U stmp_user -d stmp -f src/schema-postgres.sql`
3. **Verify tables** → `psql -U stmp_user -d stmp -c "\dt"`
4. **(Optional) Migrate data** → `npm run migrate`
5. **Start server** → `npm start`
6. **Open browser** → http://localhost:8181/
7. **Create account** → Test registration
8. **Add API** → Configure your LLM API
9. **Add character** → Select a character card
10. **Create room** → Make a new chat room
11. **Test chat** → Send messages and get AI responses

---

## Still Having Issues?

### Check Logs

**Server logs**: Look at the terminal where you ran `npm start`

**PostgreSQL logs**:
```bash
# Windows
type "C:\Program Files\PostgreSQL\18\data\log\*.log"

# Or use pgAdmin 4 to view logs
```

### Enable Debug Mode

Add to `.env`:
```env
LOG_LEVEL=debug
```

Restart server and check for detailed logging.

### Get Database Info

```bash
psql -U stmp_user -d stmp

-- Check table sizes
SELECT schemaname,relname,n_live_tup
FROM pg_stat_user_tables
ORDER BY n_live_tup DESC;

-- Check recent activity
SELECT * FROM pg_stat_activity WHERE datname = 'stmp';

-- Check for errors
SELECT * FROM pg_stat_database WHERE datname = 'stmp';
```

### Switch Back to SQLite Temporarily

If you need to get things working quickly:

1. Edit `.env`:
   ```env
   DB_TYPE=sqlite
   ```

2. Restart server - it will use the old SQLite database

3. Fix PostgreSQL issues offline

4. Switch back when ready

---

## Support

If none of these fixes work:

1. Copy the **full error message** from console
2. Copy the **PostgreSQL log excerpt** showing the error
3. Note what **step you were on** when it failed
4. Open an issue with all three pieces of information

## Summary of Files Modified

**Fixed null checks**:
- `server.js` - Added `?.` optional chaining for API config
- `src/api-calls.js` - Added null check in `tryLoadModel()`

**Permission fix script**:
- `fix-postgres-permissions.sql` - Run this to fix DB permissions

**No changes needed to**:
- `src/db-pg.js` - Working correctly
- `src/schema-postgres.sql` - Schema is correct
- Character loading - Should work once DB is fixed
