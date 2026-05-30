const { pool } = require('../../config/db');

const ISO_YEARWEEK_SQL = `CAST(TO_CHAR(date, 'IYYYIW') AS INTEGER)`;

async function triggerAchievements(userId) {
  try {
    // Get all achievements not yet earned by this user
    const [unearned] = await pool.query(
      `SELECT * FROM achievements
       WHERE is_active = TRUE
       AND id NOT IN (SELECT achievement_id FROM user_achievements WHERE user_id = ?)`,
      [userId]
    );
    if (!unearned.length) return;

    // --- challenge_complete ---
    const [[{ completedCount }]] = await pool.query(
      `SELECT COUNT(*) as completedCount FROM user_challenges WHERE user_id = ? AND status = 'completed'`,
      [userId]
    );

    // --- steps_total / calories_total / distance_total ---
    const [[totals]] = await pool.query(
      `SELECT COALESCE(SUM(steps),0) as steps, COALESCE(SUM(calories),0) as calories, COALESCE(SUM(distance),0) as distance
       FROM activity_logs WHERE user_id = ?`,
      [userId]
    );

    // --- weekly_streak: count consecutive completed weeks (Mon-Sun) with at least 1 active day ---
    // Grace: if current week has no data yet, start from last week to avoid breaking streak on Monday morning
    const [weekRows] = await pool.query(
      `SELECT ${ISO_YEARWEEK_SQL} AS yw FROM activity_logs
       WHERE user_id = ? AND workout_completed = TRUE
       GROUP BY 1 ORDER BY 1 DESC`,
      [userId]
    );
    let weeklyStreak = 0;
    if (weekRows.length > 0) {
      const currentYW = getYearWeek(new Date());
      const weekSet = new Set(weekRows.map(r => r.yw));
      // Start from current week if it has data, otherwise start from last week (grace period)
      let expected = weekSet.has(currentYW) ? currentYW : prevYearWeek(currentYW);
      for (const row of weekRows) {
        if (row.yw === expected) {
          // Only count weeks that are fully in the past OR current week if it already has data
          weeklyStreak++;
          expected = prevYearWeek(expected);
        } else if (row.yw < expected) {
          break; // gap found
        }
      }
    }

    for (const achievement of unearned) {
      let earned = false;
      switch (achievement.rule_type) {
        case 'challenge_complete': earned = completedCount >= achievement.rule_value; break;
        case 'steps_total':        earned = totals.steps >= achievement.rule_value; break;
        case 'calories_total':     earned = totals.calories >= achievement.rule_value; break;
        case 'distance_total':     earned = parseFloat(totals.distance) >= achievement.rule_value; break;
        case 'weekly_streak':      earned = weeklyStreak >= achievement.rule_value; break;
      }
      if (earned) {
        const [insertResult] = await pool.query(
          `INSERT INTO user_achievements (user_id, achievement_id)
           SELECT ?, ?
           WHERE NOT EXISTS (
             SELECT 1 FROM user_achievements WHERE user_id = ? AND achievement_id = ?
           )
           RETURNING id`,
          [userId, achievement.id, userId, achievement.id]
        );
        if (!insertResult.rowCount) {
          continue;
        }

        console.log(`[Achievement] User ${userId} earned "${achievement.title}"`);

        // Send in-app notification
        const { saveNotification } = require('../notification/notification.helper');
        await saveNotification(
          userId,
          `🏅 Badge Earned: ${achievement.title}`,
          achievement.description || `You earned the "${achievement.title}" badge!`,
          'achievement',
          {screen: 'Achievement'}
        );

        // Send push notification if user has FCM token
        const [[userRow]] = await pool.query('SELECT fcm_token FROM users WHERE id = ?', [userId]);
        if (userRow?.fcm_token) {
          const { sendPushNotification } = require('../notification/notification.service');
          await sendPushNotification(
            userRow.fcm_token,
            `🏅 Badge Earned: ${achievement.title}`,
            achievement.description || `You earned the "${achievement.title}" badge!`,
            { type: 'achievement', achievement_id: String(achievement.id) }
          ).catch(() => {});
        }
      }
    }
  } catch (err) {
    console.error('[Achievement] triggerAchievements error:', err.message);
  }
}

// Returns YEARWEEK value as a number (e.g. 202401)
function getYearWeek(date) {
  const d = new Date(date);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const year = d.getUTCFullYear();
  const startOfYear = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((d - startOfYear) / 86400000 + 1) / 7);
  return year * 100 + week;
}

function prevYearWeek(yw) {
  const year = Math.floor(yw / 100);
  const week = yw % 100;
  if (week > 1) return year * 100 + (week - 1);
  // Go to last week of previous year
  const lastWeek = getYearWeek(new Date(Date.UTC(year - 1, 11, 28)));
  return lastWeek;
}

module.exports = { triggerAchievements };
