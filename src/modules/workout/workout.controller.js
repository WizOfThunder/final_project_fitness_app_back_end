const WorkoutPlan = require('./workout.model');
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

function parseDateOnly(value) {
  const dateOnly = extractDateOnly(value);
  if (!dateOnly) {
    return null;
  }

  const [year, month, day] = dateOnly.split('-').map(Number);
  if (!year || !month || !day) {
    return null;
  }
  return new Date(year, month - 1, day);
}

function getWeekStart(dateValue = null) {
  const now = parseDateOnly(dateValue) || parseDateOnly(formatWibDate(new Date()));
  const day = now.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diff);
  return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(
    2,
    '0',
  )}-${String(monday.getDate()).padStart(2, '0')}`;
}

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

exports.getMemberPlan = async (req, res) => {
  try {
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

exports.assignPlan = async (req, res) => {
  try {
    const { member_id, items, session_id } = req.body;
    if (!member_id || !items?.length) return res.status(400).json({ error: 'member_id and items are required' });

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
      status: 'verified',
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
      `SELECT wpi.is_done, wpi.week_start
       FROM workout_plan_items wpi
       JOIN workout_plans wp ON wp.id = wpi.workout_plan_id
       WHERE wpi.id = ? AND wp.user_id = ?`,
      [itemId, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Item not found' });

    const item = rows[0];
    const itemWeek = extractDateOnly(item.week_start);
    const effectiveDone = itemWeek === weekStart ? !!item.is_done : false;
    const newDone = !effectiveDone;

    await pool.query(
      'UPDATE workout_plan_items SET is_done = ?, week_start = ? WHERE id = ?',
      [newDone ? 1 : 0, weekStart, itemId]
    );

    res.json({ id: parseInt(itemId), is_done: newDone, week_start: weekStart });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};
