const express = require('express');
const router = express.Router();
const achievementController = require('./achievement.controller');
const authMiddleware = require('../../middleware/auth.middleware');

router.get('/', authMiddleware, achievementController.getAchievements);
router.get('/my', authMiddleware, achievementController.getMyAchievements);

module.exports = router;
