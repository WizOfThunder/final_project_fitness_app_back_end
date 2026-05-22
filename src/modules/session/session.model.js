const { pool } = require('../../config/db');

const DAY_MAP = {
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
  Sunday: 0,
};
const WIB_CURRENT_DATE_SQL = `(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')::date`;

function parseDateOnly(value) {
  if (value instanceof Date) {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }

  const stringValue = String(value || '');
  const match = stringValue.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }

  const parsed = new Date(stringValue);
  if (Number.isNaN(parsed.getTime())) {
    return new Date(NaN);
  }

  return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
}

function formatDateOnly(value) {
  const date = parseDateOnly(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function normalizeScheduledDate(value, scheduledDay) {
  const date = parseDateOnly(value);
  if (Number.isNaN(date.getTime())) return value;

  const targetDay = DAY_MAP[scheduledDay];
  if (targetDay === undefined) return formatDateOnly(date);

  const actualDay = date.getDay();
  const rawDiff = (targetDay - actualDay + 7) % 7;
  const diff = rawDiff > 3 ? rawDiff - 7 : rawDiff;

  // Old sessions may be shifted by one day because they were saved via UTC date formatting.
  if (diff !== 0 && Math.abs(diff) <= 1) {
    date.setDate(date.getDate() + diff);
  }

  return formatDateOnly(date);
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

const Session = {
  // Generate sessions for a hire based on the post's schedule for the hire's month
  async generateForHire(hireId, postSchedule, startDate, endDate) {
    const start = parseDateOnly(startDate);
    const end = parseDateOnly(endDate);

    const sessions = [];
    const cursor = new Date(start);
    while (cursor <= end) {
      const dayNum = cursor.getDay();
      for (const slot of postSchedule) {
        if (DAY_MAP[slot.day] === dayNum) {
          sessions.push({
            hire_id: hireId,
            scheduled_date: formatDateOnly(cursor),
            scheduled_day: slot.day,
            scheduled_start: slot.start,
            status: 'upcoming',
          });
        }
      }
      cursor.setDate(cursor.getDate() + 1);
    }

    for (const s of sessions) {
      await pool.query('INSERT INTO hire_sessions SET ?', [s]);
    }
    return sessions.length;
  },

  async findByHire(hireId) {
    const [rows] = await pool.query(
      `SELECT hs.*
       FROM hire_sessions hs
       JOIN trainer_hires th ON th.id = hs.hire_id
       WHERE hs.hire_id = ?
         AND hs.scheduled_date <= th.end_date
       ORDER BY hs.scheduled_date, hs.scheduled_start`,
      [hireId]
    );
    return rows.map(row => ({
      ...row,
      scheduled_date: normalizeScheduledDate(row.scheduled_date, row.scheduled_day),
    }));
  },

  async findById(id) {
    const [[row]] = await pool.query('SELECT * FROM hire_sessions WHERE id = ?', [id]);
    if (!row) return null;
    return {
      ...row,
      scheduled_date: normalizeScheduledDate(row.scheduled_date, row.scheduled_day),
    };
  },

  // Trainer starts a session — generates a 6-digit code valid for 30 minutes
  async trainerStart(sessionId, trainerId) {
    // Verify trainer owns this session via hire → post
    const [[row]] = await pool.query(
      `SELECT hs.*, tp.trainer_id, tp.schedule
       FROM hire_sessions hs
       JOIN trainer_hires th ON th.id = hs.hire_id
       JOIN trainer_posts tp ON tp.id = th.post_id
       WHERE hs.id = ?`,
      [sessionId]
    );
    if (!row) return null;
    if (row.trainer_id !== trainerId) return null;
    if (row.status !== 'upcoming') return null;

    const code = generateCode();
    const expires = new Date(Date.now() + 30 * 60 * 1000); // 30 min
    await pool.query(
      "UPDATE hire_sessions SET status='started', confirm_code=?, code_expires_at=?, trainer_started_at=CURRENT_TIMESTAMP WHERE id=?",
      [code, expires, sessionId]
    );
    return code;
  },

  // Member confirms attendance with the code
  async memberConfirm(sessionId, memberId, code) {
    const [[row]] = await pool.query(
      `SELECT hs.*, th.member_id
       FROM hire_sessions hs
       JOIN trainer_hires th ON th.id = hs.hire_id
       WHERE hs.id = ?`,
      [sessionId]
    );
    if (!row) return { ok: false, error: 'Session not found' };
    if (row.member_id !== memberId) return { ok: false, error: 'Not your session' };
    if (row.status !== 'started') return { ok: false, error: 'Session not started by trainer yet' };
    if (row.confirm_code !== code) return { ok: false, error: 'Incorrect code' };
    if (new Date(row.code_expires_at) < new Date()) return { ok: false, error: 'Code has expired' };

    await pool.query(
      "UPDATE hire_sessions SET status='confirmed', member_confirmed_at=CURRENT_TIMESTAMP WHERE id=?",
      [sessionId]
    );
    return { ok: true };
  },

  // Mark overdue started sessions as missed (called by cron)
  async markMissed() {
    await pool.query(
      `UPDATE hire_sessions hs
       SET status = 'missed'
       FROM trainer_hires th
       WHERE hs.status='upcoming'
         AND th.id = hs.hire_id
          AND hs.scheduled_date < ${WIB_CURRENT_DATE_SQL}
          AND hs.scheduled_date <= th.end_date`
    );
    // Also expire started sessions where code expired and member never confirmed
    await pool.query(
      `UPDATE hire_sessions hs
       SET status = 'missed'
       FROM trainer_hires th
       WHERE hs.status='started'
         AND th.id = hs.hire_id
         AND hs.code_expires_at < CURRENT_TIMESTAMP
         AND hs.scheduled_date <= th.end_date`
    );
  },

  async getStats(hireId) {
    const [[stats]] = await pool.query(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE hs.status = 'confirmed') AS confirmed,
         COUNT(*) FILTER (WHERE hs.status = 'missed') AS missed,
         COUNT(*) FILTER (WHERE hs.status IN ('upcoming','started')) AS upcoming
        FROM hire_sessions hs
        JOIN trainer_hires th ON th.id = hs.hire_id
        WHERE hs.hire_id = ?
          AND hs.scheduled_date <= th.end_date`,
      [hireId]
    );
    return stats;
  },

  async hasReachedFirstSession(hireId) {
    const [[row]] = await pool.query(
      `SELECT 1 AS reached
       FROM hire_sessions hs
       JOIN trainer_hires th ON th.id = hs.hire_id
       WHERE hs.hire_id = ?
          AND hs.scheduled_date <= LEAST(${WIB_CURRENT_DATE_SQL}, th.end_date)
       LIMIT 1`,
      [hireId]
    );
    return !!row;
  },

  async trimFutureSessions(hireId) {
    await pool.query(
      `DELETE FROM hire_sessions hs
       USING trainer_hires th
       WHERE hs.hire_id = ?
         AND th.id = hs.hire_id
         AND hs.scheduled_date > th.end_date`,
      [hireId]
    );
  },

  async setNote(sessionId, trainerId, note) {
    const [[row]] = await pool.query(
      `SELECT hs.id, hs.status, tp.trainer_id
       FROM hire_sessions hs
       JOIN trainer_hires th ON th.id = hs.hire_id
       JOIN trainer_posts tp ON tp.id = th.post_id
       WHERE hs.id = ?`,
      [sessionId]
    );
    if (!row || row.trainer_id !== trainerId) return false;
    await pool.query('UPDATE hire_sessions SET trainer_note = ? WHERE id = ?', [note || null, sessionId]);
    return true;
  },
};

const Dispute = {
  async create(data) {
    const [result] = await pool.query('INSERT INTO hire_disputes SET ?', [data]);
    return { id: result.insertId, ...data };
  },
  async findLatestByHire(hireId) {
    const [[row]] = await pool.query(
      'SELECT * FROM hire_disputes WHERE hire_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
      [hireId]
    );
    return row || null;
  },
  async findOpenByHire(hireId) {
    const [[row]] = await pool.query(
      "SELECT * FROM hire_disputes WHERE hire_id = ? AND status = 'open' ORDER BY created_at DESC, id DESC LIMIT 1",
      [hireId]
    );
    return row || null;
  },
  async findAllOpen() {
    const [rows] = await pool.query(
      `SELECT hd.*, th.post_id,
              m.name AS member_name, m.email AS member_email,
              t.name AS trainer_name,
              tp.title AS post_title,
              (SELECT COUNT(*) FROM hire_sessions WHERE hire_id = hd.hire_id AND status = 'confirmed') AS sessions_confirmed,
              (SELECT COUNT(*) FROM hire_sessions WHERE hire_id = hd.hire_id) AS sessions_total
       FROM hire_disputes hd
       JOIN trainer_hires th ON th.id = hd.hire_id
       JOIN trainer_posts tp ON tp.id = th.post_id
       JOIN users m ON m.id = hd.member_id
       JOIN users t ON t.id = tp.trainer_id
       WHERE hd.status = 'open'
       ORDER BY hd.created_at DESC`
    );
    return rows;
  },
  async resolve(id, adminId, status, note) {
    const [result] = await pool.query(
      "UPDATE hire_disputes SET status=?, admin_note=?, resolved_by=?, resolved_at=CURRENT_TIMESTAMP WHERE id=? AND status = 'open'",
      [status, note || null, adminId, id]
    );
    return result.affectedRows > 0;
  },
};

module.exports = { Session, Dispute };
