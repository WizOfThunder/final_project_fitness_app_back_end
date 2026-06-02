const { pool } = require('../../config/db');

const WIB_CURRENT_TIMESTAMP_SQL = `(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')`;
const WIB_CURRENT_DATE_SQL = `(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')::date`;
const { getMidtransTransactionStatus } = require('../../config/midtrans');

const adminTransactionSelect = `
  SELECT
    p.id,
    p.order_id,
    p.amount,
    p.status,
    p.payment_type,
    p.transaction_id,
    p.created_at,
    p.updated_at,
    member.name AS member_name,
    member.email AS member_email,
    trainer.name AS trainer_name
  FROM payments p
  JOIN users member ON member.id = p.user_id
  LEFT JOIN trainer_hires th ON th.payment_order_id = p.order_id
  LEFT JOIN trainer_posts tp ON tp.id = th.post_id
  LEFT JOIN users trainer ON trainer.id = tp.trainer_id
`;

function normalizeTransactionStatus(status) {
  return status === 'settlement' ? 'success' : status;
}

function formatPaymentMethod(paymentType) {
  if (!paymentType) return 'Pending';
  return paymentType
    .split('_')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function buildTransactionSummary(row) {
  return {
    id: row.id,
    orderId: row.order_id,
    memberName: row.member_name || 'Unknown Member',
    memberEmail: row.member_email || '',
    trainerName: row.trainer_name || 'Not Assigned',
    amount: Number(row.amount || 0),
    status: normalizeTransactionStatus(row.status),
    paymentMethod: formatPaymentMethod(row.payment_type),
    transactionTime: row.updated_at || row.created_at,
    midtransTransactionId: row.transaction_id || '',
  };
}

function buildFallbackMidtransData(row) {
  return {
    transactionStatus: row.status || 'pending',
    fraudStatus: 'unknown',
    bank: '-',
    vaNumber: null,
    paymentType: formatPaymentMethod(row.payment_type),
    grossAmount: String(Number(row.amount || 0)),
    transactionId: row.transaction_id || '-',
    statusCode: '-',
  };
}

async function findTransactionRow(transactionId) {
  const lookupField = /^\d+$/.test(String(transactionId)) ? 'p.id' : 'p.order_id';
  const [rows] = await pool.query(
    `${adminTransactionSelect} WHERE ${lookupField} = ? LIMIT 1`,
    [transactionId],
  );
  return rows[0] || null;
}

exports.getStats = async (req, res) => {
  try {
    // ── User counts ──
    const [[userCounts]] = await pool.query(`
      SELECT
        COUNT(*) AS total_users,
        COUNT(*) FILTER (WHERE role = 'member') AS total_members,
        COUNT(*) FILTER (WHERE role = 'trainer') AS total_trainers,
        COUNT(*) FILTER (WHERE role = 'admin') AS total_admins
      FROM users
    `);

    // ── Active subscriptions ──
    const [[{ active_subscriptions }]] = await pool.query(`
      SELECT COUNT(DISTINCT member_id) AS active_subscriptions
      FROM trainer_hires WHERE status = 'active'
    `);

    // ── Pending trainer cert approvals ──
    const [[{ pending_trainer_approvals }]] = await pool.query(`
      SELECT COUNT(*) AS pending_trainer_approvals
      FROM users WHERE role = 'trainer' AND certification_status = 'pending'
    `);

    // ── Pending AI validations (status = 'draft') ──
    const [[{ pending_validations }]] = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM workout_plans WHERE status = 'draft') +
        (SELECT COUNT(*) FROM diet_plans WHERE status = 'draft') AS pending_validations
    `);

    // ── Open disputes ──
    const [[{ open_disputes }]] = await pool.query(`
      SELECT COUNT(*) AS open_disputes FROM hire_disputes WHERE status = 'open'
    `);

    // ── Monthly revenue ──
    const [[{ monthly_revenue }]] = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) AS monthly_revenue
      FROM payments
      WHERE status = 'settlement'
        AND (updated_at AT TIME ZONE 'Asia/Jakarta') >= DATE_TRUNC('month', ${WIB_CURRENT_TIMESTAMP_SQL})
        AND (updated_at AT TIME ZONE 'Asia/Jakarta') < DATE_TRUNC('month', ${WIB_CURRENT_TIMESTAMP_SQL}) + INTERVAL '1 month'
    `);

    // ── User growth: new registrations per month last 6 months ──
    const [userGrowth] = await pool.query(`
      SELECT
        TO_CHAR(DATE_TRUNC('month', created_at), 'FMMon') AS month,
        COUNT(*) AS count
      FROM users
      WHERE created_at >= DATE_TRUNC('month', ${WIB_CURRENT_TIMESTAMP_SQL}) - INTERVAL '5 months'
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY DATE_TRUNC('month', created_at)
    `);

    // ── Revenue trend: monthly revenue last 6 months ──
    const [revenueTrend] = await pool.query(`
      SELECT
        TO_CHAR(DATE_TRUNC('month', updated_at AT TIME ZONE 'Asia/Jakarta'), 'FMMon') AS month,
        COALESCE(SUM(amount), 0) AS total
      FROM payments
      WHERE status = 'settlement'
        AND (updated_at AT TIME ZONE 'Asia/Jakarta') >= DATE_TRUNC('month', ${WIB_CURRENT_TIMESTAMP_SQL}) - INTERVAL '5 months'
      GROUP BY DATE_TRUNC('month', updated_at AT TIME ZONE 'Asia/Jakarta')
      ORDER BY DATE_TRUNC('month', updated_at AT TIME ZONE 'Asia/Jakarta')
    `);

    // ── Weekly workout completions ──
    const [weeklyActivity] = await pool.query(`
      SELECT day, COUNT(*) AS count
      FROM workout_plan_items
      WHERE is_done = TRUE
        AND week_start = DATE_TRUNC('week', ${WIB_CURRENT_DATE_SQL})::date
      GROUP BY day
    `);

    // ── Recent activity: last 10 admin-relevant notifications ──
    try {
      
    const [recentActivity] = await pool.query(`
      WITH admin_notifications AS (
        SELECT
          n.id,
          n.title,
          n.message,
          n.type,
          n.created_at,
          COALESCE(n.data::jsonb ->> 'actor_name', recipient.name, 'System') AS user_name,
          COALESCE(n.data::jsonb ->> 'actor_role', recipient.role, 'system') AS user_role,
          COALESCE(
            n.data::jsonb ->> 'event_key',
            CONCAT(
              n.type,
              ':',
              n.title,
              ':',
              n.message,
              ':',
              TO_CHAR(DATE_TRUNC('second', n.created_at), 'YYYY-MM-DD HH24:MI:SS')
            )
          ) AS event_key
        FROM notifications n
        JOIN users recipient ON recipient.id = n.user_id
        WHERE recipient.role = 'admin'
          AND (
            (n.type = 'dispute' AND n.title = 'New Hire Dispute')
            OR (n.type = 'general' AND n.title = 'New Trainer Registration')
            OR n.type IN (
              'admin_validation_request',
              'admin_challenge_submission',
              'admin_challenge_review'
            )
          )
      )
      SELECT title, message, type, created_at, user_name, user_role
      FROM (
        SELECT DISTINCT ON (event_key)
          id,
          title,
          message,
          type,
          created_at,
          user_name,
          user_role,
          event_key
        FROM admin_notifications
        ORDER BY event_key, created_at DESC, id DESC
      ) deduped
      ORDER BY created_at DESC
      LIMIT 10
    `);

    } catch (error) {
      console.error(err);
    }

    res.json({
      stats: {
        total_users: Number(userCounts.total_users),
        total_members: Number(userCounts.total_members),
        total_trainers: Number(userCounts.total_trainers),
        total_admins: Number(userCounts.total_admins),
        active_subscriptions: Number(active_subscriptions),
        pending_trainer_approvals: Number(pending_trainer_approvals),
        pending_validations: Number(pending_validations),
        open_disputes: Number(open_disputes),
        monthly_revenue: Number(monthly_revenue),
      },
      user_growth: userGrowth,
      revenue_trend: revenueTrend,
      weekly_activity: weeklyActivity,
      recent_activity: recentActivity,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getTransactions = async (req, res) => {
  try {
    const filters = [];
    const params = [];

    const search =
      typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const paymentMethod =
      typeof req.query.paymentMethod === 'string'
        ? req.query.paymentMethod.trim()
        : '';
    const dateFrom =
      typeof req.query.dateFrom === 'string' ? req.query.dateFrom.trim() : '';
    const dateTo =
      typeof req.query.dateTo === 'string' ? req.query.dateTo.trim() : '';
    const minAmount = Number(req.query.minAmount);
    const maxAmount = Number(req.query.maxAmount);

    if (req.query.status && req.query.status !== 'all') {
      filters.push('p.status = ?');
      params.push(req.query.status === 'success' ? 'settlement' : req.query.status);
    }

    if (paymentMethod && paymentMethod !== 'all') {
      filters.push('p.payment_type = ?');
      params.push(paymentMethod);
    }

    if (search) {
      filters.push('LOWER(member.name) LIKE ?');
      params.push(`%${search.toLowerCase()}%`);
    }

    if (dateFrom) {
      filters.push(`(COALESCE(p.updated_at, p.created_at) AT TIME ZONE 'Asia/Jakarta')::date >= ?`);
      params.push(dateFrom);
    }

    if (dateTo) {
      filters.push(`(COALESCE(p.updated_at, p.created_at) AT TIME ZONE 'Asia/Jakarta')::date <= ?`);
      params.push(dateTo);
    }

    if (Number.isFinite(minAmount)) {
      filters.push('p.amount >= ?');
      params.push(minAmount);
    }

    if (Number.isFinite(maxAmount)) {
      filters.push('p.amount <= ?');
      params.push(maxAmount);
    }

    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `${adminTransactionSelect} ${whereClause} ORDER BY p.updated_at DESC, p.created_at DESC`,
      params,
    );

    res.json({ transactions: rows.map(buildTransactionSummary) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getTransactionDetail = async (req, res) => {
  try {
    const row = await findTransactionRow(req.params.transactionId);
    if (!row) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    let midtransData = buildFallbackMidtransData(row);

    try {
      const midtransStatus = await getMidtransTransactionStatus(row.order_id);
      midtransData = {
        transactionStatus: midtransStatus.transaction_status || row.status || 'pending',
        fraudStatus: midtransStatus.fraud_status || 'unknown',
        bank: midtransStatus.bank || midtransStatus.va_numbers?.[0]?.bank || midtransStatus.store || '-',
        vaNumber: midtransStatus.va_numbers?.[0]?.va_number || midtransStatus.permata_va_number || midtransStatus.bill_key || null,
        paymentType: formatPaymentMethod(midtransStatus.payment_type || row.payment_type),
        grossAmount: midtransStatus.gross_amount || String(Number(row.amount || 0)),
        transactionId: midtransStatus.transaction_id || row.transaction_id || '-',
        statusCode: midtransStatus.status_code || '-',
      };
    } catch (midtransError) {
      console.error('[Admin] Transaction detail Midtrans lookup failed:', midtransError.message);
    }

    res.json({
      transaction: {
        ...buildTransactionSummary(row),
        midtransData,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
