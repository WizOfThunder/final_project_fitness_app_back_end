const { pool } = require('../../config/db');

function formatDateOnly(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
    2,
    '0'
  )}-${String(date.getDate()).padStart(2, '0')}`;
}

function normalizeDob(value) {
  if (!value) return value;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : formatDateOnly(value);
  }

  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return formatDateOnly(parsed);
  }

  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : value;
}

function normalizeUserRow(row) {
  if (!row) return row;

  return {
    ...row,
    dob: normalizeDob(row.dob),
  };
}

const User = {
  async findPendingTrainers() {
    const [rows] = await pool.query(
      "SELECT * FROM users WHERE role = 'trainer' AND certification_status = 'pending' AND is_active = TRUE"
    );
    return rows.map(normalizeUserRow);
  },
  async findById(id) {
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [id]);
    return normalizeUserRow(rows[0]) || null;
  },
  async findOne(where) {
    const key = Object.keys(where)[0];
    const [rows] = await pool.query(`SELECT * FROM users WHERE ${key} = ?`, [where[key]]);
    return normalizeUserRow(rows[0]) || null;
  },
  async find(where = {}) {
    if (Object.keys(where).length === 0) {
      const [rows] = await pool.query('SELECT * FROM users');
      return rows.map(normalizeUserRow);
    }
    const key = Object.keys(where)[0];
    const [rows] = await pool.query(`SELECT * FROM users WHERE ${key} = ?`, [where[key]]);
    return rows.map(normalizeUserRow);
  },
  async create(data) {
    const [result] = await pool.query('INSERT INTO users SET ?', [data]);
    return normalizeUserRow({ id: result.insertId, ...data });
  },
  async findByIdAndUpdate(id, data) {
    await pool.query('UPDATE users SET ? WHERE id = ?', [data, id]);
    return User.findById(id);
  }
};

module.exports = User;
