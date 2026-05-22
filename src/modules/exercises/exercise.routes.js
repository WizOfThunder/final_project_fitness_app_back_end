const express = require('express');
const router = express.Router();
const exerciseController = require('./exercise.controller');
const authMiddleware = require('../../middleware/auth.middleware');
const roleMiddleware = require('../../middleware/role.middleware');

router.get('/', authMiddleware, exerciseController.getExercises);
router.get('/:id', authMiddleware, exerciseController.getExercise);
router.post('/sync', authMiddleware, roleMiddleware('admin'), exerciseController.syncExercises);
router.post('/sync-youtube', authMiddleware, roleMiddleware('admin'), exerciseController.syncYoutubeUrls);
router.post('/', authMiddleware, roleMiddleware('admin'), exerciseController.createExercise);
router.put('/:id/youtube-url', authMiddleware, roleMiddleware('admin'), exerciseController.setYoutubeUrl);
router.put('/:id', authMiddleware, roleMiddleware('admin'), exerciseController.updateExercise);
router.delete('/:id', authMiddleware, roleMiddleware('admin'), exerciseController.deleteExercise);

module.exports = router;
