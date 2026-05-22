const express = require('express');
const router = express.Router();
const trainerController = require('./trainer.controller');
const authMiddleware = require('../../middleware/auth.middleware');
const roleMiddleware = require('../../middleware/role.middleware');
const certificationMiddleware = require('../../middleware/certification.middleware');

router.get('/dashboard-stats', authMiddleware, roleMiddleware('trainer'), certificationMiddleware, trainerController.getDashboardStats);
router.get('/', authMiddleware, trainerController.getAllPosts);
router.get('/admin/all', authMiddleware, roleMiddleware('admin'), trainerController.getAllPostsAdmin);
router.put('/admin/:id/toggle-active', authMiddleware, roleMiddleware('admin'), trainerController.togglePostActive);
router.get('/hires/mine', authMiddleware, trainerController.getMyHires);
router.get('/hires/pending', authMiddleware, roleMiddleware('trainer'), certificationMiddleware, trainerController.getPendingHires);
router.get('/hires/active', authMiddleware, roleMiddleware('trainer'), certificationMiddleware, trainerController.getActiveHires);
router.get('/hires/past', authMiddleware, roleMiddleware('trainer'), certificationMiddleware, trainerController.getPastHires);
router.get('/my-posts', authMiddleware, roleMiddleware('trainer'), certificationMiddleware, trainerController.getMyPosts);
router.get('/:id/reviews', authMiddleware, trainerController.getReviews);
router.get('/:id', authMiddleware, trainerController.getPost);

router.post('/', authMiddleware, roleMiddleware('trainer'), certificationMiddleware, trainerController.createPost);

router.put('/hires/:hire_id/accept', authMiddleware, roleMiddleware('trainer'), certificationMiddleware, trainerController.acceptHire);
router.put('/hires/:hire_id/decline', authMiddleware, roleMiddleware('trainer'), certificationMiddleware, trainerController.declineHire);
router.put('/hires/:hire_id/end-request', authMiddleware, trainerController.requestHireEnd);
router.put('/hires/:hire_id/end-request/respond', authMiddleware, trainerController.respondHireEndRequest);
router.put('/hires/:hire_id/end', authMiddleware, trainerController.endHire);
router.post('/hires/:hire_id/review', authMiddleware, trainerController.submitReview);

router.put('/:id', authMiddleware, roleMiddleware('trainer'), certificationMiddleware, trainerController.updatePost);
router.delete('/:id', authMiddleware, roleMiddleware('trainer'), certificationMiddleware, trainerController.deletePost);

router.post('/:id/hire', authMiddleware, trainerController.hireTrainer);

module.exports = router;
