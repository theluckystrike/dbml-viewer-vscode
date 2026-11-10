# SQL to ER diagram

The diagram button also shows up on `.sql` files that contain `CREATE TABLE`. It reads:

- PostgreSQL, MySQL and MariaDB, SQL Server and SQLite DDL: dumps and migration files
- `CREATE TABLE` with column types, `PRIMARY KEY`, `NOT NULL`, `UNIQUE`, `DEFAULT` and `REFERENCES`
- `FOREIGN KEY` constraints, `ALTER TABLE ... ADD CONSTRAINT`, `CREATE INDEX`, `CREATE TYPE ... AS ENUM` and `COMMENT ON`

Statements that do not change the schema (`INSERT`, views, functions) are skipped and listed under the toolbar.

Prisma schemas (`.prisma`) work too: models, `@relation` and enums.
