#!/bin/sh
# The account the application signs in as, created once, on the boot that
# creates the cluster.
#
# Mounted into the container at /docker-entrypoint-initdb.d/10-application-role.sh
# by compose.postgres.yml, so the official entrypoint runs it against a
# temporary server that is not published anywhere, over the container's own
# socket, as the superuser. POSTGRES_DB already exists by then — the entrypoint
# creates it in initdb — which is what lets this hand the database over rather
# than grant on it.
#
# Not the superuser, and that is the point of the file. The `vps` recipe had the
# application connecting as the owner of the cluster, so one leaked connection
# string could drop every database on the machine, read every other role's
# tables and turn off logging on the way out. This role can do exactly one
# thing: everything inside `simple_balance`.
#
# Safe to run again, by hand, which is how the application's password is
# rotated:
#
#   sudo docker compose exec -e POSTGRES_APP_PASSWORD='<new>' \
#        postgres /docker-entrypoint-initdb.d/10-application-role.sh
#
# then put the same value in env.db on the application machine and restart it.
# The entrypoint only runs this directory on a fresh cluster, so nothing else
# would ever run it twice; the branch below exists for the operator, not for it.
set -eu

: "${POSTGRES_USER:?the entrypoint always sets this}"
: "${POSTGRES_DB:?the entrypoint always sets this}"
: "${POSTGRES_APP_PASSWORD:?compose.postgres.yml passes this; it has no default}"

# The role's name is fixed rather than configurable. It appears in pg_hba.conf,
# in the DATABASE_URL the Pulumi program writes and in the backup's dump, and a
# name spelled in four places is a name three of them can be wrong about.
role=simple_balance

# ON_ERROR_STOP, because psql's default is to report a failed statement and
# carry on with the next one — which here would leave a cluster with no
# application role, an entrypoint that reported success, and a server published
# and healthy that the application cannot sign in to.
#
# `-v` and `:'...'`, never shell interpolation into SQL: psql quotes and escapes
# the value itself, so a password is a literal however it is spelled. The
# generated ones are alphanumeric, which is precisely the kind of fact that
# stops being true the day somebody sets their own.
psql_as_superuser() {
	psql --quiet --no-psqlrc --set ON_ERROR_STOP=1 \
		--username "$POSTGRES_USER" --dbname "$POSTGRES_DB" "$@"
}

if [ "$(psql_as_superuser -Atc "select count(*) from pg_roles where rolname = '$role'")" = 0 ]; then
	psql_as_superuser -v "password=$POSTGRES_APP_PASSWORD" <<-SQL
		CREATE ROLE $role LOGIN PASSWORD :'password';
	SQL
	echo "10-application-role.sh: created the $role role"
else
	# The rotation path. ALTER rather than DROP and CREATE: the role owns the
	# schema by the time anybody rotates anything, and dropping it would take
	# the ledger with it.
	psql_as_superuser -v "password=$POSTGRES_APP_PASSWORD" <<-SQL
		ALTER ROLE $role PASSWORD :'password';
	SQL
	echo "10-application-role.sh: $role already exists; its password was set"
fi

# Ownership rather than a grant, and the reason is PostgreSQL 15's. From 15 the
# `public` schema is owned by `pg_database_owner` and no longer grants CREATE to
# PUBLIC, so a role that merely has rights *in* the database cannot create a
# table in it — and the application's very first act is to run its migrations.
# `GRANT CREATE ON SCHEMA public` would work today and would have to be repeated
# for every schema anything ever adds; owning the database makes the role
# `pg_database_owner` resolves to, which is one statement that stays true.
#
# Idempotent: ALTER DATABASE ... OWNER TO succeeds when it is already the owner.
psql_as_superuser -v "db=$POSTGRES_DB" <<-SQL
	ALTER DATABASE :"db" OWNER TO $role;
SQL
echo "10-application-role.sh: $POSTGRES_DB is owned by $role"
