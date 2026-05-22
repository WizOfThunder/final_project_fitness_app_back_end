const { pool } = require('../../config/db');

function safeParseJson(value) {
  if (!value) return null;

  try {
    return JSON.parse(value);
  } catch (error) {
    console.error('[DietPlan] Invalid survey_input JSON:', error.message);
    return null;
  }
}

const DietPlan = {
  async find(where = {}) {
    if (Object.keys(where).length === 0) {
      const [rows] = await pool.query('SELECT * FROM diet_plans');
      return Promise.all(rows.map(DietPlan._populate));
    }
    const key = Object.keys(where)[0];
    const [rows] = await pool.query(`SELECT * FROM diet_plans WHERE ${key} = ?`, [where[key]]);
    return Promise.all(rows.map(DietPlan._populate));
  },
  async findById(id) {
    const [rows] = await pool.query('SELECT * FROM diet_plans WHERE id = ?', [id]);
    if (!rows[0]) return null;
    return DietPlan._populate(rows[0]);
  },
  async create(data) {
    const { items, ...planData } = data;
    const [result] = await pool.query('INSERT INTO diet_plans SET ?', [planData]);
    const planId = result.insertId;
    if (items && items.length) {
      for (const item of items) {
        await pool.query('INSERT INTO diet_plan_items SET ?', [{ diet_plan_id: planId, ...item }]);
      }
    }
    return DietPlan.findById(planId);
  },
  async save(plan) {
    const { id, ...data } = plan;
    await pool.query('UPDATE diet_plans SET ? WHERE id = ?', [data, id]);
    return DietPlan.findById(id);
  },
  async _populate(plan) {
    const [items] = await pool.query(
      `SELECT dpi.id, dpi.day, dpi.meal_type, r.id as recipe_id, r.title, r.image, r.calories, r.protein, r.fat, r.carbs, r.ready_in_minutes
       FROM diet_plan_items dpi
       JOIN recipes r ON r.id = dpi.recipe_id
       WHERE dpi.diet_plan_id = ?`,
      [plan.id]
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

module.exports = DietPlan;
