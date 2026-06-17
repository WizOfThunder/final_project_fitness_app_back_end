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
const { reverseMidtransTransaction, getMidtransTransactionStatus } = require('./midtrans');

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WIB_TIMEZONE = 'Asia/Jakarta';
const WIB_CURRENT_DATE_SQL = `(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')::date`;

const MIDTRANS_BASE = process.env.NODE_ENV === 'production'
  ? 'https://api.midtrans.com'
  : 'https://api.sandbox.midtrans.com';

function mapMidtransPaymentStatus(transactionStatus, fraudStatus) {
  if (transactionStatus === 'capture' && fraudStatus === 'accept') return 'settlement';
  if (transactionStatus === 'settlement') return 'settlement';
  if (transactionStatus === 'refund') return 'refunded';
  if (transactionStatus === 'partial_refund') return 'partial_refund';
  if (transactionStatus === 'expire') return 'expired';
  if (['cancel', 'deny'].includes(transactionStatus)) return 'failed';
  return 'pending';
}

function getNowWIB() {
  return new Date(Date.now() + 7 * 60 * 60 * 1000);
}

function getTodayNameWIB() {
  const now = getNowWIB();
  return DAY_NAMES[now.getUTCDay()];
}

function getWeekStartWIB() {
  const now = getNowWIB();
  const day = now.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() + diff);
  return monday.getUTCFullYear() + '-'
    + String(monday.getUTCMonth() + 1).padStart(2, '0') + '-'
    + String(monday.getUTCDate()).padStart(2, '0');
}

function getReversalPaymentStatus(reversal) {
  if (reversal.action === 'refunded') return 'refunded';
  if (reversal.action === 'partial_refund') return 'partial_refund';
  if (reversal.action === 'expire') return 'expired';
  if (reversal.action === 'cancelled') return 'failed';

  const txStatus = reversal.status?.transaction_status;
  if (txStatus === 'refund') return 'refunded';
  if (txStatus === 'partial_refund') return 'partial_refund';
  if (txStatus === 'expire') return 'expired';
  if (txStatus === 'settlement' || txStatus === 'capture') return 'settlement';
  return 'failed';
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
  // ── 8AM WIB daily — weather notification to members/trainers with FCM token + location ──
  cron.schedule('0 8 * * *', async () => {
    console.log('[CRON] Sending morning weather notifications...');
    try {
      const [users] = await pool.query(
        "SELECT id, fcm_token, last_lat, last_lon, notification_prefs FROM users WHERE role IN ('member', 'trainer') AND fcm_token IS NOT NULL AND fcm_token <> '' AND last_lat IS NOT NULL AND last_lon IS NOT NULL"
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
  }, { timezone: WIB_TIMEZONE });

  // ── 6PM WIB daily — workout reminder for pending plans ──
  cron.schedule('0 18 * * *', async () => {
    console.log('[CRON] Sending workout reminders...');
    try {
      const todayName = getTodayNameWIB();
      const weekStart = getWeekStartWIB();
      const [users] = await pool.query(
        "SELECT id, fcm_token, notification_prefs FROM users WHERE fcm_token IS NOT NULL AND fcm_token <> '' AND role = 'member'"
      );
      for (const user of users) {
        try {
          const prefs = user.notification_prefs ? JSON.parse(user.notification_prefs) : {};
          const [[pendingRow]] = await pool.query(
            `SELECT COUNT(*)::int AS pending_count
              FROM workout_plan_items wpi
               JOIN workout_plans wp ON wp.id = wpi.workout_plan_id
              WHERE wp.id = (
                SELECT wp_latest.id
                FROM workout_plans wp_latest
                WHERE wp_latest.user_id = ?
                  AND wp_latest.generated_by = 'ai'
                ORDER BY wp_latest.created_at DESC, wp_latest.id DESC
                LIMIT 1
              )
                AND wp.status IN ('draft', 'verified')
                AND wpi.day = ?
                AND (wpi.is_done IS DISTINCT FROM TRUE OR wpi.week_start IS NULL OR wpi.week_start <> ?)`,
            [user.id, todayName, weekStart]
          );
          const pendingCount = Number(pendingRow?.pending_count || 0);

          if (pendingCount > 0) {
            if (prefs.workout_reminder !== false) {
              const workoutTitle = '💪 Workout Reminder';
              const workoutBody = `You have ${pendingCount} workout${pendingCount > 1 ? 's' : ''} left for today. Don't forget to complete them!`;
              await sendPushNotification(user.fcm_token, workoutTitle, workoutBody, {type: 'workout_reminder'});
              await saveNotification(user.id, workoutTitle, workoutBody, 'general');
            }
          }
        } catch (err) {
          console.error(`[CRON] Workout reminder failed for user ${user.id}:`, err.message);
        }
      }
    } catch (err) {
      console.error('[CRON] Workout reminder cron error:', err.message);
    }
  }, { timezone: WIB_TIMEZONE });

  // ── 10PM WIB daily — sync reminder only ──
  cron.schedule('0 22 * * *', async () => {
    console.log('[CRON] Sending sync reminders...');
    try {
      const [users] = await pool.query(
        "SELECT id, fcm_token, notification_prefs FROM users WHERE fcm_token IS NOT NULL AND fcm_token <> '' AND role = 'member'"
      );
      for (const user of users) {
        try {
          const prefs = user.notification_prefs ? JSON.parse(user.notification_prefs) : {};
          if (prefs.sync_reminder !== false) {
            const syncTitle = '📊 Sync Your Health Data';
            const syncBody = 'Remember to sync your Health Connect data to keep your progress up to date!';
            await sendPushNotification(user.fcm_token, syncTitle, syncBody, {type: 'sync_reminder'});
            await saveNotification(user.id, syncTitle, syncBody, 'general');
          }
        } catch (err) {
          console.error(`[CRON] Sync reminder failed for user ${user.id}:`, err.message);
        }
      }
    } catch (err) {
      console.error('[CRON] Sync reminder cron error:', err.message);
    }
  }, { timezone: WIB_TIMEZONE });

  cron.schedule('0 * * * *', async () => {
    try {
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

          const paymentStatus = getReversalPaymentStatus(reversal);

          await Payment.findOneAndUpdate(
            { order_id: hire.payment_order_id },
            { status: paymentStatus, updated_at: new Date() }
          );
          await TrainerHire.updateStatus(hire.id, 'expired');
          await TrainerPost.reactivateIfSystemClosed(hire.post_id);
          console.log(`[CRON] Expired hire ${hire.id}`);

          const trainerTitle = 'Hire Request Expired';
          const trainerBody = paymentStatus === 'settlement'
            // ? `The hire request from ${hire.member_name} for "${hire.post_title}" has expired. Midtrans still shows the payment as settled, so refund must be handled manually.`
            ? `The hire request from ${hire.member_name} for "${hire.post_title}" has expired. The payment has been refunded.`
            : `The hire request from ${hire.member_name} for "${hire.post_title}" has expired. The payment has been refunded.`;
          await saveNotification(hire.trainer_user_id, trainerTitle, trainerBody, 'trainer_hire');
          if (hire.trainer_fcm_token) {
            sendPushNotification(hire.trainer_fcm_token, trainerTitle, trainerBody, { type: 'trainer_hire_expired' })
              .catch(err => console.error(`[CRON] FCM trainer notif failed for hire ${hire.id}:`, err.message));
          }

          const memberTitle = 'Hire Request Expired';
          const memberBody = paymentStatus === 'settlement'
            // ? `Your hire request for "${hire.post_title}" expired because the trainer did not respond in time. Midtrans still shows the payment as settled, so refund must be handled manually before you hire again.`
            ? `Your hire request for "${hire.post_title}" expired because the trainer did not respond in time. You can hire them again.`
            : `Your hire request for "${hire.post_title}" expired because the trainer did not respond in time. You can hire them again.`;
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

    console.log('[CRON] Checking completed private hires...');
    try {
      const completedPrivateHires = await TrainerHire.findPrivateAutoEndReady();
      for (const hire of completedPrivateHires) {
        try {
          const ended = await TrainerHire.completeByEndDate(hire.id);
          if (!ended) {
            continue;
          }

          await TrainerPost.reactivateIfSystemClosed(hire.post_id);
          console.log(`[CRON] Auto-ended private hire ${hire.id}`);

          const memberTitle = 'Subscription Completed';
          const memberBody = `Your subscription to "${hire.post_title}" has completed. You can now leave a review.`;
          await saveNotification(hire.member_id, memberTitle, memberBody, 'trainer_hire');
          if (hire.member_fcm_token) {
            sendPushNotification(hire.member_fcm_token, memberTitle, memberBody, {
              type: 'hire_ended',
              hire_id: String(hire.id),
              post_id: String(hire.post_id),
            }).catch(err =>
              console.error(`[CRON] FCM member completion notif failed for hire ${hire.id}:`, err.message)
            );
          }

          const trainerTitle = 'Subscription Completed';
          const trainerBody = `Your private subscription with ${hire.member_name} for "${hire.post_title}" has reached its end date.`;
          await saveNotification(hire.trainer_user_id, trainerTitle, trainerBody, 'trainer_hire', {
            screen: 'TrainerHireManagement',
            params: { initialTab: 'past', hireId: hire.id },
          });
          if (hire.trainer_fcm_token) {
            sendPushNotification(hire.trainer_fcm_token, trainerTitle, trainerBody, {
              type: 'hire_ended',
              hire_id: String(hire.id),
              post_id: String(hire.post_id),
            }).catch(err =>
              console.error(`[CRON] FCM trainer completion notif failed for hire ${hire.id}:`, err.message)
            );
          }
        } catch (err) {
          console.error(`[CRON] Failed to auto-end private hire ${hire.id}:`, err.message);
        }
      }
    } catch (err) {
      console.error('[CRON] Error in private hire completion job:', err.message);
    }

    console.log('[CRON] Checking completed public hires...');
    try {
      const completedPublicHires = await TrainerHire.findPublicAutoEndReady();
      for (const hire of completedPublicHires) {
        try {
          const ended = await TrainerHire.completeByEndDate(hire.id);
          if (!ended) {
            continue;
          }

          const rollover = await TrainerPost.rolloverPublicAfterCompletion(
            hire.post_id,
            hire.end_date,
          );
          console.log(`[CRON] Auto-ended public hire ${hire.id}`);

          const memberTitle = 'Subscription Completed';
          const memberBody = `Your subscription to "${hire.post_title}" has completed. You can now leave a review.`;
          await saveNotification(hire.member_id, memberTitle, memberBody, 'trainer_hire');
          if (hire.member_fcm_token) {
            sendPushNotification(hire.member_fcm_token, memberTitle, memberBody, {
              type: 'hire_ended',
              hire_id: String(hire.id),
              post_id: String(hire.post_id),
            }).catch(err =>
              console.error(`[CRON] FCM member public completion notif failed for hire ${hire.id}:`, err.message)
            );
          }

          const trainerTitle = 'Program Completed';
          const trainerBody = rollover
            ? `Your public program "${hire.post_title}" has reached its end date for ${hire.member_name}. The post is active again with enrollment open until ${rollover.enrollment_deadline}, and the next program starts on ${rollover.program_start_date}.`
            : `Your public program "${hire.post_title}" has reached its end date for ${hire.member_name}. The post will reopen automatically after the remaining active members in this cohort finish.`;
          await saveNotification(hire.trainer_user_id, trainerTitle, trainerBody, 'trainer_hire', {
            screen: 'TrainerHireManagement',
            params: { initialTab: 'past', hireId: hire.id },
          });
          if (hire.trainer_fcm_token) {
            sendPushNotification(hire.trainer_fcm_token, trainerTitle, trainerBody, {
              type: 'hire_ended',
              hire_id: String(hire.id),
              post_id: String(hire.post_id),
            }).catch(err =>
              console.error(`[CRON] FCM trainer public completion notif failed for hire ${hire.id}:`, err.message)
            );
          }
        } catch (err) {
          console.error(`[CRON] Failed to auto-end public hire ${hire.id}:`, err.message);
        }
      }
    } catch (err) {
      console.error('[CRON] Error in public hire completion job:', err.message);
    }

    console.log('[CRON] Syncing stale pending payments with Midtrans...');
    try {
      const staleThreshold = new Date(Date.now() - 30 * 60 * 1000);
      const [stalePayments] = await pool.query(
        `SELECT p.id, p.order_id, p.status, p.transaction_id, p.payment_type
         FROM payments p
         WHERE p.status = 'pending' AND p.created_at < ?`,
        [staleThreshold],
      );

      for (const payment of stalePayments) {
        try {
          if (payment.order_id.startsWith('hire-')) {
            const [[hire]] = await pool.query(
              'SELECT id, status FROM trainer_hires WHERE payment_order_id = ?',
              [payment.order_id],
            );

            if (hire && ['expired', 'cancelled', 'ended'].includes(hire.status)) {
              const terminalStatus = hire.status === 'cancelled' ? 'failed' : hire.status;
              await Payment.findOneAndUpdate(
                { order_id: payment.order_id },
                { status: terminalStatus, updated_at: new Date() },
              );
              console.log(`[CRON] Payment ${payment.order_id} synced to ${terminalStatus} (hire ${hire.id} is ${hire.status})`);
              continue;
            }
          }

          const midtrans = await getMidtransTransactionStatus(payment.order_id);
          const mappedStatus = mapMidtransPaymentStatus(
            midtrans.transaction_status,
            midtrans.fraud_status,
          );

          if (mappedStatus === 'pending') {
            continue;
          }

          await Payment.findOneAndUpdate(
            { order_id: payment.order_id },
            {
              status: mappedStatus,
              transaction_id: midtrans.transaction_id || payment.transaction_id,
              payment_type: midtrans.payment_type || payment.payment_type,
              updated_at: new Date(),
            },
          );
          console.log(`[CRON] Payment ${payment.order_id} synced: ${payment.status} → ${mappedStatus}`);

          if (payment.order_id.startsWith('hire-')) {
            if (mappedStatus === 'settlement') {
              const [[hirePost]] = await pool.query(
                'SELECT tp.visibility FROM trainer_hires th JOIN trainer_posts tp ON tp.id = th.post_id WHERE th.payment_order_id = ?',
                [payment.order_id],
              );
              if (hirePost?.visibility === 'public') {
                const hire = await TrainerHire.activateFromPayment(payment.order_id);
                if (hire) {
                  const startStr = hire.program_start_date
                    ? new Date(hire.program_start_date).toLocaleDateString('en-GB', {day: '2-digit', month: 'short', year: 'numeric'})
                    : 'the scheduled date';
                  const mTitle = 'Enrollment Confirmed!';
                  const mBody = `You're enrolled in "${hire.post_title}". The program starts on ${startStr}.`;
                  await saveNotification(hire.member_id, mTitle, mBody, 'trainer_hire');
                  if (hire.member_fcm_token) {
                    sendPushNotification(hire.member_fcm_token, mTitle, mBody, {type: 'trainer_enrolled', post_id: String(hire.post_id)}).catch(() => {});
                  }
                  const tTitle = 'New Enrollment';
                  const tBody = `${hire.member_name} enrolled in "${hire.post_title}". Program starts ${startStr}.`;
                  await saveNotification(hire.trainer_id, tTitle, tBody, 'trainer_hire');
                  if (hire.trainer_fcm_token) {
                    sendPushNotification(hire.trainer_fcm_token, tTitle, tBody, {type: 'trainer_enrolled'}).catch(() => {});
                  }
                }
              } else {
                const deadline = await TrainerHire.setPendingTrainerResponse(payment.order_id);
                if (deadline) {
                  const [[hireInfo]] = await pool.query(
                    `SELECT th.member_id, m.name AS member_name, tp.title AS post_title, t.id AS trainer_id, t.fcm_token AS trainer_fcm
                     FROM trainer_hires th
                     JOIN trainer_posts tp ON tp.id = th.post_id
                     JOIN users m ON m.id = th.member_id
                     JOIN users t ON t.id = tp.trainer_id
                     WHERE th.payment_order_id = ?`,
                    [payment.order_id],
                  );
                  if (hireInfo) {
                    const deadlineStr = new Date(deadline).toLocaleDateString('en-GB', {day: '2-digit', month: 'short', year: 'numeric'});
                    const tTitle = 'New Hire Request';
                    const tBody = `${hireInfo.member_name} wants to hire you for "${hireInfo.post_title}". Please accept or decline by ${deadlineStr}.`;
                    await saveNotification(hireInfo.trainer_id, tTitle, tBody, 'trainer_hire');
                    if (hireInfo.trainer_fcm) {
                      sendPushNotification(hireInfo.trainer_fcm, tTitle, tBody, {type: 'trainer_hire_request'}).catch(() => {});
                    }
                  }
                }
              }
            } else if (['failed', 'expired', 'refunded', 'partial_refund'].includes(mappedStatus)) {
              await TrainerHire.cancelPendingPayment(payment.order_id);
              console.log(`[CRON] Cancelled hire for payment ${payment.order_id}`);
            }
          }
        } catch (err) {
          console.error(`[CRON] Failed to sync payment ${payment.order_id}:`, err.message);
        }
      }
    } catch (err) {
      console.error('[CRON] Error in pending payment sync:', err.message);
    }
  });

  cron.schedule('0 0 * * *', async () => {
    console.log('[CRON] Checking cohort program starts and enrollment deadlines...');
    try {
      const activatedHires = await TrainerHire.activateReadyEnrolledHires();
      for (const hire of activatedHires) {
        try {
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

  cron.schedule('0 0 * * *', async () => {
    console.log('[CRON] Checking auto challenge progress...');
    try {
      const activeChallenges = await UserChallenge.findActiveAuto();

      for (const uc of activeChallenges) {
        try {
          const metric = uc.type;
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
