const express = require('express');
const router = express.Router();
const achievementController = require('./achievement.controller');
const authMiddleware = require('../../middleware/auth.middleware');
const roleMiddleware = require('../../middleware/role.middleware');

router.get('/', authMiddleware, achievementController.getAchievements);
router.get('/my', authMiddleware, achievementController.getMyAchievements);
router.get('/progress', authMiddleware, achievementController.getMyProgress);
router.post('/', authMiddleware, roleMiddleware('admin'), achievementController.createAchievement);
router.put('/:id', authMiddleware, roleMiddleware('admin'), achievementController.updateAchievement);
router.delete('/:id', authMiddleware, roleMiddleware('admin'), achievementController.deleteAchievement);
router.patch('/:id/restore', authMiddleware, roleMiddleware('admin'), achievementController.restoreAchievement);

module.exports = router;
