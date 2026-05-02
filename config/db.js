const mongoose = require('mongoose');
const logger = require('../utils/logger');

const connectDB = async () => {
  try {
    const uri = process.env.MONGO_URI;
    if (!uri) throw new Error('MONGO_URI is not set in environment');

    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000,
    });
    logger.info('MongoDB connected');
  } catch (err) {
    logger.error(`MongoDB connection failed: ${err.message}`);
    // Don't hard-exit in dev — allows the rest of the app to work for testing without Mongo
    if (process.env.NODE_ENV === 'production') process.exit(1);
  }
};

module.exports = connectDB;
