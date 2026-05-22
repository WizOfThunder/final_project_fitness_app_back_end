const getAdmin = require('../../config/firebase');

async function sendPushNotification(token, title, body, data = {}) {
  const admin = getAdmin();
  if (!admin) throw new Error('Firebase not configured');
  const response = await admin.messaging().send({
    notification: { title, body },
    android: { notification: { channelId: 'default', priority: 'high' } },
    data,
    token,
  });
  console.log('Notification sent:', response);
  return response;
}

async function sendMulticastNotification(tokens, title, body, data = {}) {
  const admin = getAdmin();
  if (!admin) throw new Error('Firebase not configured');
  const response = await admin.messaging().sendMulticast({
    notification: { title, body },
    android: { notification: { channelId: 'default', priority: 'high' } },
    data,
    tokens,
  });
  console.log('Multicast notification sent:', response);
  return response;
}

module.exports = {
  sendPushNotification,
  sendMulticastNotification
};
