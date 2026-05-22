const express = require('express');
const router = express.Router();
const chatController = require('./chat.controller');
const authMiddleware = require('../../middleware/auth.middleware');

router.get('/conversations', authMiddleware, chatController.getConversations);
router.get('/conversation/:user_id', authMiddleware, chatController.getConversation);
router.put('/read/:user_id', authMiddleware, chatController.markAsRead);

module.exports = router;
