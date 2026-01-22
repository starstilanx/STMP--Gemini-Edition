# PostgreSQL Migration Guide for STMP

This guide will help you migrate from SQLite to PostgreSQL for better multi-user performance and scalability.

## Why PostgreSQL?

- **Better Concurrency**: PostgreSQL handles multiple simultaneous users better than SQLite
- **Connection Pooling**: Improved performance under load
- **Cloud Ready**: Easy deployment to hosting services (Heroku, Railway, Supabase, AWS RDS)
- **Advanced Features**: Row-level security, better full-text search, JSONB support
- **Room Isolation**: Better data separation for multi-room chat

## Installation Steps

### 1. Install PostgreSQL

**Windows:**
```bash
# Download from https://www.postgresql.org/download/windows/
# Or use chocolatey:
choco install postgresql
```

**Mac:**
```bash
brew install postgresql
brew services start postgresql
```

**Linux (Ubuntu/Debian):**
```bash
sudo apt-get update
sudo apt-get install postgresql postgresql-contrib
sudo systemctl start postgresql
sudo systemctl enable postgresql
```

### 2. Create Database and User

Connect to PostgreSQL as the postgres user:

```bash
# Windows/Linux
psql -U postgres

# Mac
psql postgres
```

Run these SQL commands:

```sql
-- Create database
CREATE DATABASE stmp;

-- Create user with password
CREATE USER stmp_user WITH PASSWORD 'your_secure_password_here';

-- Grant privileges
GRANT ALL PRIVILEGES ON DATABASE stmp TO stmp_user;

-- Connect to the database
\c stmp

-- Grant schema privileges
GRANT ALL ON SCHEMA public TO stmp_user;

-- Grant default privileges for future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO stmp_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO stmp_user;

-- Exit
\q
```

### 3. Initialize the Schema

Run the schema creation script:

```bash
psql -U stmp_user -d stmp -f src/schema-postgres.sql
```

You should see output like:
```
CREATE EXTENSION
CREATE TABLE
CREATE TABLE
...
CREATE INDEX
```

### 4. Install Node.js PostgreSQL Driver

```bash
npm install pg
```

### 5. Configure Environment Variables

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` with your database credentials:

```env
DB_TYPE=postgres

PG_HOST=localhost
PG_PORT=5432
PG_DATABASE=stmp
PG_USER=stmp_user
PG_PASSWORD=your_secure_password_here
PG_POOL_SIZE=20
```

**IMPORTANT**: Add `.env` to your `.gitignore` to avoid committing credentials!

### 6. Migrate Existing Data (Optional)

If you have existing SQLite data you want to preserve:

```bash
node src/migrate-to-postgres.js
```

This will:
- Read all data from `stmp.db`
- Convert and insert it into PostgreSQL
- Preserve all users, messages, sessions, rooms, etc.

### 7. Update Server to Use PostgreSQL

The server will automatically detect `DB_TYPE=postgres` in your `.env` file and use the PostgreSQL database module.

### 8. Start the Server

```bash
npm start
```

You should see in the logs:
```
[INFO] PostgreSQL connected successfully at [timestamp]
[INFO] PostgreSQL schema verified successfully
```

## Cloud Deployment Options

### Option 1: Supabase (Free Tier Available)

1. Create account at https://supabase.com
2. Create new project
3. Get connection string from Project Settings → Database
4. Update `.env`:
```env
PG_HOST=db.xxxxxxxxxxxxx.supabase.co
PG_PORT=5432
PG_DATABASE=postgres
PG_USER=postgres
PG_PASSWORD=[your_password]
```

### Option 2: Railway (Simple Deployment)

1. Create account at https://railway.app
2. Create PostgreSQL service
3. Copy connection details to `.env`

### Option 3: Heroku Postgres

1. Create Heroku app
2. Add Heroku Postgres addon
3. Use `DATABASE_URL` from Heroku config

### Option 4: AWS RDS

1. Create RDS PostgreSQL instance
2. Configure security groups
3. Use endpoint in `.env`

## Verifying the Migration

### Check Database Contents

```bash
psql -U stmp_user -d stmp
```

```sql
-- Check tables exist
\dt

-- Count records
SELECT COUNT(*) FROM users;
SELECT COUNT(*) FROM rooms;
SELECT COUNT(*) FROM aichats;

-- View sample data
SELECT * FROM users LIMIT 5;
```

### Test the Application

1. Start the server
2. Create a new account (test registration)
3. Send messages (test chat functionality)
4. Create a room (test room isolation)
5. Check past chats (test history)

## Troubleshooting

### Connection Refused

**Error**: `Error: connect ECONNREFUSED 127.0.0.1:5432`

**Solution**:
- Check PostgreSQL is running: `pg_ctl status` or `brew services list`
- Check port is correct (default 5432)
- Check firewall settings

### Authentication Failed

**Error**: `password authentication failed for user "stmp_user"`

**Solution**:
- Double-check password in `.env`
- Verify user was created correctly
- Check `pg_hba.conf` authentication method

### Permission Denied

**Error**: `permission denied for table users`

**Solution**:
```sql
-- Reconnect as postgres user and run:
\c stmp
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO stmp_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO stmp_user;
```

### Schema Not Found

**Error**: `relation "users" does not exist`

**Solution**:
- Re-run schema creation: `psql -U stmp_user -d stmp -f src/schema-postgres.sql`

## Performance Tuning

### Increase Connection Pool

For more users, increase pool size in `.env`:
```env
PG_POOL_SIZE=50
```

### Monitor Connections

```sql
-- Check active connections
SELECT count(*) FROM pg_stat_activity WHERE datname = 'stmp';

-- View connection details
SELECT * FROM pg_stat_activity WHERE datname = 'stmp';
```

### Optimize Queries

```sql
-- Analyze query performance
EXPLAIN ANALYZE SELECT * FROM aichats WHERE room_id = 'xxx';

-- Update table statistics
ANALYZE users;
ANALYZE aichats;
```

## Backup and Restore

### Create Backup

```bash
pg_dump -U stmp_user -d stmp -F c -f stmp_backup.dump
```

### Restore Backup

```bash
pg_restore -U stmp_user -d stmp -c stmp_backup.dump
```

### Automated Backups

Set up cron job (Linux/Mac):
```bash
# Add to crontab -e
0 2 * * * pg_dump -U stmp_user -d stmp -F c -f /backups/stmp_$(date +\%Y\%m\%d).dump
```

## Switching Back to SQLite

If you need to revert to SQLite:

1. Update `.env`:
```env
DB_TYPE=sqlite
```

2. Restart server - it will automatically use `stmp.db`

## Support

For issues or questions:
- Check logs in console
- Review PostgreSQL logs: `tail -f /var/log/postgresql/postgresql-*.log`
- Open GitHub issue with error details

## Next Steps

Once PostgreSQL is running:
- Consider enabling SSL for remote connections
- Set up automated backups
- Monitor database performance
- Optimize indexes for your usage patterns
