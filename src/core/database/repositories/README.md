# Repository domain modules

`ProjectRepository` owns persistence for the `projects` table: project creation,
lookup, listing, status transitions, contract updates, and row mapping. The
public `Repository` class remains the compatibility facade used by existing
services and delegates these methods to the module.

The module receives the facade's existing `better-sqlite3` handle. It does not
open a connection, start a transaction, or alter the schema, so callers keep
the current transaction boundaries and single-writer authority.

Future repository extractions should follow this boundary: move one cohesive
table/domain at a time, delegate from `Repository`, preserve existing exports,
and add focused behavior and transaction tests before taking the next slice.
Migration definitions are intentionally outside this module and remain owned
by `src/core/database/migrations.ts`.
