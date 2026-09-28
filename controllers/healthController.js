/**
 * Health Check Controller
 * Returns platform liveness, readiness, uptime, memory stats, and database connection status
 */

const { isDbConnected, getDbState } = require('../config/db');

function getHealthStatus(req, res) {
  const connected = isDbConnected();

  res.status(connected ? 200 : 503).json({
    success: connected,
    status: connected ? 'healthy' : 'degraded',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    database: getDbState(),
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
  const connected = isDbConnected();

  res.status(connected ? 200 : 503).json({
    status: connected ? 'ready' : 'not-ready',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    checks: {
      database: getDbState(),
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
