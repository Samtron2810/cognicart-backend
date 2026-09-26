/**
 * Health Check Controller
 * Returns platform liveness, readiness, uptime, memory stats, and database connection status
 */

const { isDbConnected } = require('../config/db');

function getHealthStatus(req, res) {
  res.status(200).json({
    success: true,
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    database: isDbConnected() ? 'connected' : 'disconnected',
    environment: process.env.NODE_ENV || 'development',
  });
}

function getLiveness(req, res) {
  res.status(200).json({
    status: 'alive',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
}

function getReadiness(req, res) {
  const mem = process.memoryUsage();
  const dbStatus = isDbConnected() ? 'connected' : 'in-memory-fallback';

  res.status(200).json({
    status: 'ready',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    checks: {
      database: dbStatus,
      environment: process.env.NODE_ENV || 'development',
      memory: {
        heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
        rssMB: Math.round(mem.rss / 1024 / 1024),
      },
    },
  });
}

module.exports = {
  getHealthStatus,
  getLiveness,
  getReadiness,
};
