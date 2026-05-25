const { pool } = require('../../config/db');
const { Session } = require('../session/session.model');

const TRAINER_RESPONSE_SECONDS_SQL = `
  CASE
    WHEN th.trainer_response_deadline IS NULL THEN NULL
    ELSE GREATEST(EXTRACT(EPOCH FROM (th.trainer_response_deadline - CURRENT_TIMESTAMP))::int, 0)
  END
`;
const WIB_CURRENT_DATE_SQL = `(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')::date`;
const WIB_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Jakarta',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function formatWibDate(date) {
  const parts = Object.fromEntries(
    WIB_DATE_FORMATTER.formatToParts(date).map((part) => [part.type, part.value])
  );

  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getDateOnlyString(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatWibDate(value);
  }

  const stringValue = String(value);
  const directMatch = stringValue.match(/^(\d{4}-\d{2}-\d{2})/);
  if (directMatch) return directMatch[1];

  const parsed = new Date(stringValue);
  if (!Number.isNaN(parsed.getTime())) {
    return formatWibDate(parsed);
  }

  return stringValue;
}

function getCurrentWibDateString() {
  return formatWibDate(new Date());
}

function addMonthsToDateString(dateString, months) {
  const [year, month, day] = getDateOnlyString(dateString).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().split('T')[0];
}

const TrainerPost = {
  async findAllAdmin() {
    const [rows] = await pool.query(
      `SELECT tp.*, u.name AS trainer_name, u.avatar_url,
        ROUND(AVG(tr.rating), 1) AS avg_rating,
        COUNT(DISTINCT tr.id) AS review_count,
        COUNT(DISTINCT CASE WHEN th.status IN ('pending_payment','pending_approval','enrolled','active') THEN th.id END) AS current_slots,
        COUNT(DISTINCT th.id) AS total_hires
       FROM trainer_posts tp
       JOIN users u ON u.id = tp.trainer_id
       LEFT JOIN trainer_reviews tr ON tr.post_id = tp.id
       LEFT JOIN trainer_hires th ON th.post_id = tp.id
       GROUP BY tp.id, u.id
       ORDER BY tp.created_at DESC`
    );
    return rows.map(r => ({...r, schedule: r.schedule ? JSON.parse(r.schedule) : []}));
  },
  async findAll(requestingUserId) {
    const [rows] = await pool.query(
      `SELECT tp.*, u.name AS trainer_name, u.avatar_url,
         u.phone_number AS trainer_phone_number,
         u.height AS trainer_height,
         u.weight AS trainer_weight,
         u.gender AS trainer_gender,
         u.dob AS trainer_dob,
          ROUND(AVG(tr.rating), 1) AS avg_rating,
          COUNT(DISTINCT tr.id) AS review_count,
          COUNT(DISTINCT CASE WHEN th.status IN ('pending_payment','pending_approval','enrolled','active') THEN th.id END) AS current_slots
        FROM trainer_posts tp
        JOIN users u ON u.id = tp.trainer_id
        LEFT JOIN trainer_reviews tr ON tr.post_id = tp.id
        LEFT JOIN trainer_hires th ON th.post_id = tp.id
        WHERE tp.is_active = TRUE
          AND tp.trainer_id != ?
          AND (tp.enrollment_deadline IS NULL OR tp.enrollment_deadline >= ${WIB_CURRENT_DATE_SQL})
          AND (tp.max_slots IS NULL OR
               (SELECT COUNT(*) FROM trainer_hires WHERE post_id = tp.id AND status IN ('pending_payment','pending_approval','enrolled','active')) < tp.max_slots)
         AND ? NOT IN (
               SELECT member_id FROM trainer_hires
               WHERE status IN ('pending_payment','pending_approval','enrolled','active')
          )
          AND tp.id NOT IN (
               SELECT post_id FROM trainer_hires
               WHERE member_id = ? AND status IN ('pending_payment','pending_approval','enrolled','active')
          )
       GROUP BY tp.id, u.id`,
      [requestingUserId || 0, requestingUserId || 0, requestingUserId || 0]
    );
    return rows.map(r => ({...r, schedule: r.schedule ? JSON.parse(r.schedule) : []}));
  },
  async findById(id) {
    const [[post]] = await pool.query(
      `SELECT tp.*, u.name AS trainer_name, u.avatar_url,
         u.phone_number AS trainer_phone_number,
         u.height AS trainer_height,
         u.weight AS trainer_weight,
         u.gender AS trainer_gender,
         u.dob AS trainer_dob,
          u.bio AS trainer_bio, u.profession AS trainer_profession,
          u.experience_years AS trainer_experience_years,
          u.certification AS trainer_certification,
        ROUND(AVG(tr.rating), 1) AS avg_rating,
        COUNT(DISTINCT tr.id) AS review_count,
        COUNT(DISTINCT CASE WHEN th.status IN ('pending_payment','pending_approval','enrolled','active') THEN th.id END) AS current_slots
       FROM trainer_posts tp
       JOIN users u ON u.id = tp.trainer_id
       LEFT JOIN trainer_reviews tr ON tr.post_id = tp.id
       LEFT JOIN trainer_hires th ON th.post_id = tp.id
       WHERE tp.id = ?
       GROUP BY tp.id, u.id`,
      [id]
    );
    if (!post) return null;
    return {...post, schedule: post.schedule ? JSON.parse(post.schedule) : []};
  },
  async create(data) {
    const [result] = await pool.query('INSERT INTO trainer_posts SET ?', [data]);
    return { id: result.insertId, ...data };
  },
  async update(id, trainerId, data) {
    // Strip undefined values so partial updates don't overwrite existing columns with NULL
    const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
    const [result] = await pool.query(
      'UPDATE trainer_posts SET ? WHERE id = ? AND trainer_id = ?',
      [clean, id, trainerId]
    );
    return result.affectedRows > 0;
  },
  async delete(id, trainerId) {
    const [result] = await pool.query(
      'DELETE FROM trainer_posts WHERE id = ? AND trainer_id = ?',
      [id, trainerId]
    );
    return result.affectedRows > 0;
  },
  async reactivateIfSystemClosed(id) {
    const [[post]] = await pool.query(
      'SELECT is_active, deactivated_by, enrollment_deadline FROM trainer_posts WHERE id = ?',
      [id]
    );
    if (!post || post.is_active || post.deactivated_by !== 'system') return false;

    const deadlineOk = !post.enrollment_deadline || new Date(post.enrollment_deadline) >= new Date();
    if (!deadlineOk) return false;

    await pool.query(
      'UPDATE trainer_posts SET is_active = TRUE, deactivated_by = NULL WHERE id = ?',
      [id]
    );
    return true;
  }
};

const TrainerHire = {
  async create(data) {
    const [result] = await pool.query('INSERT INTO trainer_hires SET ?', [data]);
    return { id: result.insertId, ...data };
  },
  async findById(id) {
    const [rows] = await pool.query('SELECT * FROM trainer_hires WHERE id = ?', [id]);
    return rows[0] || null;
  },
  async findDetailedById(id) {
    const [[hire]] = await pool.query(
      `SELECT th.*, tp.title AS post_title, tp.trainer_id, tp.visibility,
              trainer.name AS trainer_name, trainer.fcm_token AS trainer_fcm,
              member.name AS member_name, member.fcm_token AS member_fcm
       FROM trainer_hires th
       JOIN trainer_posts tp ON tp.id = th.post_id
       JOIN users trainer ON trainer.id = tp.trainer_id
       JOIN users member ON member.id = th.member_id
       WHERE th.id = ?`,
      [id]
    );
    return hire || null;
  },
  async findByOrderId(orderId) {
    const [rows] = await pool.query('SELECT * FROM trainer_hires WHERE payment_order_id = ?', [orderId]);
    return rows[0] || null;
  },
  async findPendingExpired() {
    const [rows] = await pool.query(
      `SELECT th.*,
              tp.title AS post_title,
              trainer.fcm_token AS trainer_fcm_token, trainer.id AS trainer_user_id,
              member.name AS member_name, member.fcm_token AS member_fcm_token
       FROM trainer_hires th
       JOIN trainer_posts tp ON tp.id = th.post_id
       JOIN users trainer ON trainer.id = tp.trainer_id
       JOIN users member ON member.id = th.member_id
       WHERE th.status IN ('pending_payment', 'pending_approval')
         AND th.trainer_response_deadline IS NOT NULL
          AND th.trainer_response_deadline < CURRENT_TIMESTAMP`
    );
    return rows;
  },
  async updateStatus(id, status) {
    await pool.query('UPDATE trainer_hires SET status = ? WHERE id = ?', [status, id]);
  },
  async setPendingTrainerResponse(orderId) {
    const [result] = await pool.query(
      "UPDATE trainer_hires SET status = 'pending_approval', trainer_response_deadline = CURRENT_TIMESTAMP + INTERVAL '48 hours' WHERE payment_order_id = ? AND status = 'pending_payment'",
      [orderId]
    );
    if (!result.affectedRows) return null;

    const [[hire]] = await pool.query(
      'SELECT trainer_response_deadline FROM trainer_hires WHERE payment_order_id = ?',
      [orderId]
    );
    return hire?.trainer_response_deadline || null;
  },
  async cancelPendingPayment(orderId) {
    const [result] = await pool.query(
      "UPDATE trainer_hires SET status = 'cancelled', trainer_response_deadline = NULL WHERE payment_order_id = ? AND status = 'pending_payment'",
      [orderId]
    );
    return result.affectedRows > 0;
  },
  // For public posts: auto-activate immediately (rolling) or enroll for cohort
  async activateFromPayment(orderId) {
    const [[hire]] = await pool.query(
      `SELECT th.id, th.post_id, th.status, tp.visibility, tp.program_start_date, tp.max_slots,
              trainer.id AS trainer_id, trainer.fcm_token AS trainer_fcm_token,
              member.name AS member_name, member.id AS member_id, member.fcm_token AS member_fcm_token,
              tp.title AS post_title
       FROM trainer_hires th
       JOIN trainer_posts tp ON tp.id = th.post_id
       JOIN users trainer ON trainer.id = tp.trainer_id
       JOIN users member ON member.id = th.member_id
       WHERE th.payment_order_id = ?`,
      [orderId]
    );
    if (!hire) return null;
    if (hire.status !== 'pending_payment') return null;

    const hasProgramStart = hire.program_start_date
      && getDateOnlyString(hire.program_start_date) > getCurrentWibDateString();

    if (hasProgramStart) {
      // Cohort mode: enroll, start/end set on program_start_date
      await pool.query(
        "UPDATE trainer_hires SET status = 'enrolled', trainer_response_deadline = NULL WHERE payment_order_id = ?",
        [orderId]
      );
      hire.flow = 'enrolled';
    } else {
      // Rolling mode: activate immediately
      const start_date = new Date();
      const end_date = new Date();
      end_date.setMonth(end_date.getMonth() + 1);
      await pool.query(
        "UPDATE trainer_hires SET status = 'active', start_date = ?, end_date = ?, trainer_response_deadline = NULL WHERE payment_order_id = ?",
        [start_date, end_date, orderId]
      );
      hire.flow = 'active';
      // Generate sessions from post schedule
      if (hire.schedule || true) {
        const [[postData]] = await pool.query('SELECT schedule FROM trainer_posts WHERE id = ?', [hire.post_id]);
        if (postData?.schedule) {
          const schedule = JSON.parse(postData.schedule);
          await Session.generateForHire(hire.id, schedule, start_date, end_date).catch(() => {});
        }
      }
      // Auto-close post if max_slots now reached
      if (hire.max_slots) {
        const [[{ cnt }]] = await pool.query(
          "SELECT COUNT(*) AS cnt FROM trainer_hires WHERE post_id = ? AND status IN ('enrolled','active')",
          [hire.post_id]
        );
        if (cnt >= hire.max_slots) {
          await pool.query("UPDATE trainer_posts SET is_active = FALSE, deactivated_by = 'system' WHERE id = ?", [hire.post_id]);
          hire.post_closed = true;
        }
      }
    }
    return hire;
  },
  async findEnrolledReady() {
    const [rows] = await pool.query(
      `SELECT th.*,
               tp.title AS post_title, tp.max_slots, tp.id AS post_id_ref,
               trainer.id AS trainer_user_id, trainer.fcm_token AS trainer_fcm_token,
               member.name AS member_name, member.fcm_token AS member_fcm_token
        FROM trainer_hires th
        JOIN trainer_posts tp ON tp.id = th.post_id
        JOIN users trainer ON trainer.id = tp.trainer_id
        JOIN users member ON member.id = th.member_id
        WHERE th.status = 'enrolled' AND tp.program_start_date <= ${WIB_CURRENT_DATE_SQL}`
    );
    return rows;
  },
  async activateEnrolledHire(id) {
    const [[hire]] = await pool.query(
      `SELECT th.id, th.post_id, th.status, tp.program_start_date, tp.max_slots,
              tp.title AS post_title, tp.schedule,
              trainer.id AS trainer_user_id, trainer.fcm_token AS trainer_fcm_token,
              member.id AS member_id, member.name AS member_name, member.fcm_token AS member_fcm_token
       FROM trainer_hires th
       JOIN trainer_posts tp ON tp.id = th.post_id
       JOIN users trainer ON trainer.id = tp.trainer_id
       JOIN users member ON member.id = th.member_id
       WHERE th.id = ?`,
      [id]
    );
    if (!hire || hire.status !== 'enrolled') return null;

    const start_date = getDateOnlyString(hire.program_start_date) || getCurrentWibDateString();
    const end_date = addMonthsToDateString(start_date, 1);
    const [result] = await pool.query(
      "UPDATE trainer_hires SET status = 'active', start_date = ?, end_date = ? WHERE id = ? AND status = 'enrolled'",
      [start_date, end_date, id]
    );
    if (!result.affectedRows) return null;

    if (hire.schedule) {
      try {
        const schedule = JSON.parse(hire.schedule);
        await Session.generateForHire(hire.id, schedule, start_date, end_date).catch(() => {});
      } catch (error) {
        console.error(`[TrainerHire] Failed to parse schedule for hire ${hire.id}:`, error.message);
      }
    }

    if (hire.max_slots) {
      const [[{ cnt }]] = await pool.query(
        "SELECT COUNT(*) AS cnt FROM trainer_hires WHERE post_id = ? AND status IN ('enrolled','active')",
        [hire.post_id]
      );
      if (cnt >= hire.max_slots) {
        await pool.query("UPDATE trainer_posts SET is_active = FALSE, deactivated_by = 'system' WHERE id = ?", [hire.post_id]);
        hire.post_closed = true;
      }
    }

    return {
      ...hire,
      start_date,
      end_date,
      status: 'active',
    };
  },
  async activateReadyEnrolledHires(filters = {}) {
    const conditions = [
      "th.status = 'enrolled'",
      `tp.program_start_date <= ${WIB_CURRENT_DATE_SQL}`,
    ];
    const params = [];

    if (filters.memberId) {
      conditions.push('th.member_id = ?');
      params.push(filters.memberId);
    }

    if (filters.trainerId) {
      conditions.push('tp.trainer_id = ?');
      params.push(filters.trainerId);
    }

    const [rows] = await pool.query(
      `SELECT th.id
       FROM trainer_hires th
       JOIN trainer_posts tp ON tp.id = th.post_id
       WHERE ${conditions.join(' AND ')}`,
      params
    );

    const activated = [];
    for (const row of rows) {
      try {
        const hire = await TrainerHire.activateEnrolledHire(row.id);
        if (hire) activated.push(hire);
      } catch (error) {
        console.error(`[TrainerHire] Failed to activate enrolled hire ${row.id}:`, error.message);
      }
    }

    return activated;
  },
  async accept(id, trainerId) {
    const hire = await TrainerHire.findById(id);
    if (!hire) return false;
    const [rows] = await pool.query(
      'SELECT id, max_slots FROM trainer_posts WHERE id = ? AND trainer_id = ?',
      [hire.post_id, trainerId]
    );
    if (!rows.length) return false;

    const awaitingTrainerApproval = hire.status === 'pending_approval'
      || (hire.status === 'pending_payment' && !!hire.trainer_response_deadline);
    if (!awaitingTrainerApproval) return false;

    // Re-check slot count to prevent over-acceptance
    const post = rows[0];
    if (post.max_slots) {
      const [[{ cnt }]] = await pool.query(
        "SELECT COUNT(*) AS cnt FROM trainer_hires WHERE post_id = ? AND status IN ('enrolled','active')",
        [hire.post_id]
      );
      if (cnt >= post.max_slots) return 'full';
    }

    const start_date = new Date();
    const end_date = new Date();
    end_date.setMonth(end_date.getMonth() + 1);
    await pool.query(
      "UPDATE trainer_hires SET status = 'active', start_date = ?, end_date = ?, trainer_response_deadline = NULL WHERE id = ?",
      [start_date, end_date, id]
    );

    // Generate sessions from post schedule
    const [[postData]] = await pool.query('SELECT schedule FROM trainer_posts WHERE id = ?', [hire.post_id]);
    if (postData?.schedule) {
      const schedule = JSON.parse(postData.schedule);
      await Session.generateForHire(id, schedule, start_date, end_date).catch(() => {});
    }

    // Auto-close post if now full
    if (post.max_slots) {
      const [[{ cnt }]] = await pool.query(
        "SELECT COUNT(*) AS cnt FROM trainer_hires WHERE post_id = ? AND status IN ('enrolled','active')",
        [hire.post_id]
      );
      if (cnt >= post.max_slots) {
        await pool.query("UPDATE trainer_posts SET is_active = FALSE, deactivated_by = 'system' WHERE id = ?", [hire.post_id]);
      }
    }
    return true;
  },
  async decline(id, trainerId) {
    const hire = await TrainerHire.findById(id);
    if (!hire) return null;
    const [rows] = await pool.query(
      'SELECT id FROM trainer_posts WHERE id = ? AND trainer_id = ?',
      [hire.post_id, trainerId]
    );
    if (!rows.length) return null;
    const awaitingTrainerApproval = hire.status === 'pending_approval'
      || (hire.status === 'pending_payment' && !!hire.trainer_response_deadline);
    if (!awaitingTrainerApproval) return null;
    return hire;
  },
  async markCancelled(id) {
    await pool.query(
      "UPDATE trainer_hires SET status = 'cancelled', trainer_response_deadline = NULL, early_end_requested_by = NULL, early_end_requested_at = NULL WHERE id = ?",
      [id]
    );
  },
  async end(id, memberId) {
    const [result] = await pool.query(
      `UPDATE trainer_hires SET status = 'ended', end_date = ${WIB_CURRENT_DATE_SQL}, early_end_requested_by = NULL, early_end_requested_at = NULL WHERE id = ? AND member_id = ? AND status = 'active'`,
      [id, memberId]
    );
    if (result.affectedRows > 0) {
      await Session.trimFutureSessions(id);
    }
    return result.affectedRows > 0;
  },
  async requestEnd(id, userId) {
    const hire = await TrainerHire.findDetailedById(id);
    if (!hire) return { code: 'not_found' };
    if (hire.status !== 'active') return { code: 'not_active', hire };

    const requesterRole = hire.member_id === userId
      ? 'member'
      : hire.trainer_id === userId
        ? 'trainer'
        : null;
    if (!requesterRole) return { code: 'forbidden', hire };
    if (hire.early_end_requested_by) return { code: 'already_requested', hire };

    const [result] = await pool.query(
      'UPDATE trainer_hires SET early_end_requested_by = ?, early_end_requested_at = CURRENT_TIMESTAMP WHERE id = ? AND status = ? AND early_end_requested_by IS NULL',
      [requesterRole, id, 'active']
    );
    if (!result.affectedRows) return { code: 'already_requested', hire };

    hire.early_end_requested_by = requesterRole;
    hire.early_end_requested_at = new Date();
    return { code: 'requested', hire, requesterRole };
  },
  async respondEndRequest(id, userId, action) {
    const hire = await TrainerHire.findDetailedById(id);
    if (!hire) return { code: 'not_found' };
    if (hire.status !== 'active') return { code: 'not_active', hire };
    if (!hire.early_end_requested_by) return { code: 'no_request', hire };

    const responderRole = hire.member_id === userId
      ? 'member'
      : hire.trainer_id === userId
        ? 'trainer'
        : null;
    if (!responderRole) return { code: 'forbidden', hire };
    if (responderRole === hire.early_end_requested_by) return { code: 'own_request', hire };

    if (action === 'accept') {
      const [result] = await pool.query(
        `UPDATE trainer_hires SET status = 'ended', end_date = ${WIB_CURRENT_DATE_SQL}, early_end_requested_by = NULL, early_end_requested_at = NULL WHERE id = ? AND status = 'active' AND early_end_requested_by IS NOT NULL`,
        [id]
      );
      if (result.affectedRows > 0) {
        await Session.trimFutureSessions(id);
      }
      if (!result.affectedRows) return { code: 'not_active', hire };
      return { code: 'accepted', hire, responderRole };
    }

    const [result] = await pool.query(
      'UPDATE trainer_hires SET early_end_requested_by = NULL, early_end_requested_at = NULL WHERE id = ? AND status = ? AND early_end_requested_by IS NOT NULL',
      [id, 'active']
    );
    if (!result.affectedRows) return { code: 'no_request', hire };
    return { code: 'rejected', hire, responderRole };
  },
  async findByMember(memberId) {
    const [rows] = await pool.query(
      `SELECT th.*, tp.title, tp.price, tp.focus_areas, tp.services,
              tp.program_start_date, tp.enrollment_deadline, tp.visibility,
              u.name AS trainer_name, u.avatar_url AS trainer_avatar, u.id AS trainer_user_id,
               u.phone_number AS trainer_phone_number,
               u.fcm_token AS trainer_fcm_token,
               th.post_id,
               ${TRAINER_RESPONSE_SECONDS_SQL} AS trainer_response_seconds_left,
               EXISTS(SELECT 1 FROM trainer_reviews tr WHERE tr.hire_id = th.id) AS has_review,
               EXISTS(SELECT 1 FROM hire_disputes hd WHERE hd.hire_id = th.id AND hd.status = 'open') AS has_open_dispute,
               (SELECT hd.status
                 FROM hire_disputes hd
                WHERE hd.hire_id = th.id
                ORDER BY hd.created_at DESC, hd.id DESC
                LIMIT 1) AS latest_dispute_status,
              (SELECT hd.admin_note
                 FROM hire_disputes hd
                WHERE hd.hire_id = th.id
                ORDER BY hd.created_at DESC, hd.id DESC
                LIMIT 1) AS latest_dispute_admin_note,
              CASE
                WHEN th.status = 'ended'
                 AND NOT EXISTS(SELECT 1 FROM trainer_reviews tr WHERE tr.hire_id = th.id)
                 AND NOT EXISTS(SELECT 1 FROM hire_disputes hd WHERE hd.hire_id = th.id AND hd.status = 'open')
                THEN TRUE
                ELSE FALSE
              END AS can_review
       FROM trainer_hires th
       JOIN trainer_posts tp ON tp.id = th.post_id
       JOIN users u ON u.id = tp.trainer_id
       WHERE th.member_id = ?
       ORDER BY th.created_at DESC`,
      [memberId]
    );
    return rows;
  },
  async findPendingByTrainer(trainerId) {
    const [rows] = await pool.query(
      `SELECT th.*, tp.title, tp.price,
               u.name AS member_name, u.avatar_url AS member_avatar, u.id AS member_user_id,
               u.phone_number AS member_phone_number,
               u.height AS member_height,
               u.weight AS member_weight,
               u.gender AS member_gender,
               u.dob AS member_dob,
               u.fcm_token AS member_fcm_token,
               ${TRAINER_RESPONSE_SECONDS_SQL} AS trainer_response_seconds_left
        FROM trainer_hires th
          JOIN trainer_posts tp ON tp.id = th.post_id
          JOIN users u ON u.id = th.member_id
        WHERE tp.trainer_id = ?
          AND ((th.status = 'pending_payment' AND th.trainer_response_deadline IS NOT NULL)
            OR th.status = 'pending_approval')
        ORDER BY CASE th.status WHEN 'pending_approval' THEN 1 WHEN 'pending_payment' THEN 2 ELSE 3 END, th.created_at DESC`,
        [trainerId]
     );
    return rows;
  },
  async findActiveByTrainer(trainerId) {
    const [rows] = await pool.query(
      `SELECT th.*, tp.title, tp.price, tp.visibility,
               u.name AS member_name, u.avatar_url AS member_avatar, u.id AS member_user_id,
               u.phone_number AS member_phone_number,
               u.height AS member_height,
               u.weight AS member_weight,
               u.gender AS member_gender,
               u.dob AS member_dob,
               u.fcm_token AS member_fcm_token
       FROM trainer_hires th
       JOIN trainer_posts tp ON tp.id = th.post_id
       JOIN users u ON u.id = th.member_id
       WHERE tp.trainer_id = ? AND th.status IN ('active', 'enrolled')
       ORDER BY tp.id, CASE th.status WHEN 'active' THEN 1 WHEN 'enrolled' THEN 2 ELSE 3 END, th.start_date DESC`,
      [trainerId]
    );
    return rows;
  },
  async findPastByTrainer(trainerId) {
    const [rows] = await pool.query(
      `SELECT th.*, tp.title, tp.price, tp.visibility,
               u.name AS member_name, u.avatar_url AS member_avatar, u.id AS member_user_id,
               u.phone_number AS member_phone_number,
               u.height AS member_height,
               u.weight AS member_weight,
               u.gender AS member_gender,
               u.dob AS member_dob,
               EXISTS(SELECT 1 FROM trainer_reviews tr WHERE tr.hire_id = th.id) AS has_review,
               (SELECT tr.rating FROM trainer_reviews tr WHERE tr.hire_id = th.id LIMIT 1) AS review_rating,
              (SELECT hd.status
                 FROM hire_disputes hd
                WHERE hd.hire_id = th.id
                ORDER BY hd.created_at DESC, hd.id DESC
                LIMIT 1) AS latest_dispute_status,
              (SELECT hd.admin_note
                 FROM hire_disputes hd
                WHERE hd.hire_id = th.id
                ORDER BY hd.created_at DESC, hd.id DESC
                LIMIT 1) AS latest_dispute_admin_note
       FROM trainer_hires th
       JOIN trainer_posts tp ON tp.id = th.post_id
       JOIN users u ON u.id = th.member_id
       WHERE tp.trainer_id = ?
         AND th.status IN ('ended', 'cancelled', 'expired')
       ORDER BY COALESCE(th.end_date, th.created_at) DESC, th.created_at DESC`,
      [trainerId]
    );
    return rows;
  }
};

const TrainerReview = {
  async create(data) {
    const [result] = await pool.query('INSERT INTO trainer_reviews SET ?', [data]);
    return { id: result.insertId, ...data };
  },
  async findByPost(postId) {
    const [rows] = await pool.query(
      `SELECT tr.*, u.name AS member_name, u.avatar_url
       FROM trainer_reviews tr
       JOIN users u ON u.id = tr.member_id
       WHERE tr.post_id = ?
       ORDER BY tr.created_at DESC`,
      [postId]
    );
    return rows;
  },
  async existsByHire(hireId) {
    const [rows] = await pool.query('SELECT id FROM trainer_reviews WHERE hire_id = ?', [hireId]);
    return rows.length > 0;
  }
};

module.exports = { TrainerPost, TrainerHire, TrainerReview };
