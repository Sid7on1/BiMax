// Benchmark-only SQLite publication: one complete provider batch, no partial cache on failure.
function writeBatch(database, insert, rows) {
  database.exec('BEGIN');
  try {
    for (const row of rows) insert.run(...row);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
module.exports = { writeBatch };
