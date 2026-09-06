#!/usr/bin/env bash
# Seed the local Redis and PostgreSQL fixtures that src/__tests__/socket.live.test.ts reads.
#
# Those tests SKIP when nothing is listening, so this script is what turns them on. They are the
# only place the Open Socket is exercised against real servers: the gate tests prove what may be
# sent and the wire tests prove the framing against a scripted socket, but neither catches a
# connector setting the adapter quietly ignores. One did — `database` was honoured by Postgres and
# dropped by Redis, so a non-zero logical database read from the wrong one and returned "no such
# key", which is indistinguishable from a genuinely absent record.
#
#   brew install redis postgresql@16
#   redis-server --daemonize yes
#   brew services start postgresql@16
#   bash scripts/seed-socket-fixtures.sh
set -euo pipefail

REDIS_DB="${BIMAX_TEST_REDIS_DB:-9}"
PG_DB="${BIMAX_TEST_PG_DB:-bimax_socket_test}"
export PATH="/opt/homebrew/bin:/opt/homebrew/opt/postgresql@16/bin:$PATH"

if command -v redis-cli >/dev/null && redis-cli ping >/dev/null 2>&1; then
  # A non-zero database on purpose: db 0 would pass even if `database` were ignored entirely.
  redis-cli -n "$REDIS_DB" FLUSHDB >/dev/null
  redis-cli -n "$REDIS_DB" HSET "reading:PT-101" tag PT-101 pressure_bar 4.2 unit bar measured_on 2026-03-14 >/dev/null
  redis-cli -n "$REDIS_DB" RPUSH "history:E-204" 8.6 8.1 7.8 >/dev/null
  redis-cli -n "$REDIS_DB" SET "note:E-204" "engineering assessment required" >/dev/null
  echo "redis db $REDIS_DB seeded ($(redis-cli -n "$REDIS_DB" DBSIZE) keys)"
else
  echo "redis not reachable — its live tests will skip" >&2
fi

if command -v psql >/dev/null && pg_isready >/dev/null 2>&1; then
  psql -d postgres -v ON_ERROR_STOP=1 -q <<SQL
DROP DATABASE IF EXISTS $PG_DB;
CREATE DATABASE $PG_DB;
SQL
  psql -d "$PG_DB" -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE TABLE inspections (
  id serial PRIMARY KEY,
  equipment_tag text NOT NULL,
  thickness_mm numeric NOT NULL,
  inspector text,
  inspected_on date NOT NULL
);
INSERT INTO inspections (equipment_tag, thickness_mm, inspector, inspected_on) VALUES
  ('E-204',  8.6, 'R. Rao', '2024-03-14'),
  ('E-204',  8.1, 'R. Rao', '2025-03-11'),
  ('E-204',  7.8, 'R. Rao', '2026-03-09'),
  ('P-310A', 9.4, 'S. Nair', '2026-03-09');
SQL
  echo "postgres $PG_DB seeded ($(psql -d "$PG_DB" -tAc 'select count(*) from inspections;') rows)"
else
  echo "postgres not reachable — its live tests will skip" >&2
fi
