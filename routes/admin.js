const express = require('express');
const router = express.Router();
const { User, Course, Payment, Level, Quiz, Progress } = require('../models');
const { authenticate, requireAdmin } = require('../middleware/auth');

const USER_ROLES = ['student', 'admin'];

// @route   GET /admin/dashboard
// @desc    Get admin dashboard stats
// @access  Private/Admin
router.get('/dashboard', authenticate, requireAdmin, async (req, res) => {
  try {
    // 1. Statistics
    const totalStudents = await User.countDocuments({ role: 'student' });
    const totalCourses = await Course.countDocuments();
    const totalLevels = await Level.countDocuments(); 
    const totalQuizzes = await Quiz.countDocuments();

    const paymentsStats = await Payment.aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          amount: { $sum: '$amount' }
        }
      }
    ]);

    const paymentCounts = {
      pending: 0,
      approved: 0,
      rejected: 0,
      total: 0
    };

    let totalRevenue = 0;

    paymentsStats.forEach(stat => {
      if (stat._id === 'pending') paymentCounts.pending = stat.count;
      if (stat._id === 'approved') {
        paymentCounts.approved = stat.count;
        totalRevenue += stat.amount;
      }
      if (stat._id === 'rejected') paymentCounts.rejected = stat.count;
      paymentCounts.total += stat.count;
    });

    const statistics = {
      totalStudents,
      totalCourses,
      totalLevels,
      totalQuizzes,
      payments: paymentCounts,
      totalRevenue
    };

    // 2. Recent Payments
    const recentPayments = await Payment.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .populate('userId', 'name email')
      .populate('courseId', 'title');

    // 3. Recent Students
    const recentStudents = await User.find({ role: 'student' })
      .sort({ createdAt: -1 })
      .limit(5)
      .select('name email createdAt');

    res.json({
      statistics,
      recentPayments,
      recentStudents
    });
  } catch (error) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /admin/students
// @desc    Paginated students list with search
// @access  Private/Admin
router.get('/students', authenticate, requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 10));
    const search = req.query.search || '';

    const filter = { role: 'student' };
    if (search) {
      const regex = new RegExp(search, 'i');
      filter.$or = [{ name: regex }, { email: regex }];
    }

    const [students, total] = await Promise.all([
      User.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select('name email status createdAt'),
      User.countDocuments(filter)
    ]);

    res.json({
      students,
      total,
      page,
      pages: Math.ceil(total / limit),
      limit
    });
  } catch (error) {
    console.error('Get students error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /admin/users
// @desc    Paginated users list with optional role/search filter
// @access  Private/Admin
router.get('/users', authenticate, requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 10));
    const search = req.query.search || '';
    const role = req.query.role || '';

    const filter = {};

    if (role && USER_ROLES.includes(role)) {
      filter.role = role;
    }

    if (search) {
      const regex = new RegExp(search, 'i');
      filter.$or = [{ name: regex }, { email: regex }];
    }

    const [users, total] = await Promise.all([
      User.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select('name email role status createdAt'),
      User.countDocuments(filter)
    ]);

    res.json({
      users,
      total,
      page,
      pages: Math.ceil(total / limit),
      limit
    });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /admin/students/:id/progress
// @desc    Get progress for a specific student
// @access  Private/Admin
router.get('/students/:id/progress', authenticate, requireAdmin, async (req, res) => {
  try {
    const student = await User.findById(req.params.id);
    if (!student || student.role !== 'student') {
      return res.status(404).json({ message: 'Student not found' });
    }

    const progress = await Progress.find({ userId: req.params.id })
      .populate('courseId', 'title')
      .sort({ updatedAt: -1 });

    res.json({ progress });
  } catch (error) {
    console.error('Get student progress error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   PUT /admin/students/:id/status
// @desc    Update student status (active/inactive/suspended)
// @access  Private/Admin
router.put('/students/:id/status', authenticate, requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const allowed = ['active', 'inactive', 'suspended'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ message: 'Invalid status value' });
    }

    const student = await User.findOneAndUpdate(
      { _id: req.params.id, role: 'student' },
      { status },
      { new: true }
    ).select('name email status createdAt');

    if (!student) {
      return res.status(404).json({ message: 'Student not found' });
    }

    res.json({ student });
  } catch (error) {
    console.error('Update student status error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   PUT /admin/users/:id/role
// @desc    Change user role (student/admin)
// @access  Private/Admin
router.put('/users/:id/role', authenticate, requireAdmin, async (req, res) => {
  try {
    const { role } = req.body;
    if (!USER_ROLES.includes(role)) {
      return res.status(400).json({ message: 'Invalid role value' });
    }

    if (req.user._id.toString() === req.params.id) {
      return res.status(400).json({ message: 'You cannot change your own role' });
    }

    const targetUser = await User.findById(req.params.id);
    if (!targetUser) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (targetUser.role === role) {
      return res.json({
        user: {
          _id: targetUser._id,
          name: targetUser.name,
          email: targetUser.email,
          role: targetUser.role,
          status: targetUser.status,
          createdAt: targetUser.createdAt
        }
      });
    }

    if (targetUser.role === 'admin' && role === 'student') {
      const adminCount = await User.countDocuments({ role: 'admin' });
      if (adminCount <= 1) {
        return res.status(400).json({ message: 'At least one admin is required' });
      }
    }

    targetUser.role = role;
    await targetUser.save();

    res.json({
      user: {
        _id: targetUser._id,
        name: targetUser.name,
        email: targetUser.email,
        role: targetUser.role,
        status: targetUser.status,
        createdAt: targetUser.createdAt
      }
    });
  } catch (error) {
    console.error('Update user role error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   DELETE /admin/users/:id
// @desc    Delete a user
// @access  Private/Admin
router.delete('/users/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    if (req.user._id.toString() === req.params.id) {
      return res.status(400).json({ message: 'You cannot delete your own account' });
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (user.role === 'admin') {
      const adminCount = await User.countDocuments({ role: 'admin' });
      if (adminCount <= 1) {
        return res.status(400).json({ message: 'At least one admin is required' });
      }
    }

    await Promise.all([
      Payment.deleteMany({ userId: user._id }),
      Progress.deleteMany({ userId: user._id }),
      Payment.updateMany({ verifiedBy: user._id }, { $set: { verifiedBy: null } }),
      User.deleteOne({ _id: user._id })
    ]);

    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /admin/revenue
// @desc    Revenue analytics with optional period filter
// @access  Private/Admin
router.get('/revenue', authenticate, requireAdmin, async (req, res) => {
  try {
    const { period = '30d' } = req.query;
    let startDate;

    if (period === '7d') startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    else if (period === '30d') startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    else if (period === '90d') startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    // 'all' leaves startDate undefined

    const baseMatch = {};
    if (startDate) baseMatch.createdAt = { $gte: startDate };

    const [statusCounts, approvedSum, trend, topCourses, recentPayments] = await Promise.all([
      Payment.aggregate([
        { $match: baseMatch },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]),
      Payment.aggregate([
        { $match: { ...baseMatch, status: 'approved' } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
      ]),
      Payment.aggregate([
        { $match: { ...baseMatch, status: 'approved' } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            amount: { $sum: '$amount' },
            count: { $sum: 1 }
          }
        },
        { $sort: { _id: 1 } }
      ]),
      Payment.aggregate([
        { $match: { ...baseMatch, status: 'approved' } },
        {
          $group: {
            _id: '$courseId',
            revenue: { $sum: '$amount' },
            payments: { $sum: 1 }
          }
        },
        { $sort: { revenue: -1 } },
        { $limit: 5 },
        {
          $lookup: {
            from: 'courses',
            localField: '_id',
            foreignField: '_id',
            as: 'course'
          }
        },
        { $unwind: '$course' },
        {
          $project: {
            courseId: '$_id',
            title: '$course.title',
            revenue: 1,
            payments: 1
          }
        }
      ]),
      Payment.find({ ...baseMatch, status: 'approved' })
        .sort({ createdAt: -1 })
        .limit(10)
        .populate('userId', 'name')
        .populate('courseId', 'title')
    ]);

    const counts = { pending: 0, approved: 0, rejected: 0, total: 0 };
    statusCounts.forEach((row) => {
      counts[row._id] = row.count;
      counts.total += row.count;
    });

    const totalRevenue = approvedSum[0]?.total || 0;

    res.json({
      totalRevenue,
      counts,
      trend: trend.map((t) => ({ date: t._id, amount: t.amount, count: t.count })),
      topCourses,
      recentPayments
    });
  } catch (error) {
    console.error('Revenue analytics error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
