const { pool } = require('../../config/db');

const Achievement = {
  async find() {
    const [rows] = await pool.query('SELECT * FROM achievements WHERE is_active = TRUE ORDER BY rule_type, rule_value');
    return rows;
  },
  async findAll() {
    const [rows] = await pool.query('SELECT * FROM achievements ORDER BY rule_type, rule_value');
    return rows;
  },
  async create(data) {
    const [result] = await pool.query('INSERT INTO achievements SET ?', [data]);
    return { id: result.insertId, ...data };
  },
  async update(id, data) {
    await pool.query('UPDATE achievements SET ? WHERE id = ?', [data, id]);
    const [[row]] = await pool.query('SELECT * FROM achievements WHERE id = ?', [id]);
    return row;
  },
  async softDelete(id) {
    await pool.query('UPDATE achievements SET is_active = FALSE WHERE id = ?', [id]);
  },
  async restore(id) {
    await pool.query('UPDATE achievements SET is_active = TRUE WHERE id = ?', [id]);
  },
};

const UserAchievement = {
  async find(where = {}) {
    if (Object.keys(where).length === 0) {
      const [rows] = await pool.query(
        `SELECT ua.*, a.title, a.description, a.rule_type, a.rule_value
         FROM user_achievements ua JOIN achievements a ON a.id = ua.achievement_id
         WHERE a.is_active = TRUE`
      );
      return rows;
    }
    const key = Object.keys(where)[0];
    const [rows] = await pool.query(
      `SELECT ua.*, a.title, a.description, a.rule_type, a.rule_value
       FROM user_achievements ua JOIN achievements a ON a.id = ua.achievement_id
       WHERE ua.${key} = ? AND a.is_active = TRUE`,
      [where[key]]
    );
    return rows;
  },
  async aggregate() {
    const [rows] = await pool.query(
      `SELECT ua.user_id, COUNT(*) as count, u.name, u.email
       FROM user_achievements ua
       JOIN users u ON u.id = ua.user_id
       JOIN achievements a ON a.id = ua.achievement_id
       WHERE a.is_active = TRUE
       GROUP BY ua.user_id, u.id
       ORDER BY count DESC
       LIMIT 10`
    );
    return rows;
  }
};

module.exports = { Achievement, UserAchievement };
