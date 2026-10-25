'use strict';

// The one PostgreSQL connection pool plus three small helpers:
//   query(sql, params)       -> array of rows
//   queryOne(sql, params)    -> first row, or undefined
//   transaction(async client => { ... })  -> BEGIN/COMMIT with automatic ROLLBACK

const { Pool } = require('pg');
const config = require('../config');

// Local databases (localhost, or the docker-compose service called postgres) do not use TLS.
const LOCAL_DB = /localhost|127[.]0[.]0[.]1|@postgres[:/]/;

function sslOptions() {
  if (LOCAL_DB.test(config.databaseUrl)) return false;
  return { rejectUnauthorized: config.dbSslStrict };
}

const pool = new Pool({ connectionString: config.databaseUrl, ssl: sslOptions() });

const query = (sql, params) => pool.query(sql, params).then(result => result.rows);

const queryOne = async (sql, params) => (await query(sql, params))[0];

// Runs fn(client) inside a transaction. If fn throws, everything it did is rolled
// back and the error is re-thrown to the caller.
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, queryOne, transaction };
