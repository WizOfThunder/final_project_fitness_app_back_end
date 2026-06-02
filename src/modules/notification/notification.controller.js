const User = require('../users/user.model');
const { sendPushNotification, sendMulticastNotification } = require('./notification.service');
const { saveNotification } = require('./notification.helper');
const axios = require('axios');
const { pool } = require('../../config/db');
const { getWeatherAdvice } = require('../../config/cron');

const ADMIN_NOTIFICATION_FILTER_SQL = `
  user_id = ?
  AND (
    (type = 'dispute' AND title = 'New Hire Dispute')
    OR (type = 'general' AND title = 'New Trainer Registration')
    OR type IN (
      'admin_validation_request',
      'admin_challenge_submission',
      'admin_challenge_review'
    )
  )
`;

function parseNotificationData(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'object') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

function parseNotificationPrefs(value) {
  if (!value) {
    return {};
  }

  if (typeof value === 'object') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch (_) {
    return {};
  }
}

function parseCoordinates(body) {
  const lat = Number(body?.lat);
  const lon = Number(body?.lon);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }

  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return null;
  }

  return { lat, lon };
}

exports.getMyNotifications = async (req, res) => {
  try {
    const isAdmin = req.user?.role === 'admin';
    const [rows] = await pool.query(
      `SELECT * FROM notifications WHERE ${isAdmin ? ADMIN_NOTIFICATION_FILTER_SQL : 'user_id = ?'} ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json(
      rows.map(row => ({
        ...row,
        data: parseNotificationData(row.data),
      }))
    );
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.markAllRead = async (req, res) => {
  try {
    const isAdmin = req.user?.role === 'admin';
    await pool.query(
      `UPDATE notifications SET is_read = TRUE WHERE ${isAdmin ? ADMIN_NOTIFICATION_FILTER_SQL : 'user_id = ?'}`,
      [req.user.id],
    );
    res.json({ message: 'All notifications marked as read' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.updateFcmToken = async (req, res) => {
  try {
    const { fcm_token } = req.body;
    await User.findByIdAndUpdate(req.user.id, { fcm_token });
    res.json({ message: 'FCM token updated' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.updateWeatherLocation = async (req, res) => {
  try {
    const coordinates = parseCoordinates(req.body);
    if (!coordinates) {
      return res.status(400).json({ error: 'valid lat and lon are required' });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const prefs = parseNotificationPrefs(user.notification_prefs);
    if (prefs.weather === false) {
      return res.json({ message: 'Weather notifications disabled', skipped: true });
    }

    await pool.query('UPDATE users SET last_lat = ?, last_lon = ? WHERE id = ?', [coordinates.lat, coordinates.lon, req.user.id]);
    res.json({ message: 'Weather location updated' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.sendNotification = async (req, res) => {
  try {
    const { user_id, title, body, data } = req.body;
    const user = await User.findById(user_id);
    if (!user || !user.fcm_token) return res.status(404).json({ error: 'User or FCM token not found' });
    await sendPushNotification(user.fcm_token, title, body, data);
    res.json({ message: 'Notification sent' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.sendBroadcast = async (req, res) => {
  try {
    const { title, body, data } = req.body;
    const [users] = await pool.query("SELECT fcm_token FROM users WHERE fcm_token IS NOT NULL AND fcm_token <> ''");
    const tokens = users.map(u => u.fcm_token);
    if (tokens.length === 0) return res.status(404).json({ error: 'No users with FCM tokens found' });
    await sendMulticastNotification(tokens, title, body, data);
    res.json({ message: 'Broadcast sent', count: tokens.length });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// TEMPORARY: for FCM testing only — remove before production
exports.testSelf = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user?.fcm_token) return res.status(404).json({ error: 'No FCM token found for your account. Make sure the app has notification permission.' });
    await sendPushNotification(
      user.fcm_token,
      '🔔 Test Notification',
      'FCM is working correctly on this device!',
      { type: 'test' }
    );
    res.json({ message: 'Test notification sent to your device.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.sendWeatherNotification = async (req, res) => {
  try {
    const coordinates = parseCoordinates(req.body);
    if (!coordinates) return res.status(400).json({ error: 'valid lat and lon are required' });

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!['member', 'trainer'].includes(user.role)) {
      return res.status(403).json({
        error: 'Weather notifications are only available for members and trainers',
      });
    }

    await pool.query('UPDATE users SET last_lat = ?, last_lon = ? WHERE id = ?', [coordinates.lat, coordinates.lon, req.user.id]);

    const weatherRes = await axios.get('https://api.openweathermap.org/data/2.5/weather', {
      params: { lat: coordinates.lat, lon: coordinates.lon, appid: process.env.OPENWEATHER_API_KEY, units: 'metric' }
    });

    const advice = getWeatherAdvice(weatherRes.data);
    if (!user.fcm_token) return res.status(404).json({ error: 'FCM token not found' });

    await sendPushNotification(user.fcm_token, advice.title, advice.body, {type: 'weather', outdoor: String(advice.outdoor)});
    await saveNotification(req.user.id, advice.title, advice.body, 'general');

    res.json({ message: 'Weather notification sent', outdoor: advice.outdoor });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
