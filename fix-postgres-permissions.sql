-- Fix PostgreSQL Permissions for STMP
-- Run this as the postgres superuser
-- Usage: psql -U postgres -d stmp -f fix-postgres-permissions.sql

-- Grant schema permissions to stmp_user
GRANT ALL ON SCHEMA public TO stmp_user;

-- Grant permissions on all existing tables
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO stmp_user;

-- Grant permissions on all existing sequences
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO stmp_user;

-- Set default privileges for future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO stmp_user;

-- Set default privileges for future sequences
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO stmp_user;

-- Verify permissions
\dp

SELECT 'Permissions fixed successfully!' AS status;
