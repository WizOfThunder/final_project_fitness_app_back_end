const { Pool, types } = require('pg');

types.setTypeParser(types.builtins.INT8, (value) => Number(value));
types.setTypeParser(types.builtins.NUMERIC, (value) => Number(value));

const CONNECTION_STRING_ENV_KEYS = [
  'DATABASE_URL',
  'DATABASE_PRIVATE_URL',
  'DATABASE_PUBLIC_URL',
  'POSTGRES_URL',
  'POSTGRES_PRIVATE_URL',
  'POSTGRES_PUBLIC_URL',
  'POSTGRESQL_URL',
];

const DB_HOST_ENV_KEYS = ['DB_HOST', 'PGHOST', 'POSTGRES_HOST'];
const DB_PORT_ENV_KEYS = ['DB_PORT', 'PGPORT', 'POSTGRES_PORT'];
const DB_USER_ENV_KEYS = ['DB_USER', 'PGUSER', 'POSTGRES_USER'];
const DB_PASSWORD_ENV_KEYS = ['DB_PASSWORD', 'PGPASSWORD', 'POSTGRES_PASSWORD'];
const DB_NAME_ENV_KEYS = ['DB_NAME', 'PGDATABASE', 'POSTGRES_DB'];

function normalizeEnvValue(value) {
  if (typeof value !== 'string') return undefined;

  const trimmed = value.trim();
  if (!trimmed) return undefined;

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

function getEnvValue(keys) {
  for (const key of keys) {
    const value = normalizeEnvValue(process.env[key]);
    if (value) {
      return value;
    }
  }

  return undefined;
}

function hasEnvValue(key) {
  return Boolean(normalizeEnvValue(process.env[key]));
}

function getPresentEnvKeys(keys) {
  return keys.filter(hasEnvValue);
}

const CONNECTION_STRING = getEnvValue(CONNECTION_STRING_ENV_KEYS);

const DEFAULT_DB_NAME = getEnvValue(DB_NAME_ENV_KEYS) || 'fitdaptive';
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

function isRailwayRuntime() {
  return Boolean(
    process.env.RAILWAY_ENVIRONMENT_ID
    || process.env.RAILWAY_PROJECT_ID
    || process.env.RAILWAY_SERVICE_ID
  );
}

function hasExplicitDbConfig() {
  return Boolean(
    CONNECTION_STRING
    || getEnvValue(DB_HOST_ENV_KEYS)
    || getEnvValue(DB_PORT_ENV_KEYS)
    || getEnvValue(DB_USER_ENV_KEYS)
    || getEnvValue(DB_PASSWORD_ENV_KEYS)
    || getEnvValue(DB_NAME_ENV_KEYS)
  );
}

function getDbEnvDiagnostics() {
  return {
    railwayRuntime: isRailwayRuntime(),
    railwayProjectName: process.env.RAILWAY_PROJECT_NAME || null,
    railwayEnvironmentName: process.env.RAILWAY_ENVIRONMENT_NAME || null,
    railwayServiceName: process.env.RAILWAY_SERVICE_NAME || null,
    railwayDeploymentId: process.env.RAILWAY_DEPLOYMENT_ID || null,
    nodeEnv: process.env.NODE_ENV || null,
    presentConnectionStringKeys: getPresentEnvKeys(CONNECTION_STRING_ENV_KEYS),
    presentHostKeys: getPresentEnvKeys(DB_HOST_ENV_KEYS),
    presentPortKeys: getPresentEnvKeys(DB_PORT_ENV_KEYS),
    presentUserKeys: getPresentEnvKeys(DB_USER_ENV_KEYS),
    presentPasswordKeys: getPresentEnvKeys(DB_PASSWORD_ENV_KEYS),
    presentNameKeys: getPresentEnvKeys(DB_NAME_ENV_KEYS),
  };
}

function getConnectionStringEndpoint() {
  if (!CONNECTION_STRING) return null;

  try {
    const parsed = new URL(CONNECTION_STRING);
    return {
      hostname: parsed.hostname,
      port: parsed.port || '5432',
    };
  } catch {
    return null;
  }
}

function isSupabaseDirectIpv6Issue(error) {
  const endpoint = getConnectionStringEndpoint();

  return Boolean(
    error?.code === 'ENETUNREACH'
    && endpoint
    && endpoint.port === '5432'
    && /^db\..+\.supabase\.co$/i.test(endpoint.hostname)
  );
}

function isMalformedConnectionString(error) {
  return error?.code === 'ERR_INVALID_URL' && Boolean(CONNECTION_STRING);
}

function createPoolConfig() {
  const ssl = shouldUseSsl() ? { rejectUnauthorized: false } : false;

  if (CONNECTION_STRING) {
    return {
      config: {
        connectionString: CONNECTION_STRING,
        max: Number(process.env.DB_POOL_SIZE || 10),
        ssl,
      },
      source: 'connection string env',
      isFallbackLocalhost: false,
    };
  }

  const hasExplicitConfig = hasExplicitDbConfig();

  return {
    config: {
      host: getEnvValue(DB_HOST_ENV_KEYS) || 'localhost',
      port: Number(getEnvValue(DB_PORT_ENV_KEYS) || 5432),
      user: getEnvValue(DB_USER_ENV_KEYS) || 'postgres',
      password: getEnvValue(DB_PASSWORD_ENV_KEYS) || '',
      database: DEFAULT_DB_NAME,
      max: Number(process.env.DB_POOL_SIZE || 10),
      ssl,
    },
    source: hasExplicitConfig ? 'discrete DB env vars' : 'localhost fallback',
    isFallbackLocalhost: !hasExplicitConfig,
  };
}

const poolSetup = createPoolConfig();
const nativePool = new Pool(poolSetup.config);

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
  if (poolSetup.isFallbackLocalhost && (process.env.NODE_ENV === 'production' || isRailwayRuntime())) {
    console.error('[DB] Env diagnostics:', JSON.stringify(getDbEnvDiagnostics()));
    console.error(
      '[DB] Missing PostgreSQL environment variables. '
      + 'If you use an external database such as Supabase, set DATABASE_URL directly '
      + 'in the backend service variables. If you use a Railway Postgres service, '
      + 'add DATABASE_URL=${{Postgres.DATABASE_URL}} or reference PGHOST, PGPORT, '
      + 'PGUSER, PGPASSWORD, and PGDATABASE into the backend service variables. '
      + 'Local .env files are not loaded in Railway deployments.'
    );
    process.exit(1);
  }

  console.log(`[DB] Config source: ${poolSetup.source}`);

  try {
    const client = await nativePool.connect();
    await client.query('SELECT 1');
    console.log('PostgreSQL connected');
    client.release();
  } catch (error) {
    if (isMalformedConnectionString(error)) {
      console.error(
        '[DB] DATABASE_URL is present but malformed. Use a plain Postgres URL such as '
        + 'postgres://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres '
        + 'or postgresql://... . Do not include labels, angle brackets, or placeholder text.'
      );
    }

    if (isSupabaseDirectIpv6Issue(error)) {
      console.error(
        '[DB] Supabase direct connection resolved to IPv6 and is unreachable from this runtime. '
        + 'Use the Supabase Session pooler connection string for IPv4-compatible app traffic, '
        + 'or purchase the Supabase IPv4 add-on for direct connections.'
      );
    }

    console.error('PostgreSQL connection error:', error);
    process.exit(1);
  }
};

module.exports = { connectDB, pool, nativePool };
