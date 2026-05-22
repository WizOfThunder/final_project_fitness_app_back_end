const express = require('express');
const router = express.Router();
const rankingController = require('./ranking.controller');
const authMiddleware = require('../../middleware/auth.middleware');

router.get('/badges', authMiddleware, rankingController.getBadgeLeaderboard);
router.get('/points', authMiddleware, rankingController.getPointsLeaderboard);
router.get('/streak', authMiddleware, rankingController.getStreakLeaderboard);
router.get('/my-rank', authMiddleware, rankingController.getMyRank);

module.exports = router;
