# PostgreSQL Quick Start Guide

This is a condensed guide for getting PostgreSQL running quickly. For detailed setup, see [POSTGRESQL-SETUP.md](POSTGRESQL-SETUP.md).

## Prerequisites

- PostgreSQL installed and running
- Node.js and npm installed

## 5-Minute Setup

### 1. Install PostgreSQL Driver

```bash
npm install
```

### 2. Create Database

```bash
# Connect to PostgreSQL
psql -U postgres

# Run these commands:
CREATE DATABASE stmp;
CREATE USER stmp_user WITH PASSWORD 'your_password';
GRANT ALL PRIVILEGES ON DATABASE stmp TO stmp_user;
\c stmp
GRANT ALL ON SCHEMA public TO stmp_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO stmp_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO stmp_user;
\q
```

### 3. Initialize Schema

```bash
psql -U stmp_user -d stmp -f src/schema-postgres.sql
```

### 4. Configure Environment

```bash
cp .env.example .env
```

Edit `.env`:
```env
DB_TYPE=postgres
PG_HOST=localhost
PG_PORT=5432
PG_DATABASE=stmp
PG_USER=stmp_user
PG_PASSWORD=your_password
```

### 5. (Optional) Migrate Existing Data

If you have existing SQLite data:

```bash
npm run migrate
```

### 6. Start Server

```bash
npm start
```

You should see:
```
[Database] Loading POSTGRES database module...
[INFO] PostgreSQL connected successfully...
[INFO] PostgreSQL schema verified successfully
```

## Switching Back to SQLite

Edit `.env`:
```env
DB_TYPE=sqlite
```

Restart server - done!

## Quick Verification

```bash
# Connect to database
psql -U stmp_user -d stmp

# Check tables
\dt

# Check data
SELECT COUNT(*) FROM users;
SELECT COUNT(*) FROM rooms;
```

## Troubleshooting

**Connection refused?**
- Check PostgreSQL is running: `pg_ctl status`
- Check port 5432 is open

**Authentication failed?**
- Double-check password in `.env`
- Check `pg_hba.conf` allows password auth

**Schema errors?**
- Re-run: `psql -U stmp_user -d stmp -f src/schema-postgres.sql`

**Need help?**
- See full guide: [POSTGRESQL-SETUP.md](POSTGRESQL-SETUP.md)
- Check logs in console for errors

## Cloud Deployment (1-Click)

### Supabase (Free)
1. Go to https://supabase.com
2. Create project
3. Get connection string
4. Update `.env` with Supabase credentials

### Railway
1. Go to https://railway.app
2. Add PostgreSQL service
3. Copy credentials to `.env`

Done!
