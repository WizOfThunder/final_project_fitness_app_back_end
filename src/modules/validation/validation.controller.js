const WorkoutPlan = require('../workout/workout.model');
const DietPlan = require('../ai/diet.model');
const ValidationLog = require('./validation.model');
const { pool } = require('../../config/db');
const { saveNotification } = require('../notification/notification.helper');
const { sendPushNotification } = require('../notification/notification.service');

exports.getPending = async (req, res) => {
  try {
    const workouts = (await WorkoutPlan.find({})).filter((plan) => plan.generated_by === 'ai');
    const diets = await DietPlan.find({});
    res.json({ workouts, diets });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.validatePlan = async (req, res) => {
  try {
    const { action, note, planType } = req.body;
    const { plan_id } = req.params;

    if (!planType) return res.status(400).json({ error: 'planType is required' });
    if (!['verified', 'denied'].includes(action)) {
      return res.status(400).json({ error: 'action must be verified or denied' });
    }

    const table = planType === 'workout' ? 'workout_plans' : 'diet_plans';
    const [result] = await pool.query(`UPDATE ${table} SET status = ?, validation_note = ? WHERE id = ?`, [action, note || null, plan_id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Plan not found' });

    await ValidationLog.create({ plan_id, plan_type: planType, admin_id: req.user.id, action, note: note || null });

    // Notify the plan owner
    const [[planRow]] = await pool.query(
      `SELECT user_id FROM ${table} WHERE id = ?`, [plan_id]
    );
    if (planRow) {
      const [[userRow]] = await pool.query('SELECT fcm_token FROM users WHERE id = ?', [planRow.user_id]);
      const isApproved = action === 'verified';
      const title = isApproved
        ? `✅ ${planType === 'workout' ? 'Workout' : 'Diet'} Plan Approved`
        : `❌ ${planType === 'workout' ? 'Workout' : 'Diet'} Plan Rejected`;
      const body = isApproved
        ? `Your AI-generated ${planType} plan has been reviewed and approved by an admin.`
        : `Your AI-generated ${planType} plan was rejected${note ? `: ${note}` : '. Please generate a new one.'}`;
      await saveNotification(planRow.user_id, title, body, 'general', {
        screen: planType === 'workout' ? 'AIWorkoutPlan' : 'AIDietPlan',
        params: {},
        intent: 'plan_validated',
        plan_type: planType,
      });
      if (userRow?.fcm_token) sendPushNotification(userRow.fcm_token, title, body, {type: 'plan_validated', plan_type: planType, status: action}).catch(() => {});
    }

    res.json({ message: 'Plan validated', status: action, validation_note: note || null });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};
