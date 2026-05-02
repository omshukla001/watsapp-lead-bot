require('dotenv').config();
const express = require('express');
const morgan = require('morgan');
const connectDB = require('./config/db');
const adminRoutes = require('./routes/admin');
const logger = require('./utils/logger');
const { startBaileys } = require('./services/baileysService');
const { startFollowupScheduler } = require('./services/followupScheduler');
const { notifyStartup } = require('./services/termuxNotify');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(morgan('dev'));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'whatsapp-lead-bot' });
});

app.use('/admin', adminRoutes);

app.use((err, req, res, next) => {
  logger.error(`Unhandled error: ${err.message}`);
  res.status(500).json({ error: 'Internal server error' });
});

(async () => {
  try {
    await connectDB();
    await startBaileys();
    startFollowupScheduler();
    app.listen(PORT, () => {
      logger.info(`Admin dashboard: http://localhost:${PORT}/admin`);
      notifyStartup();
    });
  } catch (err) {
    logger.error(`Startup failed: ${err.stack || err.message}`);
    process.exit(1);
  }
})();
