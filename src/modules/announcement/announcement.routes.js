const express = require('express');
const router = express.Router();
const announcementController = require('./announcement.controller');
const authMiddleware = require('../../middleware/auth.middleware');

router.get('/:post_id', authMiddleware, announcementController.getAnnouncements);
router.post('/:post_id', authMiddleware, announcementController.createAnnouncement);

module.exports = router;
