const { pool } = require('../../config/db');

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
    const now = new Date();
    const day = now.getUTCDay();
    const diff = (day === 0 ? -6 : 1 - day);
    const monday = new Date(now);
    monday.setUTCDate(now.getUTCDate() + diff);
    const weekStart = monday.getUTCFullYear() + '-' +
      String(monday.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(monday.getUTCDate()).padStart(2, '0');

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
