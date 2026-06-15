const { pool } = require('../../config/db');

const Announcement = {
  async create(data) {
    const [result] = await pool.query('INSERT INTO post_announcements SET ?', [data]);
    const [[row]] = await pool.query(
      `SELECT pa.*, u.name AS trainer_name
       FROM post_announcements pa
       JOIN users u ON u.id = pa.trainer_id
       WHERE pa.id = ?`,
      [result.insertId],
    );
    return row;
  },
  async findByPost(postId) {
    const [rows] = await pool.query(
      `SELECT pa.*, u.name AS trainer_name
       FROM post_announcements pa
       JOIN users u ON u.id = pa.trainer_id
       WHERE pa.post_id = ?
       ORDER BY pa.created_at DESC`,
      [postId]
    );
    return rows;
  },
  async findMemberTokens(postId) {
    const [rows] = await pool.query(
      `SELECT u.fcm_token, u.id AS user_id
       FROM trainer_hires th
       JOIN users u ON u.id = th.member_id
       WHERE th.post_id = ? AND th.status IN ('active','enrolled') AND u.fcm_token IS NOT NULL AND u.fcm_token != ''`,
      [postId]
    );
    return rows;
  },
  async verifyTrainer(postId, trainerId) {
    const [[row]] = await pool.query(
      `SELECT id FROM trainer_posts WHERE id = ? AND trainer_id = ? AND visibility = 'public'`,
      [postId, trainerId]
    );
    return !!row;
  },
  async verifyMember(postId, memberId) {
    const [[row]] = await pool.query(
      `SELECT th.id FROM trainer_hires th
       WHERE th.post_id = ? AND th.member_id = ? AND th.status IN ('active','enrolled')`,
      [postId, memberId]
    );
    return !!row;
  },
};

module.exports = Announcement;
