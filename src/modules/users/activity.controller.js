const ActivityLog = require('./activity.model');
const { pool } = require('../../config/db');

const ISO_YEARWEEK_SQL = `CAST(TO_CHAR(date, 'IYYYIW') AS INTEGER)`;
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

function extractDateOnly(value) {
  if (!value) return null;

  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : formatWibDate(parsed);
}

function formatDateUTC(date) {
  return date.toISOString().split('T')[0];
}

function parseDateOnly(value) {
  const [year, month, day] = String(value).split('-').map(Number);
  if (!year || !month || !day) {
    return null;
  }
  return new Date(Date.UTC(year, month - 1, day));
}

function resolveActivityDate(value) {
  const direct = extractDateOnly(value);
  if (direct) {
    return direct;
  }

  const parsed = value ? parseDateOnly(value) : null;
  return parsed ? formatDateUTC(parsed) : formatWibDate(new Date());
}

function getIsoWeekStart(date) {
  const d = new Date(date);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() + diff);
  return monday;
}

function getYearWeek(date) {
  const d = new Date(date);
  const dy = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dy);
  const year = d.getUTCFullYear();
  const start = new Date(Date.UTC(year, 0, 1));
  return year * 100 + Math.ceil(((d - start) / 86400000 + 1) / 7);
}

function prevYearWeek(yw) {
  const year = Math.floor(yw / 100);
  const week = yw % 100;
  if (week > 1) return year * 100 + (week - 1);
  return getYearWeek(new Date(Date.UTC(year - 1, 11, 28)));
}

async function markWorkoutCompletedForDate(userId, date) {
  await ActivityLog.findOneAndUpdate(
    { user_id: userId, date },
    { workout_completed: true },
    { upsert: true }
  );
}

exports.syncActivity = async (req, res) => {
  try {
    const { date, steps, calories, distance, exercise_minutes, sleep_hours } = req.body;
    const userId = req.user.id;

    await ActivityLog.findOneAndUpdate(
      { user_id: userId, date },
      { steps, calories, distance, exercise_minutes: exercise_minutes || 0, sleep_hours: sleep_hours || 0 },
      { upsert: true }
    );

    // Update current_value for all active auto challenges this user has joined
    const [activeChallenges] = await pool.query(
      `SELECT uc.id, c.type, c.target_value, c.start_date, c.end_date
       FROM user_challenges uc
       JOIN challenges c ON c.id = uc.challenge_id
       WHERE uc.user_id = ? AND uc.status = 'active' AND c.challenge_type = 'auto'
         AND c.start_date <= ? AND c.end_date >= ?`,
      [userId, date, date]
    );

    for (const uc of activeChallenges) {
      const startDate = extractDateOnly(uc.start_date);
      const endDate = extractDateOnly(uc.end_date);

      const col = uc.type === 'steps' ? 'steps'
                : uc.type === 'calories' ? 'calories'
                : 'distance';

      const [[agg]] = await pool.query(
        `SELECT COALESCE(SUM(${col}), 0) as total
         FROM activity_logs
         WHERE user_id = ? AND date >= ? AND date <= ?`,
        [userId, startDate, endDate]
      );

      const total = parseFloat(agg.total) || 0;
      await pool.query(
        'UPDATE user_challenges SET current_value = ? WHERE id = ?',
        [Math.round(total), uc.id]
      );

      // Auto-complete if target reached
      if (total >= uc.target_value) {
        await pool.query(
          "UPDATE user_challenges SET status = 'completed' WHERE id = ? AND status = 'active'",
          [uc.id]
        );
        const { triggerAchievements } = require('../achievement/achievement.helper');
        await triggerAchievements(userId);
      }
    }

    // Trigger milestone/streak achievements after sync
    const { triggerAchievements } = require('../achievement/achievement.helper');
    await triggerAchievements(userId);

    res.json({ message: 'Activity synced' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getHistory = async (req, res) => {
  try {
    const history = await ActivityLog.find({ user_id: req.user.id });
    res.json(history);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getStreak = async (req, res) => {
  try {
    const userId = req.user.id;
    const tzOffset = parseInt(req.query.tz_offset) || 0;
    const now = new Date(Date.now() + tzOffset * 60 * 1000);

    // Active days this week (Mon–today)
    const monday = getIsoWeekStart(now);
    const [[weekRow]] = await pool.query(
      `SELECT COUNT(DISTINCT date) as active_days
       FROM activity_logs
       WHERE user_id = ? AND workout_completed = TRUE AND date >= ? AND date <= ?`,
       [userId, formatDateUTC(monday), formatDateUTC(now)]
    );

    // Consecutive weeks streak
    const [weekRows] = await pool.query(
      `SELECT ${ISO_YEARWEEK_SQL} AS yw FROM activity_logs
       WHERE user_id = ? AND workout_completed = TRUE
       GROUP BY 1 ORDER BY 1 DESC`,
       [userId]
     );
    let weeklyStreak = 0;
    if (weekRows.length > 0) {
      const currentYW = getYearWeek(now);
      const weekSet = new Set(weekRows.map(r => r.yw));
      let expected = weekSet.has(currentYW) ? currentYW : prevYearWeek(currentYW);
      for (const row of weekRows) {
        if (row.yw === expected) { weeklyStreak++; expected = prevYearWeek(expected); }
        else if (row.yw < expected) break;
      }
    }

    res.json({
      active_days_this_week: parseInt(weekRow.active_days) || 0,
      weekly_streak: weeklyStreak,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.markWorkoutDay = async (req, res) => {
  try {
    const userId = req.user.id;
    const today = resolveActivityDate(req.body?.date);
    const todayDate = parseDateOnly(today);
    const weekStart = formatDateUTC(getIsoWeekStart(todayDate));

    // Check 1: all AI plan items for today are done
    const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const todayName = DAY_NAMES[todayDate.getUTCDay()];

    const [planRows] = await pool.query(
      `SELECT wp.id,
              COUNT(*) AS total_items,
              SUM(CASE WHEN wpi.is_done = TRUE AND wpi.week_start = ? THEN 1 ELSE 0 END) AS done_items
       FROM workout_plan_items wpi
        JOIN workout_plans wp ON wp.id = wpi.workout_plan_id
       WHERE wp.user_id = ? AND wpi.day = ? AND wp.generated_by IN ('ai', 'trainer') AND wp.status = 'verified'
       GROUP BY wp.id
       ORDER BY wp.created_at DESC`,
       [weekStart, userId, todayName]
    );

    // Check 2: confirmed trainer session today
    const [[sessionRow]] = await pool.query(
      `SELECT hs.id FROM hire_sessions hs
       JOIN trainer_hires th ON th.id = hs.hire_id
       WHERE th.member_id = ? AND hs.scheduled_date = ? AND hs.status = 'confirmed'`,
       [userId, today]
     );

    const hasTrainerSession = !!sessionRow;
    const hasCompletedPlan = planRows.some(row => Number(row.total_items) > 0 && Number(row.done_items) === Number(row.total_items));

    // Only mark complete if: a verified AI/trainer plan for today is fully done OR a trainer session is confirmed
    // On a non-plan day with no trainer session, do nothing
    if (!hasCompletedPlan && !hasTrainerSession) {
      return res.json({ marked: false, reason: 'not_complete' });
    }

    await markWorkoutCompletedForDate(userId, today);

    const { triggerAchievements } = require('../achievement/achievement.helper');
    await triggerAchievements(userId);

    res.json({ marked: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getWeeklySummary = async (req, res) => {
  try {
    const userId = req.user.id;
    const tzOffset = parseInt(req.query.tz_offset) || 0; // minutes offset from UTC, e.g. 420 for UTC+7

    // Shift now to local time by applying the offset
    const now = new Date(Date.now() + tzOffset * 60 * 1000);
    const day = now.getUTCDay(); // 0=Sun in local time
    const diff = day === 0 ? -6 : 1 - day;
    const monday = new Date(now);
    monday.setUTCDate(now.getUTCDate() + diff);
    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);
    const fmt = d => d.toISOString().split('T')[0];

    const [[row]] = await pool.query(
      `SELECT
         COALESCE(SUM(steps), 0) AS steps,
         COALESCE(SUM(calories), 0) AS calories,
         COALESCE(SUM(distance), 0) AS distance,
         COALESCE(SUM(exercise_minutes), 0) AS exercise_minutes,
         COALESCE(AVG(sleep_hours), 0) AS avg_sleep
       FROM activity_logs
       WHERE user_id = ? AND date >= ? AND date <= ?`,
      [userId, fmt(monday), fmt(sunday)]
    );

    res.json({
      week_start: fmt(monday),
      week_end: fmt(sunday),
      steps: Math.round(row.steps),
      calories: Math.round(row.calories),
      distance: parseFloat(parseFloat(row.distance).toFixed(2)),
      exercise_minutes: Math.round(row.exercise_minutes),
      avg_sleep: parseFloat(parseFloat(row.avg_sleep).toFixed(1)),
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};
