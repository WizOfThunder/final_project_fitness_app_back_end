const express = require('express');
const router = express.Router();
const rankingController = require('./ranking.controller');
const authMiddleware = require('../../middleware/auth.middleware');

router.get('/', authMiddleware, rankingController.getRanking);

module.exports = router;
