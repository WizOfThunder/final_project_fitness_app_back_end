const { pool } = require('../../config/db');

const ValidationLog = {
  async create(data) {
    const [result] = await pool.query('INSERT INTO ai_validation_logs SET ?', [data]);
    return { id: result.insertId, ...data };
  }
};

module.exports = ValidationLog;
