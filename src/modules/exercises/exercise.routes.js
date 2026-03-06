const express = require('express');
const router = express.Router();
const exerciseController = require('./exercise.controller');
const authMiddleware = require('../../middleware/auth.middleware');
const roleMiddleware = require('../../middleware/role.middleware');

router.get('/', authMiddleware, exerciseController.getExercises);
router.get('/:id', authMiddleware, exerciseController.getExercise);
router.post('/sync', authMiddleware, roleMiddleware('admin'), exerciseController.syncExercises);

module.exports = router;
