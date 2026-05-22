const { pool } = require('../../config/db');

const Payment = {
  async create(data) {
    const [result] = await pool.query('INSERT INTO payments SET ?', [data]);
    return { id: result.insertId, ...data };
  },
  async findOne(where) {
    const key = Object.keys(where)[0];
    const [rows] = await pool.query(`SELECT * FROM payments WHERE ${key} = ?`, [where[key]]);
    return rows[0] || null;
  },
  async findOneAndUpdate(where, data) {
    const key = Object.keys(where)[0];
    await pool.query(`UPDATE payments SET ? WHERE ${key} = ?`, [data, where[key]]);
    return Payment.findOne(where);
  },
  async find(where = {}) {
    if (Object.keys(where).length === 0) {
      const [rows] = await pool.query('SELECT * FROM payments ORDER BY created_at DESC');
      return rows;
    }
    const key = Object.keys(where)[0];
    const [rows] = await pool.query(`SELECT * FROM payments WHERE ${key} = ? ORDER BY created_at DESC`, [where[key]]);
    return rows;
  }
};

module.exports = Payment;
