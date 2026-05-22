const { pool } = require('../../config/db');

const Chat = {
  async find(where = {}) {
    if (where.$or) {
      const [[c1, c2]] = [where.$or];
      const [rows] = await pool.query(
        `SELECT c.id, c.sender_id, c.receiver_id, c.message, c.is_read,
          c.created_at,
          s.name as sender_name, s.email as sender_email,
          r.name as receiver_name, r.email as receiver_email
         FROM chats c
         JOIN users s ON s.id = c.sender_id
         JOIN users r ON r.id = c.receiver_id
         WHERE (c.sender_id = ? AND c.receiver_id = ?) OR (c.sender_id = ? AND c.receiver_id = ?)
         ORDER BY c.created_at ASC`,
        [c1.sender_id, c1.receiver_id, c2.sender_id, c2.receiver_id]
      );
      return rows;
    }
    const key = Object.keys(where)[0];
    const [rows] = await pool.query(`SELECT * FROM chats WHERE ${key} = ?`, [where[key]]);
    return rows;
  },
  async findById(id) {
    const [[row]] = await pool.query(
      `SELECT id, sender_id, receiver_id, message, is_read,
              created_at
        FROM chats WHERE id = ?`,
      [id]
    );
    return row || null;
  },
  async getConversations(userId) {
    const [rows] = await pool.query(
      `SELECT 
        CASE WHEN c.sender_id = ? THEN c.receiver_id ELSE c.sender_id END as other_user_id,
        c.id, c.sender_id, c.receiver_id, c.message, c.is_read,
        c.created_at,
        u.name as other_name, u.email as other_email
       FROM chats c
       JOIN users u ON u.id = CASE WHEN c.sender_id = ? THEN c.receiver_id ELSE c.sender_id END
       WHERE c.id IN (
          SELECT MAX(id) FROM chats
          WHERE sender_id = ? OR receiver_id = ?
          GROUP BY CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END
        )
        ORDER BY c.created_at DESC`,
      [userId, userId, userId, userId, userId]
    );
    return rows;
  },
  async create(data) {
    const [result] = await pool.query('INSERT INTO chats SET ?', [data]);
    return Chat.findById(result.insertId);
  },
  async updateMany(where, update) {
    await pool.query(
      'UPDATE chats SET is_read = ? WHERE sender_id = ? AND receiver_id = ? AND is_read = ?',
      [update.is_read, where.sender_id, where.receiver_id, false]
    );
  }
};

module.exports = Chat;
