const { Achievement, UserAchievement } = require('./achievement.model');
const { pool } = require('../../config/db');

const ISO_YEARWEEK_SQL = `CAST(TO_CHAR(date, 'IYYYIW') AS INTEGER)`;

exports.getAchievements = async (req, res) => {
  try {
    const achievements = req.user?.role === 'admin'
      ? await Achievement.findAll()
      : await Achievement.find();
    res.json(achievements);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.createAchievement = async (req, res) => {
  try {
    const { title, description, rule_type, rule_value, icon } = req.body;
    if (!title || !rule_type || rule_value == null) return res.status(400).json({ error: 'title, rule_type and rule_value are required' });
    const achievement = await Achievement.create({ title, description: description || null, rule_type, rule_value, icon: icon || null, is_active: true });
    res.status(201).json(achievement);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.updateAchievement = async (req, res) => {
  try {
    const { title, description, rule_type, rule_value, icon } = req.body;
    const updated = await Achievement.update(req.params.id, { title, description, rule_type, rule_value, icon: icon || null });
    res.json(updated);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.deleteAchievement = async (req, res) => {
  try {
    await Achievement.softDelete(req.params.id);
    res.json({ message: 'Achievement deactivated' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.restoreAchievement = async (req, res) => {
  try {
    await Achievement.restore(req.params.id);
    res.json({ message: 'Achievement restored' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getMyAchievements = async (req, res) => {
  try {
    const achievements = await UserAchievement.find({ user_id: req.user.id });
    res.json(achievements);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getMyProgress = async (req, res) => {
  try {
    const userId = req.user.id;

    const achievements = await Achievement.find(); // active only

    // Get earned achievement IDs
    const [earned] = await pool.query(
      'SELECT achievement_id, earned_at FROM user_achievements WHERE user_id = ?',
      [userId]
    );
    const earnedMap = {};
    earned.forEach(e => { earnedMap[e.achievement_id] = e.earned_at; });

    // Get all-time activity totals
    const [[totals]] = await pool.query(
      `SELECT COALESCE(SUM(steps),0) as steps, COALESCE(SUM(calories),0) as calories, COALESCE(SUM(distance),0) as distance
       FROM activity_logs WHERE user_id = ?`,
      [userId]
    );

    // Get completed challenge count
    const [[{ completed_count }]] = await pool.query(
      `SELECT COUNT(*) as completed_count FROM user_challenges WHERE user_id = ? AND status = 'completed'`,
      [userId]
    );

    // Get weekly streak with grace period
    const [weekRows] = await pool.query(
      `SELECT ${ISO_YEARWEEK_SQL} AS yw FROM activity_logs
       WHERE user_id = ? AND workout_completed = TRUE
       GROUP BY 1 ORDER BY 1 DESC`,
      [userId]
    );
    let weeklyStreak = 0;
    if (weekRows.length > 0) {
      const now = new Date();
      const day = now.getUTCDay() || 7;
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() + 4 - day);
      const year = d.getUTCFullYear();
      const startOfYear = new Date(Date.UTC(year, 0, 1));
      const currentWeek = year * 100 + Math.ceil(((d - startOfYear) / 86400000 + 1) / 7);
      const weekSet = new Set(weekRows.map(r => r.yw));
      let expected = weekSet.has(currentWeek) ? currentWeek : prevYW(currentWeek);
      for (const row of weekRows) {
        if (row.yw === expected) {
          weeklyStreak++;
          expected = prevYW(expected);
        } else if (row.yw < expected) {
          break;
        }
      }
    }

    const progressMap = {
      challenge_complete: completed_count,
      steps_total: Math.round(totals.steps),
      calories_total: Math.round(totals.calories),
      distance_total: Number(Number(totals.distance || 0).toFixed(2)),
      weekly_streak: weeklyStreak,
    };

    const result = achievements.map(a => ({
      ...a,
      current_value: progressMap[a.rule_type] ?? 0,
      earned: !!earnedMap[a.id],
      earned_at: earnedMap[a.id] || null,
    }));

    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

function prevYW(yw) {
  const year = Math.floor(yw / 100);
  const week = yw % 100;
  if (week > 1) return year * 100 + (week - 1);
  const d = new Date(Date.UTC(year - 1, 11, 28));
  const day2 = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day2);
  const y2 = d.getUTCFullYear();
  const s = new Date(Date.UTC(y2, 0, 1));
  return y2 * 100 + Math.ceil(((d - s) / 86400000 + 1) / 7);
}
