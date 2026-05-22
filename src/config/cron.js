const cron = require('node-cron');
const axios = require('axios');
const { TrainerPost, TrainerHire } = require('../modules/trainer/trainer.model');
const { Session } = require('../modules/session/session.model');
const Payment = require('../modules/payment/payment.model');
const { UserChallenge } = require('../modules/challenge/challenge.model');
const { pool } = require('./db');
const { triggerAchievements } = require('../modules/achievement/achievement.helper');
const { sendPushNotification, sendMulticastNotification } = require('../modules/notification/notification.service');
const { saveNotification } = require('../modules/notification/notification.helper');
const { reverseMidtransTransaction } = require('./midtrans');

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WIB_CURRENT_DATE_SQL = `(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')::date`;

const MIDTRANS_BASE = process.env.NODE_ENV === 'production'
  ? 'https://api.midtrans.com'
  : 'https://api.sandbox.midtrans.com';

// Get current day name in WIB (UTC+7)
function getTodayNameWIB() {
  const now = new Date(Date.now() + 7 * 60 * 60 * 1000);
  return DAY_NAMES[now.getUTCDay()];
}

function parseDateOnly(value) {
  if (!value) return null;

  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatShortDate(value) {
  const date = parseDateOnly(value);
  if (!date) {
    return String(value || '');
  }

  return date.toLocaleDateString('en-GB', {day: '2-digit', month: 'short'});
}

function getWeatherAdvice(weather) {
  const id = weather.weather[0].id;
  const description = weather.weather[0].description;
  const feelsLike = Math.round(weather.main.feels_like);
  const humidity = weather.main.humidity;
  const gust = weather.wind?.gust || weather.wind?.speed || 0;
  const visibility = weather.visibility || 10000;
  const city = weather.name || 'your area';

  const titleBase = `Good morning! ${city} — feels like ${feelsLike}°C`;

  // 1. Dangerous conditions — thunderstorm, tornado, extreme
  if (id >= 200 && id <= 232)
    return {title: `⛈️ ${titleBase}`, body: `Thunderstorm expected in ${city}. Stay safe indoors and skip outdoor exercise today.`, outdoor: false};
  if (id === 781)
    return {title: `🌪️ ${titleBase}`, body: `Tornado warning in ${city}. Do not go outside — stay safe!`, outdoor: false};

  // 2. Heavy rain / snow / sleet
  if ((id >= 502 && id <= 504) || (id >= 522 && id <= 531))
    return {title: `🌧️ ${titleBase}`, body: `Heavy rain in ${city}. Best to train indoors today — slippery and unsafe outside.`, outdoor: false};
  if (id >= 600 && id <= 622)
    return {title: `❄️ ${titleBase}`, body: `Snow or sleet in ${city}. Roads may be slippery — consider an indoor workout today.`, outdoor: false};

  // 3. Low visibility — fog, haze, dust
  if (visibility < 3000 || (id >= 701 && id <= 771))
    return {title: `🌫️ ${titleBase}`, body: `Low visibility (${Math.round(visibility / 1000)}km) in ${city} due to ${description}. Outdoor exercise not recommended today.`, outdoor: false};

  // 4. Too hot — feels like above 36°C
  if (feelsLike >= 36)
    return {title: `🥵 ${titleBase}`, body: `It feels like ${feelsLike}°C in ${city} — too hot for outdoor exercise. Train indoors and stay hydrated!`, outdoor: false};

  // 5. Light rain / drizzle — not dangerous but not ideal
  if (id >= 300 && id <= 321)
    return {title: `🌦️ ${titleBase}`, body: `Light drizzle in ${city}. You can still exercise but bring a jacket — or opt for indoors if you prefer.`, outdoor: false};
  if (id >= 500 && id <= 501)
    return {title: `🌧️ ${titleBase}`, body: `Light to moderate rain in ${city}. Consider an indoor workout today.`, outdoor: false};

  // 6. Strong gusts
  if (gust >= 10)
    return {title: `💨 ${titleBase}`, body: `Gusty winds (${Math.round(gust)} m/s) in ${city}. Outdoor exercise may be uncomfortable — consider training indoors.`, outdoor: false};

  // 7. High humidity — uncomfortable but manageable
  if (humidity >= 85)
    return {title: `💧 ${titleBase}`, body: `High humidity (${humidity}%) in ${city} today. If you exercise outdoors, take it easy and drink plenty of water. 💪`, outdoor: true};

  // 8. Overcast / broken clouds — decent but not great
  if (id >= 803 && id <= 804)
    return {title: `☁️ ${titleBase}`, body: `Overcast skies in ${city} but conditions are fine for outdoor exercise. Get moving! 🏃`, outdoor: true};

  // 9. Perfect conditions — clear or few/scattered clouds, comfortable temp
  return {title: `🌤️ ${titleBase}`, body: `${description.charAt(0).toUpperCase() + description.slice(1)}, ${feelsLike}°C in ${city} — great conditions for an outdoor workout today! 💪`, outdoor: true};
}

function startCronJobs() {
  // Ensure last_lat/last_lon columns exist for weather cron
  pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS last_lat DECIMAL(10,7) NULL').catch(() => {});
  pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS last_lon DECIMAL(10,7) NULL').catch(() => {});
  pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_prefs TEXT NULL').catch(() => {});
  pool.query('ALTER TABLE achievements ADD COLUMN IF NOT EXISTS icon VARCHAR(100) NULL').catch(() => {});

  // ── 8AM WIB daily — weather notification to all users with FCM token + location ──
  // WIB = UTC+7, so 8AM WIB = 1AM UTC → cron: '0 1 * * *'
  cron.schedule('0 1 * * *', async () => {
    console.log('[CRON] Sending morning weather notifications...');
    try {
      const [users] = await pool.query(
        "SELECT id, fcm_token, last_lat, last_lon, notification_prefs FROM users WHERE fcm_token IS NOT NULL AND fcm_token <> '' AND last_lat IS NOT NULL AND last_lon IS NOT NULL"
      );
      for (const user of users) {
        try {
          const prefs = user.notification_prefs ? JSON.parse(user.notification_prefs) : {};
          if (prefs.weather === false) continue;
          const weatherRes = await axios.get('https://api.openweathermap.org/data/2.5/weather', {
            params: {lat: user.last_lat, lon: user.last_lon, appid: process.env.OPENWEATHER_API_KEY, units: 'metric'},
          });
          const advice = getWeatherAdvice(weatherRes.data);
          await sendPushNotification(user.fcm_token, advice.title, advice.body, {type: 'weather', outdoor: String(advice.outdoor)});
          await saveNotification(user.id, advice.title, advice.body, 'general');
        } catch (err) {
          console.error(`[CRON] Weather notif failed for user ${user.id}:`, err.message);
        }
      }
    } catch (err) {
      console.error('[CRON] Weather cron error:', err.message);
    }
  });

  // ── 10PM WIB daily — sync reminder + workout plan check ──
  // WIB = UTC+7, so 10PM WIB = 3PM UTC → cron: '0 15 * * *'
  cron.schedule('0 15 * * *', async () => {
    console.log('[CRON] Sending evening reminders...');
    try {
      const todayName = getTodayNameWIB();
      const [users] = await pool.query(
        "SELECT id, fcm_token, notification_prefs FROM users WHERE fcm_token IS NOT NULL AND fcm_token <> '' AND role = 'member'"
      );
      for (const user of users) {
        try {
          const prefs = user.notification_prefs ? JSON.parse(user.notification_prefs) : {};
          // Check if user has workout plan items for today that are not done
          const [pendingItems] = await pool.query(
            `SELECT wpi.id FROM workout_plan_items wpi
             JOIN workout_plans wp ON wp.id = wpi.workout_plan_id
             WHERE wp.user_id = ? AND wpi.day = ? AND wpi.is_done = FALSE`,
            [user.id, todayName]
          );

          if (pendingItems.length > 0) {
            if (prefs.workout_reminder !== false) {
              const workoutTitle = '💪 Workout Reminder';
              const workoutBody = `You have ${pendingItems.length} workout${pendingItems.length > 1 ? 's' : ''} left for today. Don't forget to complete them!`;
              await sendPushNotification(user.fcm_token, workoutTitle, workoutBody, {type: 'workout_reminder'});
              await saveNotification(user.id, workoutTitle, workoutBody, 'general');
            }
          }

          if (prefs.sync_reminder !== false) {
            const syncTitle = '📊 Sync Your Health Data';
            const syncBody = 'Remember to sync your Health Connect data to keep your progress up to date!';
            await sendPushNotification(user.fcm_token, syncTitle, syncBody, {type: 'sync_reminder'});
            await saveNotification(user.id, syncTitle, syncBody, 'general');
          }
        } catch (err) {
          console.error(`[CRON] Evening reminder failed for user ${user.id}:`, err.message);
        }
      }
    } catch (err) {
      console.error('[CRON] Evening reminder cron error:', err.message);
    }
  });

  // Runs every hour — checks expired trainer hire approvals
  cron.schedule('0 * * * *', async () => {
    // Mark overdue sessions as missed and notify both parties
    try {
      // Get sessions about to be marked missed before updating
      const [missedSessions] = await pool.query(
        `SELECT hs.id, hs.hire_id, hs.scheduled_date, hs.scheduled_day, hs.scheduled_start,
                th.member_id, th.post_id,
                m.fcm_token AS member_fcm, m.name AS member_name,
                t.fcm_token AS trainer_fcm, t.id AS trainer_id,
                tp.title AS post_title
         FROM hire_sessions hs
         JOIN trainer_hires th ON th.id = hs.hire_id
         JOIN trainer_posts tp ON tp.id = th.post_id
         JOIN users m ON m.id = th.member_id
         JOIN users t ON t.id = tp.trainer_id
         WHERE ((hs.status = 'upcoming' AND hs.scheduled_date < ${WIB_CURRENT_DATE_SQL})
             OR (hs.status = 'started' AND hs.code_expires_at < CURRENT_TIMESTAMP))
            AND hs.scheduled_date <= th.end_date`
      );
      await Session.markMissed();
      for (const s of missedSessions) {
        const dateStr = formatShortDate(s.scheduled_date);
        const mTitle = 'Session Missed';
        const mBody = `Your session for "${s.post_title}" on ${dateStr} was missed.`;
        await saveNotification(s.member_id, mTitle, mBody, 'session');
        if (s.member_fcm) sendPushNotification(s.member_fcm, mTitle, mBody, {type: 'session_missed', session_id: String(s.id)}).catch(() => {});
        const tTitle = 'Session Missed';
        const tBody = `${s.member_name} missed the session for "${s.post_title}" on ${dateStr}.`;
        await saveNotification(s.trainer_id, tTitle, tBody, 'session');
        if (s.trainer_fcm) sendPushNotification(s.trainer_fcm, tTitle, tBody, {type: 'session_missed', session_id: String(s.id)}).catch(() => {});
      }
    } catch (err) { console.error('[CRON] markMissed error:', err.message); }

    console.log('[CRON] Checking expired trainer hire approvals...');
    try {
      const expiredHires = await TrainerHire.findPendingExpired();
      for (const hire of expiredHires) {
        try {
          console.log('[Cron] Reversing expired hire payment, orderId:', hire.payment_order_id);
          const reversal = await reverseMidtransTransaction(
            hire.payment_order_id,
            `Trainer response deadline expired for hire ${hire.id}`
          );

          let paymentStatus = 'failed';
          if (reversal.action === 'refunded') paymentStatus = 'refunded';
          if (reversal.action === 'partial_refund') paymentStatus = 'partial_refund';
          if (reversal.action === 'expire') paymentStatus = 'expired';

          await Payment.findOneAndUpdate(
            { order_id: hire.payment_order_id },
            { status: paymentStatus, updated_at: new Date() }
          );
          await TrainerHire.updateStatus(hire.id, 'expired');
          await TrainerPost.reactivateIfSystemClosed(hire.post_id);
          console.log(`[CRON] Expired hire ${hire.id}`);

          // Notify trainer — request expired without their action
          const trainerTitle = 'Hire Request Expired';
          const trainerBody = `The hire request from ${hire.member_name} for "${hire.post_title}" has expired. The payment has been refunded.`;
          await saveNotification(hire.trainer_user_id, trainerTitle, trainerBody, 'trainer_hire');
          if (hire.trainer_fcm_token) {
            sendPushNotification(hire.trainer_fcm_token, trainerTitle, trainerBody, { type: 'trainer_hire_expired' })
              .catch(err => console.error(`[CRON] FCM trainer notif failed for hire ${hire.id}:`, err.message));
          }

          // Notify member — their request expired, post is available again
          const memberTitle = 'Hire Request Expired';
          const memberBody = `Your hire request for "${hire.post_title}" expired because the trainer did not respond in time. You can hire them again.`;
          await saveNotification(hire.member_id, memberTitle, memberBody, 'trainer_hire');
          if (hire.member_fcm_token) {
            sendPushNotification(hire.member_fcm_token, memberTitle, memberBody, {
              type: 'trainer_hire_expired',
              post_id: String(hire.post_id),
            }).catch(err => console.error(`[CRON] FCM member notif failed for hire ${hire.id}:`, err.message));
          }
        } catch (err) {
          console.error(`[CRON] Failed to cancel hire ${hire.id}:`, err.message);
        }
      }
    } catch (err) {
      console.error('[CRON] Error in hire expiry job:', err.message);
    }
  });

  // Runs daily at midnight — cohort program start: activate enrolled hires + close full posts past deadline
  cron.schedule('0 0 * * *', async () => {
    console.log('[CRON] Checking cohort program starts and enrollment deadlines...');
    try {
      // 1. Activate enrolled hires whose program_start_date has arrived
      const activatedHires = await TrainerHire.activateReadyEnrolledHires();
      for (const hire of activatedHires) {
        try {
          // Notify member
          const mTitle = 'Your Program Has Started!';
          const mBody = `"${hire.post_title}" has officially started. Good luck!`;
          await saveNotification(hire.member_id, mTitle, mBody, 'trainer_hire');
          if (hire.member_fcm_token) {
            sendPushNotification(hire.member_fcm_token, mTitle, mBody, {type: 'trainer_hire_active'})
              .catch(err => console.error(`[CRON] FCM program start member ${hire.id}:`, err.message));
          }
        } catch (err) {
          console.error(`[CRON] Failed to activate enrolled hire ${hire.id}:`, err.message);
        }
      }
      // Notify trainer once per post about program start
      const postGroups = activatedHires.reduce((acc, h) => {
        if (!acc[h.post_id]) acc[h.post_id] = h;
        return acc;
      }, {});
      for (const hire of Object.values(postGroups)) {
        const [[{ cnt }]] = await pool.query(
          "SELECT COUNT(*) AS cnt FROM trainer_hires WHERE post_id = ? AND status = 'active'",
          [hire.post_id]
        );
        const tTitle = 'Program Started';
        const tBody = `"${hire.post_title}" has started with ${cnt} active member${cnt !== 1 ? 's' : ''}.`;
        await saveNotification(hire.trainer_user_id, tTitle, tBody, 'trainer_hire');
        if (hire.trainer_fcm_token) {
          sendPushNotification(hire.trainer_fcm_token, tTitle, tBody, {type: 'trainer_hire_active'})
            .catch(err => console.error(`[CRON] FCM program start trainer post ${hire.post_id}:`, err.message));
        }
      }

      // 2. Auto-close posts whose enrollment_deadline has passed
      const [expiredPosts] = await pool.query(
        `SELECT tp.id, tp.title, tp.trainer_id, u.fcm_token AS trainer_fcm_token,
                (SELECT COUNT(*) FROM trainer_hires WHERE post_id = tp.id AND status IN ('enrolled','active')) AS enrolled_count
         FROM trainer_posts tp
         JOIN users u ON u.id = tp.trainer_id
         WHERE tp.is_active = TRUE AND tp.enrollment_deadline < ${WIB_CURRENT_DATE_SQL} AND tp.visibility = 'public'`
      );
      for (const post of expiredPosts) {
        try {
          await pool.query("UPDATE trainer_posts SET is_active = FALSE, deactivated_by = 'system' WHERE id = ?", [post.id]);
          const tTitle = 'Enrollment Closed';
          const tBody = `Enrollment for "${post.title}" has closed with ${post.enrolled_count} member${post.enrolled_count !== 1 ? 's' : ''} enrolled.`;
          await saveNotification(post.trainer_id, tTitle, tBody, 'trainer_hire');
          if (post.trainer_fcm_token) {
            sendPushNotification(post.trainer_fcm_token, tTitle, tBody, {type: 'enrollment_closed'})
              .catch(err => console.error(`[CRON] FCM enrollment closed post ${post.id}:`, err.message));
          }
        } catch (err) {
          console.error(`[CRON] Failed to close post ${post.id}:`, err.message);
        }
      }
    } catch (err) {
      console.error('[CRON] Error in cohort/deadline job:', err.message);
    }
  });

  // Runs daily at midnight — checks auto challenges against activity_logs
  cron.schedule('0 0 * * *', async () => {
    console.log('[CRON] Checking auto challenge progress...');
    try {
      const activeChallenges = await UserChallenge.findActiveAuto();

      for (const uc of activeChallenges) {
        try {
          const metric = uc.type; // 'steps', 'calories', or 'distance'
          const col = metric === 'distance' ? 'distance' : metric === 'calories' ? 'calories' : 'steps';

          const [[{ total }]] = await pool.query(
            `SELECT COALESCE(SUM(${col}), 0) as total
             FROM activity_logs
             WHERE user_id = ? AND date BETWEEN ? AND ?`,
            [uc.user_id, uc.start_date, uc.end_date]
          );

          await UserChallenge.updateProgress(uc.user_challenge_id, total);

          if (total >= uc.target_value) {
            await UserChallenge.complete(uc.user_challenge_id);
            await triggerAchievements(uc.user_id);
            // Notify member of challenge completion
            const [[challengeRow]] = await pool.query(
              'SELECT c.title, u.fcm_token FROM challenges c, users u WHERE c.id = ? AND u.id = ?',
              [uc.challenge_id, uc.user_id]
            );
            const cTitle = '🏆 Challenge Completed!';
            const cBody = `You completed the "${challengeRow?.title || 'challenge'}"! Great work!`;
            await saveNotification(uc.user_id, cTitle, cBody, 'achievement');
            if (challengeRow?.fcm_token) sendPushNotification(challengeRow.fcm_token, cTitle, cBody, {type: 'challenge_complete', challenge_id: String(uc.challenge_id)}).catch(() => {});
            console.log(`[CRON] User ${uc.user_id} completed challenge ${uc.challenge_id}`);
          }
        } catch (err) {
          console.error(`[CRON] Error checking challenge ${uc.challenge_id} for user ${uc.user_id}:`, err.message);
        }
      }
    } catch (err) {
      console.error('[CRON] Error in challenge check job:', err.message);
    }
  });
}

module.exports = startCronJobs;
module.exports.getWeatherAdvice = getWeatherAdvice;
