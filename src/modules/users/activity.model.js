const { pool } = require('../../config/db');

const ActivityLog = {
  async findOneAndUpdate(where, data, opts = {}) {
    const [rows] = await pool.query(
      'SELECT * FROM activity_logs WHERE user_id = ? AND date = ?',
      [where.user_id, where.date]
    );
    if (rows[0]) {
      await pool.query('UPDATE activity_logs SET ? WHERE user_id = ? AND date = ?', [data, where.user_id, where.date]);
      return ActivityLog._findOne(where);
    } else if (opts.upsert) {
      const [result] = await pool.query('INSERT INTO activity_logs SET ?', [{ ...where, ...data }]);
      return { id: result.insertId, ...where, ...data };
    }
    return null;
  },
  async find(where = {}) {
    if (Object.keys(where).length === 0) {
      const [rows] = await pool.query('SELECT * FROM activity_logs ORDER BY date DESC');
      return rows;
    }
    const key = Object.keys(where)[0];
    const [rows] = await pool.query(`SELECT * FROM activity_logs WHERE ${key} = ? ORDER BY date DESC`, [where[key]]);
    return rows;
  },
  async _findOne(where) {
    const [rows] = await pool.query(
      'SELECT * FROM activity_logs WHERE user_id = ? AND date = ?',
      [where.user_id, where.date]
    );
    return rows[0] || null;
  }
};

module.exports = ActivityLog;
