const { Pool, types } = require('pg');

types.setTypeParser(types.builtins.INT8, (value) => Number(value));
types.setTypeParser(types.builtins.NUMERIC, (value) => Number(value));

const CONNECTION_STRING = process.env.DATABASE_URL
  || process.env.POSTGRES_URL
  || process.env.POSTGRESQL_URL;

const DEFAULT_DB_NAME = process.env.DB_NAME
  || process.env.PGDATABASE
  || process.env.POSTGRES_DB
  || 'fitdaptive';
const BOOLEAN_COLUMNS = new Set([
  'gluten_free',
  'is_active',
  'is_done',
  'is_read',
  'vegan',
  'vegetarian',
  'workout_completed',
]);

function coerceBooleanValue(key, value) {
  if (!BOOLEAN_COLUMNS.has(key)) return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  return value;
}

function normalizeDataValues(data) {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, coerceBooleanValue(key, value)])
  );
}

function shouldUseSsl() {
  if (process.env.DB_SSL === 'true') return true;
  if (process.env.DB_SSL === 'false') return false;
  if (process.env.PGSSLMODE === 'require') return true;
  if (process.env.PGSSLMODE === 'disable') return false;
  return Boolean(CONNECTION_STRING || process.env.RAILWAY_ENVIRONMENT_ID);
}

function createPoolConfig() {
  const ssl = shouldUseSsl() ? { rejectUnauthorized: false } : false;

  if (CONNECTION_STRING) {
    return {
      connectionString: CONNECTION_STRING,
      max: Number(process.env.DB_POOL_SIZE || 10),
      ssl,
    };
  }

  return {
    host: process.env.DB_HOST || process.env.PGHOST || process.env.POSTGRES_HOST || 'localhost',
    port: Number(process.env.DB_PORT || process.env.PGPORT || process.env.POSTGRES_PORT || 5432),
    user: process.env.DB_USER || process.env.PGUSER || process.env.POSTGRES_USER || 'postgres',
    password: process.env.DB_PASSWORD || process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD || '',
    database: DEFAULT_DB_NAME,
    max: Number(process.env.DB_POOL_SIZE || 10),
    ssl,
  };
}

const nativePool = new Pool(createPoolConfig());

const quoteIdentifier = (value) => `"${String(value).replace(/"/g, '""')}"`;

function replacePositionalParams(sql, startIndex = 1) {
  let index = startIndex;
  return sql.replace(/\?/g, () => `$${index++}`);
}

function normalizeIntervalSql(sql) {
  return sql
    .replace(/DATE_ADD\(\s*(NOW\(\)|CURRENT_TIMESTAMP|CURRENT_DATE)\s*,\s*INTERVAL\s+(\d+)\s+(SECOND|MINUTE|HOUR|DAY|WEEK|MONTH|YEAR)\s*\)/gi, (_, base, amount, unit) => `${base === 'NOW()' ? 'CURRENT_TIMESTAMP' : base} + INTERVAL '${amount} ${unit.toLowerCase()}'`)
    .replace(/DATE_SUB\(\s*(NOW\(\)|CURRENT_TIMESTAMP|CURRENT_DATE)\s*,\s*INTERVAL\s+(\d+)\s+(SECOND|MINUTE|HOUR|DAY|WEEK|MONTH|YEAR)\s*\)/gi, (_, base, amount, unit) => `${base === 'NOW()' ? 'CURRENT_TIMESTAMP' : base} - INTERVAL '${amount} ${unit.toLowerCase()}'`);
}

function normalizeBooleanLiteralSql(sql) {
  let normalized = sql;
  for (const column of BOOLEAN_COLUMNS) {
    normalized = normalized
      .replace(new RegExp(`\\b${column}\\s*=\\s*1\\b`, 'gi'), `${column} = TRUE`)
      .replace(new RegExp(`\\b${column}\\s*=\\s*0\\b`, 'gi'), `${column} = FALSE`)
      .replace(new RegExp(`\\b${column}\\s*!=\\s*1\\b`, 'gi'), `${column} <> TRUE`)
      .replace(new RegExp(`\\b${column}\\s*!=\\s*0\\b`, 'gi'), `${column} <> FALSE`);
  }
  return normalized;
}

function rewriteInsertSet(sql, params) {
  const match = sql.match(/^\s*INSERT\s+INTO\s+([\w."]+)\s+SET\s+\?\s*;?\s*$/i);
  const data = Array.isArray(params) ? params[0] : null;
  if (!match || !data || typeof data !== 'object' || Array.isArray(data)) return null;

  const normalizedData = normalizeDataValues(data);
  const keys = Object.keys(normalizedData);
  if (!keys.length) throw new Error('INSERT data cannot be empty');

  const columns = keys.map(quoteIdentifier).join(', ');
  const placeholders = keys.map((_, index) => `$${index + 1}`).join(', ');

  return {
    text: `INSERT INTO ${match[1]} (${columns}) VALUES (${placeholders}) RETURNING id`,
    values: keys.map((key) => normalizedData[key]),
  };
}

function rewriteUpdateSet(sql, params) {
  const match = sql.match(/^\s*UPDATE\s+([\w."]+)\s+SET\s+\?\s+WHERE\s+([\s\S]+?)\s*;?\s*$/i);
  const data = Array.isArray(params) ? params[0] : null;
  if (!match || !data || typeof data !== 'object' || Array.isArray(data)) return null;

  const normalizedData = normalizeDataValues(data);
  const keys = Object.keys(normalizedData);
  if (!keys.length) throw new Error('UPDATE data cannot be empty');

  const setClause = keys
    .map((key, index) => `${quoteIdentifier(key)} = $${index + 1}`)
    .join(', ');

  const whereClause = replacePositionalParams(match[2], keys.length + 1);

  return {
    text: `UPDATE ${match[1]} SET ${setClause} WHERE ${whereClause}`,
    values: [...keys.map((key) => normalizedData[key]), ...params.slice(1)],
  };
}

function normalizeQuery(sql, params = []) {
  const rewritten = rewriteInsertSet(sql, params) || rewriteUpdateSet(sql, params);
  const text = normalizeBooleanLiteralSql(normalizeIntervalSql(
    (rewritten?.text || sql)
      .replace(/\bNOW\(\)/gi, 'CURRENT_TIMESTAMP')
      .replace(/\bCURDATE\(\)/gi, 'CURRENT_DATE')
      .replace(/\bCURTIME\(\)/gi, 'CURRENT_TIME')
  ));

  return {
    text: rewritten ? text : replacePositionalParams(text),
    values: rewritten?.values || params,
  };
}

async function query(sql, params = []) {
  const { text, values } = normalizeQuery(sql, params);
  const result = await nativePool.query(text, values);

  if (result.command === 'SELECT' || result.command === 'WITH') {
    return [result.rows];
  }

  return [{
    affectedRows: result.rowCount,
    insertId: result.rows?.[0]?.id,
    rows: result.rows,
    rowCount: result.rowCount,
  }];
}

const pool = {
  query,
  end: () => nativePool.end(),
};

const connectDB = async () => {
  try {
    const client = await nativePool.connect();
    await client.query('SELECT 1');
    console.log('PostgreSQL connected');
    client.release();
  } catch (error) {
    console.error('PostgreSQL connection error:', error);
    process.exit(1);
  }
};

module.exports = { connectDB, pool, nativePool };
