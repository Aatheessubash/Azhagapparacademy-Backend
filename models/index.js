/**
 * Models Index
 * Export all models from a single file
 */

const User = require('./User');
const Course = require('./Course');
const Level = require('./Level');
const Quiz = require('./Quiz');
const Payment = require('./Payment');
const Progress = require('./Progress');

module.exports = {
  User,
  Course,
  Level,
  Quiz,
  Payment,
  Progress
};
