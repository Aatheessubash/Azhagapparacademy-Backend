const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

// Import models to ensure they are registered with Mongoose
require('./models');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files (images only). Videos stay protected and are streamed via auth-checked route.
app.use('/uploads/qr-codes', express.static(path.join(__dirname, 'uploads/qr-codes')));
app.use('/uploads/thumbnails', express.static(path.join(__dirname, 'uploads/thumbnails')));
app.use('/uploads/payment-proofs', express.static(path.join(__dirname, 'uploads/payment-proofs')));

// Database Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/video-learning-platform';
const MONGO_SERVER_SELECTION_TIMEOUT_MS = Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS) || 10000;

// Fail fast if MongoDB is unreachable (avoid hanging requests from buffered ops).
mongoose.set('bufferCommands', false);

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/courses', require('./routes/courses'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/levels', require('./routes/levels'));
app.use('/api/progress', require('./routes/progress'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/quizzes', require('./routes/quizzes'));

app.get('/', (req, res) => {
  res.json({ message: 'Welcome to the Video Learning Platform API' });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ 
    message: 'Something went wrong!',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Start server (only after DB connection is established)
const PORT = process.env.PORT || 5000;

const start = async () => {
  try {
    await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: MONGO_SERVER_SELECTION_TIMEOUT_MS });
    console.log('Connected to MongoDB');

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  }
};

start();
