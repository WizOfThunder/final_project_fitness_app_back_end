const { pool } = require('../../config/db');

function resolvePaymentStatus(currentStatus, nextStatus) {
  if (!nextStatus) {
    return currentStatus || null;
  }

  if (!currentStatus || currentStatus === nextStatus) {
    return nextStatus;
  }

  if (
    ['refunded', 'partial_refund'].includes(currentStatus) &&
    ['pending', 'settlement'].includes(nextStatus)
  ) {
    return currentStatus;
  }

  return nextStatus;
}

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
    const current = await Payment.findOne(where);
    const nextData = {...data};

    if (Object.prototype.hasOwnProperty.call(nextData, 'status')) {
      nextData.status = resolvePaymentStatus(current?.status, nextData.status);
    }

    await pool.query(`UPDATE payments SET ? WHERE ${key} = ?`, [nextData, where[key]]);
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
