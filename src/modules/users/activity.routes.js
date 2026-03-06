const express = require('express');
const router = express.Router();
const activityController = require('./activity.controller');
const authMiddleware = require('../../middleware/auth.middleware');

router.post('/sync', authMiddleware, activityController.syncActivity);
router.get('/history', authMiddleware, activityController.getHistory);

module.exports = router;
