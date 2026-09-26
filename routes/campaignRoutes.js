/**
 * WhatsApp Marketing Campaigns and Re-engagement Routes
 */

const express = require('express');
const router = express.Router();
const campaignController = require('../controllers/campaignController');
const { protect } = require('../middleware/authMiddleware');

router.use(protect);

router.post('/', campaignController.createCampaign);
router.get('/', campaignController.listCampaigns);
router.get('/segments/:segment/preview', campaignController.getSegmentPreview);
router.post('/abandoned-orders/trigger', campaignController.triggerAbandonedReminders);
router.get('/:id', campaignController.getCampaign);
router.post('/:id/send', campaignController.sendCampaign);

module.exports = router;
