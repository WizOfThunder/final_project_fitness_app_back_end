const WorkoutPlan = require('./workout.model');
const { pool } = require('../../config/db');

function parseDateOnly(value) {
  const [year, month, day] = String(value).split('-').map(Number);
  if (!year || !month || !day) {
    return null;
  }
  return new Date(Date.UTC(year, month - 1, day));
}

// Get monday of current week as YYYY-MM-DD
function getWeekStart(dateValue = null) {
  const now = parseDateOnly(dateValue) || new Date();
  const day = now.getUTCDay();
  const diff = (day === 0 ? -6 : 1 - day);
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() + diff);
  return monday.getUTCFullYear() + '-' +
    String(monday.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(monday.getUTCDate()).padStart(2, '0');
}

// GET /workout/trainer/clients — active clients of this trainer with basic activity stats
exports.getTrainerClients = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT th.id AS hire_id, th.start_date, th.end_date, th.post_id,
              tp.title AS post_title, tp.visibility,
              u.id AS user_id, u.name, u.email, u.avatar_url,
              u.phone_number, u.height, u.weight, u.gender, u.dob,
              (SELECT COUNT(*) FROM workout_plans WHERE user_id = u.id AND generated_by = 'trainer') AS plan_count,
              (SELECT COUNT(*) FROM workout_plan_items wpi
               JOIN workout_plans wp ON wp.id = wpi.workout_plan_id
               WHERE wp.user_id = u.id AND wpi.is_done = TRUE
                  AND wpi.week_start = ?) AS done_this_week,
              (SELECT COUNT(*) FROM workout_plan_items wpi
               JOIN workout_plans wp ON wp.id = wpi.workout_plan_id
               WHERE wp.user_id = u.id AND wpi.week_start = ?) AS total_this_week
       FROM trainer_hires th
       JOIN trainer_posts tp ON tp.id = th.post_id
       JOIN users u ON u.id = th.member_id
       WHERE tp.trainer_id = ? AND th.status IN ('active', 'enrolled')
       ORDER BY tp.visibility, u.name`,
      [getWeekStart(), getWeekStart(), req.user.id]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// GET /workout/trainer/member/:userId — view a specific member's trainer-assigned plan
exports.getMemberPlan = async (req, res) => {
  try {
    // Verify trainer has an active hire with this member
    const [[hire]] = await pool.query(
      `SELECT th.id FROM trainer_hires th
       JOIN trainer_posts tp ON tp.id = th.post_id
       WHERE tp.trainer_id = ? AND th.member_id = ? AND th.status IN ('active', 'enrolled')`,
      [req.user.id, req.params.userId]
    );
    if (!hire) return res.status(403).json({ error: 'No active hire with this member' });

    const plans = await WorkoutPlan.find({ user_id: req.params.userId });
    const trainerPlans = plans.filter(p => p.generated_by === 'trainer');
    res.json(trainerPlans);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// POST /workout/trainer/assign — create a workout plan for a member
exports.assignPlan = async (req, res) => {
  try {
    const { member_id, items, session_id } = req.body;
    if (!member_id || !items?.length) return res.status(400).json({ error: 'member_id and items are required' });

    // Verify trainer has an active hire with this member
    const [[hire]] = await pool.query(
      `SELECT th.id FROM trainer_hires th
       JOIN trainer_posts tp ON tp.id = th.post_id
       WHERE tp.trainer_id = ? AND th.member_id = ? AND th.status IN ('active', 'enrolled')`,
      [req.user.id, member_id]
    );
    if (!hire) return res.status(403).json({ error: 'No active hire with this member' });

    let sessionDay = null;
    if (session_id) {
      const [[session]] = await pool.query(
        `SELECT hs.id, hs.status, hs.scheduled_day, th.member_id
         FROM hire_sessions hs
         JOIN trainer_hires th ON th.id = hs.hire_id
         JOIN trainer_posts tp ON tp.id = th.post_id
         WHERE hs.id = ?
           AND tp.trainer_id = ?
           AND th.status IN ('active', 'enrolled')`,
        [session_id, req.user.id]
      );

      if (!session || Number(session.member_id) !== Number(member_id)) {
        return res.status(403).json({ error: 'Session not found for this member' });
      }

      if (!['upcoming', 'started'].includes(session.status)) {
        return res.status(400).json({ error: 'Plans can only be added from upcoming or started sessions' });
      }

      sessionDay = session.scheduled_day;
    }

    const normalizedItems = items.map(item => ({
      day: sessionDay || item.day,
      exercise_id: item.exercise_id ? Number(item.exercise_id) : null,
      sets: item.sets ? Number(item.sets) : null,
      reps: item.reps ? Number(item.reps) : null,
      duration: item.duration ? Number(item.duration) : null,
    }));

    if (normalizedItems.some(item => !item.day || !item.exercise_id)) {
      return res.status(400).json({ error: 'Each workout item requires a day and exercise_id' });
    }

    if (session_id) {
      const existingPlan = await WorkoutPlan.findRawTrainerSessionPlan(session_id);
      if (existingPlan) {
        if (Number(existingPlan.user_id) !== Number(member_id)) {
          return res.status(409).json({ error: 'This session is already linked to another member plan' });
        }

        const updatedPlan = await WorkoutPlan.replaceItems(existingPlan.id, normalizedItems);
        return res.json(updatedPlan);
      }
    }

    const plan = await WorkoutPlan.create({
      user_id: member_id,
      session_id: session_id || null,
      generated_by: 'trainer',
      status: 'verified', // trainer-assigned plans are pre-approved
      items: normalizedItems,
    });
    res.status(201).json(plan);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getMyPlan = async (req, res) => {
  try {
    const plans = await WorkoutPlan.find({ user_id: req.user.id });
    res.json(plans);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getPlan = async (req, res) => {
  try {
    const plan = await WorkoutPlan.findById(req.params.id);
    res.json(plan);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.deletePlan = async (req, res) => {
  try {
    await WorkoutPlan.findByIdAndDelete(req.params.id);
    res.json({ message: 'Plan deleted' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.toggleItem = async (req, res) => {
  try {
    const { itemId } = req.params;
    const weekStart = getWeekStart(req.body?.date);

    const [rows] = await pool.query(
      'SELECT is_done, week_start FROM workout_plan_items WHERE id = ?',
      [itemId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Item not found' });

    const item = rows[0];
    let itemWeek = null;
    if (item.week_start) {
      const d = new Date(item.week_start);
      itemWeek = d.getUTCFullYear() + '-' +
        String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
        String(d.getUTCDate()).padStart(2, '0');
    }
    const newDone = !item.is_done;

    await pool.query(
      'UPDATE workout_plan_items SET is_done = ?, week_start = ? WHERE id = ?',
      [newDone ? 1 : 0, weekStart, itemId]
    );

    res.json({ id: parseInt(itemId), is_done: newDone, week_start: weekStart });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};
