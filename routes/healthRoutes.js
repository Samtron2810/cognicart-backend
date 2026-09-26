/**
 * System and API Health Check Routes
 * Provides standard health check, Kubernetes/container liveness and readiness probes
 */

const express = require('express');
const router = express.Router();
const { getHealthStatus, getLiveness, getReadiness } = require('../controllers/healthController');

router.get('/', getHealthStatus);
router.get('/live', getLiveness);
router.get('/ready', getReadiness);

module.exports = router;
