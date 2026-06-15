const { pool } = require('../../config/db');

const WIB_CURRENT_DATE_SQL = `(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')::date`;
const WIB_CURRENT_TIME_SQL = `(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')::time`;

function formatDateOnly(value) {
  if (!value) return value;

  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }

  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) {
    return match[1];
  }

  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`;
  }

  return value;
}

function normalizeChallengeRow(row) {
  if (!row) return row;

  return {
    ...row,
    start_date: formatDateOnly(row.start_date),
    end_date: formatDateOnly(row.end_date),
  };
}

const Challenge = {
  async find() {
    const [rows] = await pool.query(
      `SELECT c.*, u.name as creator_name, u.role as creator_role,
               COUNT(uc.id) as participant_count
       FROM challenges c
       JOIN users u ON u.id = c.created_by
       LEFT JOIN user_challenges uc ON uc.challenge_id = c.id
       WHERE c.status = 'active'
          AND (
            (
              c.challenge_type = 'auto'
              AND c.end_date >= ${WIB_CURRENT_DATE_SQL}
            )
            OR (
              c.challenge_type <> 'auto'
              AND (
                c.end_date > ${WIB_CURRENT_DATE_SQL}
                OR (
                  c.end_date = ${WIB_CURRENT_DATE_SQL}
                  AND (
                    c.event_end_time IS NULL
                    OR c.event_end_time >= ${WIB_CURRENT_TIME_SQL}
                  )
                )
              )
             )
           )
         GROUP BY c.id, u.id
         HAVING c.max_participants IS NULL OR COUNT(uc.id) < c.max_participants
         ORDER BY c.start_date ASC`
    );
    return rows.map(normalizeChallengeRow);
  },
  async findCreated(userId, role) {
    if (role === 'admin') {
      const [rows] = await pool.query(
        `SELECT c.*, u.name as creator_name, u.role as creator_role
         FROM challenges c JOIN users u ON u.id = c.created_by
         ORDER BY c.start_date DESC`
      );
      return rows.map(normalizeChallengeRow);
    }
    const [rows] = await pool.query(
      `SELECT c.*, u.name as creator_name, u.role as creator_role
       FROM challenges c JOIN users u ON u.id = c.created_by
       WHERE c.created_by = ?
       ORDER BY c.start_date DESC`,
      [userId]
    );
    return rows.map(normalizeChallengeRow);
  },
  async findById(id) {
    const [[row]] = await pool.query('SELECT * FROM challenges WHERE id = ?', [id]);
    return normalizeChallengeRow(row) || null;
  },
  async create(data) {
    const [result] = await pool.query('INSERT INTO challenges SET ?', [data]);
    return normalizeChallengeRow({ id: result.insertId, ...data });
  },
};

const UserChallenge = {
  async find(where = {}) {
    const ALLOWED_KEYS = ['user_id', 'challenge_id', 'status'];
    if (Object.keys(where).length === 0) {
      const [rows] = await pool.query(
        `SELECT uc.*, c.title, c.type, c.challenge_type, c.target_value, c.start_date, c.end_date, c.description, c.url,
                c.event_start_time, c.event_end_time, c.location, c.points
         FROM user_challenges uc JOIN challenges c ON c.id = uc.challenge_id`
      );
      return rows.map(normalizeChallengeRow);
    }
    const key = Object.keys(where)[0];
    if (!ALLOWED_KEYS.includes(key)) throw new Error(`Invalid filter key: ${key}`);
    const [rows] = await pool.query(
      `SELECT uc.*, c.title, c.type, c.challenge_type, c.target_value, c.start_date, c.end_date, c.description, c.url,
              c.event_start_time, c.event_end_time, c.location, c.points,
              EXISTS(
                SELECT 1 FROM completion_requests cr
                WHERE cr.user_challenge_id = uc.id AND cr.status = 'pending'
              ) as has_pending_request
       FROM user_challenges uc JOIN challenges c ON c.id = uc.challenge_id
       WHERE uc.${key} = ?`,
      [where[key]]
    );
    return rows.map(normalizeChallengeRow);
  },
  async create(data) {
    const [result] = await pool.query('INSERT INTO user_challenges SET ?', [data]);
    return { id: result.insertId, ...data };
  },
  async findById(id) {
    const [[row]] = await pool.query('SELECT * FROM user_challenges WHERE id = ?', [id]);
    return row || null;
  },
  async findByUserAndChallenge(userId, challengeId) {
    const [[row]] = await pool.query(
      'SELECT id FROM user_challenges WHERE user_id = ? AND challenge_id = ?',
      [userId, challengeId]
    );
    return row || null;
  },
  async complete(id) {
    await pool.query(
      "UPDATE user_challenges SET status = 'completed' WHERE id = ?", [id]
    );
  },
  async findActiveAuto() {
    const [rows] = await pool.query(
      `SELECT uc.id as user_challenge_id, uc.user_id, uc.current_value,
              c.id as challenge_id, c.type, c.target_value, c.start_date, c.end_date
       FROM user_challenges uc
       JOIN challenges c ON c.id = uc.challenge_id
       WHERE uc.status = 'active'
         AND c.challenge_type = 'auto'
          AND c.end_date >= ${WIB_CURRENT_DATE_SQL}`
    );
    return rows.map(normalizeChallengeRow);
  },
  async updateProgress(id, value) {
    await pool.query(
      'UPDATE user_challenges SET current_value = ? WHERE id = ?', [value, id]
    );
  },
};

const CompletionRequest = {
  async create(data) {
    const [result] = await pool.query('INSERT INTO completion_requests SET ?', [data]);
    return { id: result.insertId, ...data };
  },
  async findPending() {
    const [rows] = await pool.query(
      `SELECT cr.*, u.name as member_name,
              c.title as challenge_title, c.challenge_type, c.url as challenge_url,
              c.start_date, c.end_date, c.event_start_time, c.event_end_time
       FROM completion_requests cr
       JOIN users u ON u.id = cr.user_id
       JOIN challenges c ON c.id = cr.challenge_id
        WHERE cr.status = 'pending'
        ORDER BY cr.created_at ASC`
    );
    return rows.map(normalizeChallengeRow);
  },
  async findById(id) {
    const [[row]] = await pool.query('SELECT * FROM completion_requests WHERE id = ?', [id]);
    return row || null;
  },
  async review(id, status, reviewedBy) {
    await pool.query(
      'UPDATE completion_requests SET status = ?, reviewed_by = ?, reviewed_at = NOW() WHERE id = ?',
      [status, reviewedBy, id]
    );
  },
  async existsPending(userChallengeId) {
    const [[row]] = await pool.query(
      "SELECT id FROM completion_requests WHERE user_challenge_id = ? AND status = 'pending'",
      [userChallengeId]
    );
    return !!row;
  },
};

module.exports = { Challenge, UserChallenge, CompletionRequest, normalizeChallengeRow };
