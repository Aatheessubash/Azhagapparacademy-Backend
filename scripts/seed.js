const path = require('path');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Disable outgoing emails during seed unless explicitly allowed.
if (process.env.SEED_DISABLE_EMAILS !== 'false') {
  process.env.MAIL_USER = '';
  process.env.MAIL_APP_PASSWORD = '';
}

const { User, Course, Level, Quiz, Payment, Progress } = require('../models');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/video-learning-platform';

const buildQuizQuestions = (topic) => [
  {
    question: `Which statement best describes ${topic}?`,
    options: [
      `${topic} is only for athletes`,
      `${topic} supports consistency with guided practice`,
      `${topic} cannot be learned by beginners`,
      `${topic} is only theory with no application`
    ],
    correctAnswer: 1,
    explanation: `${topic} improves with regular guided sessions and practical application.`
  },
  {
    question: `What is a good first step before a ${topic} session?`,
    options: [
      'Skip warm-up and start intensely',
      'Set intention and prepare calmly',
      'Avoid hydration for better focus',
      'Practice only once a month'
    ],
    correctAnswer: 1,
    explanation: 'Preparation and intention help improve outcomes and safety.'
  },
  {
    question: `How do you improve long-term results in ${topic}?`,
    options: [
      'Inconsistent effort',
      'Only watching videos',
      'Regular practice and reflection',
      'Ignoring feedback'
    ],
    correctAnswer: 2,
    explanation: 'Consistent practice and review create measurable long-term progress.'
  }
];

const clearDatabase = async () => {
  await Promise.all([
    Progress.deleteMany({}),
    Payment.deleteMany({}),
    Quiz.deleteMany({}),
    Level.deleteMany({}),
    Course.deleteMany({}),
    User.deleteMany({})
  ]);
};

const createUsers = async () => {
  const adminEmail = (process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';

  const rawUsers = [
    {
      name: 'Primary Admin',
      email: adminEmail,
      password: adminPassword,
      role: 'admin',
      status: 'active'
    },
    {
      name: 'Academy Admin',
      email: 'academy.admin@example.com',
      password: 'admin123',
      role: 'admin',
      status: 'active'
    },
    {
      name: 'Aathees Student',
      email: 'student1@example.com',
      password: 'student123',
      role: 'student',
      status: 'active'
    },
    {
      name: 'Meena Student',
      email: 'student2@example.com',
      password: 'student123',
      role: 'student',
      status: 'active'
    },
    {
      name: 'Karthik Student',
      email: 'student3@example.com',
      password: 'student123',
      role: 'student',
      status: 'active'
    },
    {
      name: 'Paused Student',
      email: 'student4@example.com',
      password: 'student123',
      role: 'student',
      status: 'inactive'
    }
  ];

  const createdUsers = [];
  for (const userPayload of rawUsers) {
    createdUsers.push(await User.create(userPayload));
  }

  return {
    admins: createdUsers.filter((user) => user.role === 'admin'),
    students: createdUsers.filter((user) => user.role === 'student')
  };
};

const createCourses = async () => {
  const courses = await Course.insertMany([
    {
      title: 'Yoga Foundations - Mind and Body',
      description: 'Breathing, posture alignment, flexibility, and stress relief routines for all levels.',
      price: 1999,
      qrCodeImage: '/uploads/qr-codes/sample-qr-yoga.png',
      quizEnabled: true,
      thumbnail: '/uploads/thumbnails/sample-yoga.png',
      youtubeEmbedUrl: 'https://www.youtube.com/embed/r7xsYgTeM2Q',
      status: 'published'
    },
    {
      title: 'Hypnosis and Mind Mastery',
      description: 'Guided sessions focused on confidence, emotional regulation, and habit transformation.',
      price: 2499,
      qrCodeImage: '/uploads/qr-codes/sample-qr-hypnosis.png',
      quizEnabled: true,
      thumbnail: '/uploads/thumbnails/sample-hypnosis.png',
      youtubeEmbedUrl: 'https://www.youtube.com/embed/inpok4MKVLM',
      status: 'published'
    },
    {
      title: 'Life Skills and Personal Growth',
      description: 'Daily tools for focus, discipline, stress handling, and sustainable self-improvement.',
      price: 0,
      qrCodeImage: null,
      quizEnabled: true,
      thumbnail: '/uploads/thumbnails/sample-lifeskills.png',
      youtubeEmbedUrl: 'https://www.youtube.com/embed/ZToicYcHIOU',
      status: 'published'
    },
    {
      title: 'Advanced Transformation Lab',
      description: 'Combined protocol for advanced learners with coaching-style progression.',
      price: 3999,
      qrCodeImage: '/uploads/qr-codes/sample-qr-advanced.png',
      quizEnabled: true,
      thumbnail: '/uploads/thumbnails/sample-advanced.png',
      youtubeEmbedUrl: 'https://www.youtube.com/embed/gJLIiF15wjQ',
      status: 'draft'
    }
  ]);

  return courses;
};

const createLevelsAndQuizzes = async (courses) => {
  const courseLevelsMap = new Map();

  for (const course of courses) {
    const levelTemplates = [
      {
        levelNumber: 1,
        title: 'Foundation and Orientation',
        description: 'Understand the fundamentals and set your starting baseline.',
        quizEnabled: false,
        videoPath: `/uploads/videos/${course._id}-level-1.mp4`
      },
      {
        levelNumber: 2,
        title: 'Core Practice',
        description: 'Structured practice routines with daily execution patterns.',
        quizEnabled: true,
        videoPath: `/uploads/videos/${course._id}-level-2.mp4`
      },
      {
        levelNumber: 3,
        title: 'Integration and Mastery',
        description: 'Apply the method in real-life scenarios and evaluate progress.',
        quizEnabled: true,
        videoPath: `/uploads/videos/${course._id}-level-3.mp4`
      }
    ];

    const levels = await Level.insertMany(
      levelTemplates.map((levelTemplate, index) => ({
        courseId: course._id,
        levelNumber: levelTemplate.levelNumber,
        title: `${course.title} - ${levelTemplate.title}`,
        description: levelTemplate.description,
        quizEnabled: levelTemplate.quizEnabled,
        videoPath: levelTemplate.videoPath,
        videoDuration: 900 + index * 300,
        order: levelTemplate.levelNumber,
        status: 'active'
      }))
    );

    const quizzes = [];

    for (const level of levels.filter((item) => item.quizEnabled)) {
      const quiz = await Quiz.create({
        courseId: course._id,
        levelId: level._id,
        title: `${level.title} - Assessment`,
        description: `Assessment for ${level.title}`,
        questions: buildQuizQuestions(level.title),
        passingScore: 70,
        timeLimit: 15,
        maxAttempts: 3,
        status: 'active'
      });

      await Level.findByIdAndUpdate(level._id, { quizId: quiz._id });
      quizzes.push(quiz);
    }

    await Course.findByIdAndUpdate(course._id, { totalLevels: levels.length });

    courseLevelsMap.set(course._id.toString(), {
      levels,
      quizzes
    });
  }

  return courseLevelsMap;
};

const createPayments = async ({ admins, students, courses }) => {
  const [primaryAdmin] = admins;
  const yogaCourse = courses[0];
  const hypnosisCourse = courses[1];

  const payments = await Payment.insertMany([
    {
      userId: students[0]._id,
      courseId: yogaCourse._id,
      transactionId: 'TXN-YOGA-1001',
      proofImage: '/uploads/payment-proofs/sample-proof-1.jpg',
      amount: yogaCourse.price,
      status: 'approved',
      verifiedBy: primaryAdmin._id,
      verifiedAt: new Date(),
      notes: 'Verified successfully'
    },
    {
      userId: students[0]._id,
      courseId: hypnosisCourse._id,
      transactionId: 'TXN-HYPNO-1002',
      proofImage: '/uploads/payment-proofs/sample-proof-2.jpg',
      amount: hypnosisCourse.price,
      status: 'pending'
    },
    {
      userId: students[1]._id,
      courseId: hypnosisCourse._id,
      transactionId: 'TXN-HYPNO-1003',
      proofImage: '/uploads/payment-proofs/sample-proof-3.jpg',
      amount: hypnosisCourse.price,
      status: 'rejected',
      verifiedBy: primaryAdmin._id,
      verifiedAt: new Date(),
      rejectionReason: 'Transaction screenshot not clear',
      notes: 'Please re-upload a clear screenshot'
    },
    {
      userId: students[2]._id,
      courseId: hypnosisCourse._id,
      transactionId: 'TXN-HYPNO-1004',
      proofImage: '/uploads/payment-proofs/sample-proof-4.jpg',
      amount: hypnosisCourse.price,
      status: 'approved',
      verifiedBy: primaryAdmin._id,
      verifiedAt: new Date(),
      notes: 'Verified successfully'
    },
    {
      userId: students[2]._id,
      courseId: yogaCourse._id,
      transactionId: 'TXN-YOGA-1005',
      proofImage: '/uploads/payment-proofs/sample-proof-5.jpg',
      amount: yogaCourse.price,
      status: 'pending'
    }
  ]);

  return payments;
};

const buildProgressRecord = ({
  userId,
  course,
  levels,
  currentLevel,
  completionMap,
  courseCompleted = false
}) => {
  const completedLevels = levels.map((level) => {
    const completion = completionMap[level.levelNumber] || {};
    return {
      levelId: level._id,
      completed: Boolean(completion.completed),
      completedAt: completion.completed ? (completion.completedAt || new Date()) : null,
      quizScore: completion.quizScore || 0,
      quizPassed: Boolean(completion.quizPassed),
      quizAttempts: completion.quizAttempts || 0,
      videoWatchedPercent: completion.videoWatchedPercent || 0
    };
  });

  return new Progress({
    userId,
    courseId: course._id,
    completedLevels,
    currentLevel,
    courseCompleted,
    courseCompletedAt: courseCompleted ? new Date() : null,
    lastAccessedAt: new Date()
  });
};

const createProgress = async ({ students, courses, courseLevelsMap }) => {
  const yogaCourse = courses[0];
  const hypnosisCourse = courses[1];
  const freeCourse = courses[2];

  const yogaLevels = courseLevelsMap.get(yogaCourse._id.toString()).levels;
  const hypnosisLevels = courseLevelsMap.get(hypnosisCourse._id.toString()).levels;
  const freeLevels = courseLevelsMap.get(freeCourse._id.toString()).levels;

  const progressDocs = [
    buildProgressRecord({
      userId: students[0]._id,
      course: yogaCourse,
      levels: yogaLevels,
      currentLevel: 3,
      completionMap: {
        1: { completed: true, videoWatchedPercent: 100 },
        2: { completed: true, videoWatchedPercent: 100, quizScore: 85, quizPassed: true, quizAttempts: 1 },
        3: { completed: false, videoWatchedPercent: 25 }
      }
    }),
    buildProgressRecord({
      userId: students[2]._id,
      course: hypnosisCourse,
      levels: hypnosisLevels,
      currentLevel: 2,
      completionMap: {
        1: { completed: true, videoWatchedPercent: 100 },
        2: { completed: false, videoWatchedPercent: 60, quizScore: 45, quizPassed: false, quizAttempts: 1 },
        3: { completed: false, videoWatchedPercent: 0 }
      }
    }),
    buildProgressRecord({
      userId: students[0]._id,
      course: freeCourse,
      levels: freeLevels,
      currentLevel: 2,
      completionMap: {
        1: { completed: true, videoWatchedPercent: 100 },
        2: { completed: false, videoWatchedPercent: 40 },
        3: { completed: false, videoWatchedPercent: 0 }
      }
    })
  ];

  for (const progress of progressDocs) {
    progress.calculateProgress(progress.completedLevels.length);
    await progress.save();
  }

  return progressDocs;
};

const seedDatabase = async () => {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB');

    await clearDatabase();
    console.log('Cleared existing collections');

    const usersResult = await createUsers();
    console.log(`Created users: admins=${usersResult.admins.length}, students=${usersResult.students.length}`);

    const courses = await createCourses();
    console.log(`Created courses: ${courses.length}`);

    const courseLevelsMap = await createLevelsAndQuizzes(courses);
    const totalLevels = Array.from(courseLevelsMap.values()).reduce((sum, entry) => sum + entry.levels.length, 0);
    const totalQuizzes = Array.from(courseLevelsMap.values()).reduce((sum, entry) => sum + entry.quizzes.length, 0);
    console.log(`Created levels=${totalLevels}, quizzes=${totalQuizzes}`);

    const payments = await createPayments({
      admins: usersResult.admins,
      students: usersResult.students,
      courses
    });
    console.log(`Created payments: ${payments.length}`);

    const progress = await createProgress({
      students: usersResult.students,
      courses,
      courseLevelsMap
    });
    console.log(`Created progress records: ${progress.length}`);

    const adminLogin = usersResult.admins[0];
    const studentLogin = usersResult.students[0];

    console.log('\nSeed completed successfully.');
    console.log('Login credentials:');
    console.log(`- Admin: ${adminLogin.email} / ${process.env.ADMIN_PASSWORD || 'admin123'}`);
    console.log(`- Student: ${studentLogin.email} / student123`);
  } catch (error) {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
  }
};

seedDatabase();
