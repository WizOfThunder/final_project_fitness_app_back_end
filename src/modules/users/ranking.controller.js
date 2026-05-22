const { pool } = require('../../config/db');

const WIB_CURRENT_DATE_SQL = `(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')::date`;
const THIS_WEEK_START_SQL = `DATE_TRUNC('week', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta'))::date`;
const WEEKLY_ACHIEVEMENT_FILTER = `AND ua.earned_at >= CURRENT_TIMESTAMP - INTERVAL '7 days'`;
const WEEKLY_CHALLENGE_FILTER = `AND c.end_date >= ${WIB_CURRENT_DATE_SQL} - INTERVAL '7 days'`;

exports.getBadgeLeaderboard = async (req, res) => {
  try {
    const { period, category } = req.query;
    const categoryMap = {
      challenge: ["'challenge_complete'"],
      weekly_streak: ["'weekly_streak'"],
      steps: ["'steps_total'"],
      calories: ["'calories_total'"],
      distance: ["'distance_total'"],
    };
    const typeFilter = category && categoryMap[category]
      ? `AND a.rule_type IN (${categoryMap[category].join(',')})`
      : '';
    const dateFilter = period === 'weekly'
      ? WEEKLY_ACHIEVEMENT_FILTER
      : '';

    const [rows] = await pool.query(
      `SELECT u.id as user_id, u.name, u.avatar_url,
              COUNT(a.id) as badge_count,
              DENSE_RANK() OVER (ORDER BY COUNT(a.id) DESC) as rank
       FROM users u
        LEFT JOIN user_achievements ua ON ua.user_id = u.id ${dateFilter}
        LEFT JOIN achievements a ON a.id = ua.achievement_id ${typeFilter}
        GROUP BY u.id, u.name, u.avatar_url
        HAVING COUNT(a.id) > 0
        ORDER BY badge_count DESC
        LIMIT 50`
    );
    res.json(rows);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getPointsLeaderboard = async (req, res) => {
  try {
    const { period } = req.query;
    const weeklyWhere = period === 'weekly'
      ? WEEKLY_CHALLENGE_FILTER
      : '';

    const [rows] = await pool.query(
      `SELECT u.id as user_id, u.name, u.avatar_url,
              COALESCE(SUM(c.points), 0) as total_points,
              COUNT(uc.id) as challenges_completed,
              DENSE_RANK() OVER (ORDER BY COALESCE(SUM(c.points), 0) DESC) as rank
       FROM users u
       LEFT JOIN user_challenges uc ON uc.user_id = u.id AND uc.status = 'completed'
       LEFT JOIN challenges c ON c.id = uc.challenge_id ${weeklyWhere}
       GROUP BY u.id, u.name, u.avatar_url
        HAVING COALESCE(SUM(c.points), 0) > 0
        ORDER BY total_points DESC
        LIMIT 50`
    );
    res.json(rows);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getStreakLeaderboard = async (req, res) => {
  try {
    const { period } = req.query;
    const dateFilter = period === 'this_week'
      ? `AND al.date >= ${THIS_WEEK_START_SQL}`
      : '';

    const [rows] = await pool.query(
      `SELECT u.id as user_id, u.name, u.avatar_url,
              COUNT(DISTINCT al.date) as active_days,
              DENSE_RANK() OVER (ORDER BY COUNT(DISTINCT al.date) DESC) as rank
        FROM users u
        JOIN activity_logs al ON al.user_id = u.id AND al.workout_completed = TRUE ${dateFilter}
        GROUP BY u.id, u.name, u.avatar_url
        ORDER BY active_days DESC
        LIMIT 50`
    );
    res.json(rows);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getMyRank = async (req, res) => {
  try {
    const userId = req.user.id;
    const { type, period, category } = req.query;

    let rankQuery;

    if (type === 'streak') {
      const dateFilter = period === 'this_week'
        ? `AND date >= ${THIS_WEEK_START_SQL}`
        : '';
      rankQuery = `
        SELECT user_id, COUNT(DISTINCT date) as score,
               DENSE_RANK() OVER (ORDER BY COUNT(DISTINCT date) DESC) as rank
        FROM activity_logs
        WHERE workout_completed = TRUE ${dateFilter}
        GROUP BY user_id`;
    } else if (type === 'points') {
      const weeklyJoin = period === 'weekly'
        ? WEEKLY_CHALLENGE_FILTER
        : '';
      rankQuery = `
        SELECT user_id, COALESCE(SUM(c.points), 0) as score,
               DENSE_RANK() OVER (ORDER BY COALESCE(SUM(c.points), 0) DESC) as rank
        FROM user_challenges uc
        JOIN challenges c ON c.id = uc.challenge_id ${weeklyJoin}
        WHERE uc.status = 'completed'
        GROUP BY user_id`;
    } else {
      const categoryMap = {
        challenge: ["'challenge_complete'"],
        weekly_streak: ["'weekly_streak'"],
        steps: ["'steps_total'"],
        calories: ["'calories_total'"],
        distance: ["'distance_total'"],
      };
      const typeFilter = category && categoryMap[category]
        ? `AND a.rule_type IN (${categoryMap[category].join(',')})`
        : '';
      const dateFilter = period === 'weekly'
        ? `AND ua.earned_at >= CURRENT_TIMESTAMP - INTERVAL '7 days'`
        : '';
      rankQuery = `
        SELECT ua.user_id, COUNT(a.id) as score,
               DENSE_RANK() OVER (ORDER BY COUNT(a.id) DESC) as rank
        FROM user_achievements ua
        JOIN achievements a ON a.id = ua.achievement_id
        WHERE 1=1 ${dateFilter} ${typeFilter}
        GROUP BY ua.user_id`;
    }

    const [allRows] = await pool.query(rankQuery);
    const myRow = allRows.find(r => Number(r.user_id) === Number(userId));

    res.json({
      rank: myRow?.rank || null,
      score: myRow?.score || 0,
      total: allRows.length,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};
