# Quick Fix - PostgreSQL Issues

## The Problem

You're seeing these errors:
- ❌ `permission denied for schema public`
- ❌ `Cannot read properties of null (reading 'selectedModel')`
- ❌ No APIs in dropdown
- ❌ Character cards not loading

## The Solution (3 Steps)

### Step 1: Fix PostgreSQL Permissions (2 minutes)

Open **Command Prompt** or **PowerShell** and run:

```bash
psql -U postgres -d stmp -f fix-postgres-permissions.sql
```

Enter your postgres password when prompted.

You should see:
```
GRANT
GRANT
GRANT
ALTER DEFAULT PRIVILEGES
ALTER DEFAULT PRIVILEGES
```

### Step 2: Create Database Schema (1 minute)

```bash
psql -U stmp_user -d stmp -f src/schema-postgres.sql
```

Enter the stmp_user password (from your `.env` file).

You should see:
```
CREATE TABLE
CREATE TABLE
CREATE TABLE
...
INSERT 0 1
```

### Step 3: Restart Server (30 seconds)

```bash
# Stop current server (Ctrl+C)
npm start
```

You should see:
```
[INFO] PostgreSQL connected successfully
[INFO] PostgreSQL schema verified successfully
[INFO] Host Server: http://localhost:8181/
```

## Verify It Worked

1. Open http://localhost:8181/
2. Create an account (test registration)
3. Click "API Config" → "Add New API"
4. Add your API details and save
5. Click "Add Character" - cards should appear

## Still Broken?

See `TROUBLESHOOTING-POSTGRES.md` for detailed diagnostics.

Or quickly switch back to SQLite:

```bash
# Edit .env
DB_TYPE=sqlite

# Restart
npm start
```

Done! 🎉
