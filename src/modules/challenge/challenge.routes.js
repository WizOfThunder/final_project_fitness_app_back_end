const express = require('express');
const router = express.Router();
const challengeController = require('./challenge.controller');
const authMiddleware = require('../../middleware/auth.middleware');
const roleMiddleware = require('../../middleware/role.middleware');
const certificationMiddleware = require('../../middleware/certification.middleware');

const upload = require('../../middleware/upload.middleware');

router.get('/', authMiddleware, challengeController.getChallenges);
router.get('/created', authMiddleware, roleMiddleware('admin', 'trainer'), certificationMiddleware, challengeController.getCreatedChallenges);
router.get('/my', authMiddleware, challengeController.getMyChallenges);
router.get('/requests/pending', authMiddleware, roleMiddleware('trainer', 'admin'), certificationMiddleware, challengeController.getPendingRequests);
router.get('/:id', authMiddleware, challengeController.getChallengeById);
router.post('/', authMiddleware, roleMiddleware('admin', 'trainer'), certificationMiddleware, challengeController.createChallenge);
router.patch('/:id/review', authMiddleware, roleMiddleware('admin'), challengeController.reviewChallenge);
router.post('/:id/join', authMiddleware, challengeController.joinChallenge);
router.post('/user-challenge/:userChallengeId/submit', authMiddleware, upload.uploadProof.single('proof_image'), challengeController.submitCompletion);
router.patch('/requests/:requestId/review', authMiddleware, roleMiddleware('trainer', 'admin'), certificationMiddleware, challengeController.reviewRequest);
router.post('/requests/bulk-approve', authMiddleware, roleMiddleware('trainer', 'admin'), certificationMiddleware, challengeController.bulkApproveRequests);

module.exports = router;
