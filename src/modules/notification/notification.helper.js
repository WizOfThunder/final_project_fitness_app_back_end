const { pool } = require('../../config/db');

function normalizeLegacyMysqlText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[^\u0000-\u00FF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function insertNotification(userId, title, message, type) {
  await pool.query(
    'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
    [userId, title, message, type]
  );
}

async function insertNotificationWithData(userId, title, message, type, data) {
  await pool.query(
    'INSERT INTO notifications (user_id, title, message, type, data) VALUES (?, ?, ?, ?, ?)',
    [userId, title, message, type, data]
  );
}

function serializeNotificationData(data) {
  if (!data) {
    return null;
  }

  try {
    return JSON.stringify(data);
  } catch (error) {
    console.error('serializeNotificationData error:', error.message);
    return null;
  }
}

async function saveNotification(
  userId,
  title,
  message,
  type = 'general',
  data = null,
) {
  const serializedData = serializeNotificationData(data);

  try {
    if (serializedData) {
      try {
        await insertNotificationWithData(
          userId,
          title,
          message,
          type,
          serializedData,
        );
        return;
      } catch (err) {
        if (!err || err.errno !== 1054) {
          throw err;
        }
      }
    }

    await insertNotification(userId, title, message, type);
  } catch (err) {
    if (err && err.errno === 1366) {
      try {
        if (serializedData) {
          try {
            await insertNotificationWithData(
              userId,
              normalizeLegacyMysqlText(title) || 'Notification',
              normalizeLegacyMysqlText(message) ||
                'You have a new notification.',
              type,
              serializedData,
            );
            console.warn(
              'saveNotification fallback: stripped unsupported characters for a legacy MySQL charset',
            );
            return;
          } catch (fallbackErr) {
            if (!fallbackErr || fallbackErr.errno !== 1054) {
              console.error('saveNotification error:', fallbackErr.message);
              return;
            }
          }
        }

        await insertNotification(
          userId,
          normalizeLegacyMysqlText(title) || 'Notification',
          normalizeLegacyMysqlText(message) ||
            'You have a new notification.',
          type,
        );
        console.warn('saveNotification fallback: stripped unsupported characters for a legacy MySQL charset');
        return;
      } catch (fallbackErr) {
        console.error('saveNotification error:', fallbackErr.message);
        return;
      }
    }

    console.error('saveNotification error:', err.message);
  }
}

module.exports = { saveNotification };
