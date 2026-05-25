const { pool } = require('../../config/db');

const WIB_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Jakarta',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function formatWibDate(date) {
  const parts = Object.fromEntries(
    WIB_DATE_FORMATTER.formatToParts(date).map(part => [part.type, part.value]),
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

function getWeekStart(dateValue = null) {
  const dateOnly = extractDateOnly(dateValue) || formatWibDate(new Date());
  const [year, month, day] = dateOnly.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  const dayOfWeek = date.getDay();
  const diff = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(date);
  monday.setDate(date.getDate() + diff);

  return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(
    2,
    '0',
  )}-${String(monday.getDate()).padStart(2, '0')}`;
}

function safeParseJson(value) {
  if (!value) return null;

  try {
    return JSON.parse(value);
  } catch (error) {
    console.error('[WorkoutPlan] Invalid survey_input JSON:', error.message);
    return null;
  }
}

const WorkoutPlan = {
  async find(where = {}) {
    let plans;
    if (Object.keys(where).length === 0) {
      [plans] = await pool.query('SELECT * FROM workout_plans');
    } else {
      const key = Object.keys(where)[0];
      [plans] = await pool.query(`SELECT * FROM workout_plans WHERE ${key} = ?`, [where[key]]);
    }
    return Promise.all(plans.map(WorkoutPlan._populate));
  },
  async findById(id) {
    const [rows] = await pool.query('SELECT * FROM workout_plans WHERE id = ?', [id]);
    if (!rows[0]) return null;
    return WorkoutPlan._populate(rows[0]);
  },
  async create(data) {
    const { items, ...planData } = data;
    const [result] = await pool.query('INSERT INTO workout_plans SET ?', [planData]);
    const planId = result.insertId;
    if (items && items.length) {
      for (const item of items) {
        await pool.query('INSERT INTO workout_plan_items SET ?', [{ workout_plan_id: planId, ...item }]);
      }
    }
    return WorkoutPlan.findById(planId);
  },
  async findByIdAndDelete(id) {
    await pool.query('DELETE FROM workout_plans WHERE id = ?', [id]);
  },
  async findRawTrainerSessionPlan(sessionId) {
    const [rows] = await pool.query(
      `SELECT * FROM workout_plans
       WHERE session_id = ? AND generated_by = 'trainer'
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [sessionId]
    );
    return rows[0] || null;
  },
  async findTrainerSessionPlan(sessionId) {
    const plan = await WorkoutPlan.findRawTrainerSessionPlan(sessionId);
    if (!plan) return null;
    return WorkoutPlan._populate(plan);
  },
  async replaceItems(planId, items) {
    await pool.query('DELETE FROM workout_plan_items WHERE workout_plan_id = ?', [planId]);
    if (items && items.length) {
      for (const item of items) {
        await pool.query('INSERT INTO workout_plan_items SET ?', [{ workout_plan_id: planId, ...item }]);
      }
    }
    return WorkoutPlan.findById(planId);
  },
  async _populate(plan) {
    const weekStart = getWeekStart();

    const [items] = await pool.query(
      `SELECT wpi.id, wpi.day, wpi.sets, wpi.reps, wpi.duration, wpi.week_start, wpi.exercise_id,
              CASE WHEN wpi.week_start = ? THEN wpi.is_done ELSE FALSE END as is_done,
              e.name, e.muscle, e.equipment, e.difficulty, e.youtube_url
       FROM workout_plan_items wpi
       JOIN exercises e ON e.id = wpi.exercise_id
       WHERE wpi.workout_plan_id = ?`,
      [weekStart, plan.id]
    );
    const [users] = await pool.query('SELECT id, name, email, height, weight, gender, dob FROM users WHERE id = ?', [plan.user_id]);
    return {
      ...plan,
      survey_input: safeParseJson(plan.survey_input),
      user: users[0] || null,
      items,
    };
  }
};

module.exports = WorkoutPlan;
