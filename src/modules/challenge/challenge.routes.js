const express = require('express');
const router = express.Router();
const challengeController = require('./challenge.controller');
const authMiddleware = require('../../middleware/auth.middleware');
const roleMiddleware = require('../../middleware/role.middleware');

router.get('/', authMiddleware, challengeController.getChallenges);
router.post('/', authMiddleware, roleMiddleware('admin'), challengeController.createChallenge);
router.post('/:id/join', authMiddleware, challengeController.joinChallenge);
router.get('/my', authMiddleware, challengeController.getMyChallenges);

module.exports = router;
