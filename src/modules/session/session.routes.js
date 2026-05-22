const express = require('express');
const router = express.Router();
const sessionController = require('./session.controller');
const authMiddleware = require('../../middleware/auth.middleware');
const roleMiddleware = require('../../middleware/role.middleware');
const certificationMiddleware = require('../../middleware/certification.middleware');

router.get('/hire/:hire_id', authMiddleware, sessionController.getHireSessions);
router.put('/:session_id/note', authMiddleware, roleMiddleware('trainer'), certificationMiddleware, sessionController.setSessionNote);
router.post('/:session_id/start', authMiddleware, roleMiddleware('trainer'), certificationMiddleware, sessionController.startSession);
router.post('/:session_id/confirm', authMiddleware, sessionController.confirmSession);
router.post('/hire/:hire_id/dispute', authMiddleware, sessionController.createDispute);
router.get('/hire/:hire_id/dispute', authMiddleware, sessionController.getDispute);
router.get('/disputes', authMiddleware, roleMiddleware('admin'), sessionController.getAllDisputes);
router.put('/disputes/:dispute_id/resolve', authMiddleware, roleMiddleware('admin'), sessionController.resolveDispute);

module.exports = router;
