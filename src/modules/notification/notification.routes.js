const express = require('express');
const router = express.Router();
const notificationController = require('./notification.controller');
const authMiddleware = require('../../middleware/auth.middleware');
const roleMiddleware = require('../../middleware/role.middleware');

router.get('/my', authMiddleware, notificationController.getMyNotifications);
router.patch('/read-all', authMiddleware, notificationController.markAllRead);
router.post('/update-token', authMiddleware, notificationController.updateFcmToken);
router.post('/send', authMiddleware, roleMiddleware('admin'), notificationController.sendNotification);
router.post('/broadcast', authMiddleware, roleMiddleware('admin'), notificationController.sendBroadcast);
router.post('/weather', authMiddleware, notificationController.sendWeatherNotification);

router.post('/test-self', authMiddleware, roleMiddleware('admin'), notificationController.testSelf);

module.exports = router;
