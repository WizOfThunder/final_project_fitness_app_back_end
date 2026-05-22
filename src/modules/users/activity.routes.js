const express = require('express');
const router = express.Router();
const activityController = require('./activity.controller');
const authMiddleware = require('../../middleware/auth.middleware');

router.post('/sync', authMiddleware, activityController.syncActivity);
router.get('/streak', authMiddleware, activityController.getStreak);
router.post('/workout-complete', authMiddleware, activityController.markWorkoutDay);
router.get('/history', authMiddleware, activityController.getHistory);
router.get('/weekly', authMiddleware, activityController.getWeeklySummary);

module.exports = router;
