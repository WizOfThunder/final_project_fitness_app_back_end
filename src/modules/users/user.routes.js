const express = require('express');
const router = express.Router();
const userController = require('./user.controller');
const authMiddleware = require('../../middleware/auth.middleware');
const roleMiddleware = require('../../middleware/role.middleware');
const upload = require('../../middleware/upload.middleware');

router.get('/notification-prefs', authMiddleware, userController.getNotificationPrefs);
router.put('/notification-prefs', authMiddleware, userController.updateNotificationPrefs);
router.get('/', authMiddleware, roleMiddleware('admin'), userController.getAllUsers);
router.get('/pending-trainers', authMiddleware, roleMiddleware('admin'), userController.getPendingTrainers);
router.patch('/:id/certification', authMiddleware, roleMiddleware('admin'), userController.reviewCertification);
router.patch('/:id/status', authMiddleware, roleMiddleware('admin'), userController.updateStatus);
router.get('/:id', authMiddleware, userController.getUser);
router.put('/:id', authMiddleware, userController.updateProfile);
router.put('/:id/avatar', authMiddleware, upload.single('avatar'), userController.updateAvatar);

module.exports = router;
