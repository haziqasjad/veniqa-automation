// Runs once before any Playwright test. Creates the test user in MongoDB if it
// doesn't exist yet. CI starts with a fresh empty DB so the user must be seeded.
// The user is inserted already-confirmed (no emailConfirmationToken field) so
// the login flow works immediately without email verification.

const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');

async function globalSetup() {
  const mongoUrl = process.env.MONGODB_URL || 'mongodb://localhost:27000';
  const client = new MongoClient(mongoUrl);

  try {
    await client.connect();
    const db = client.db('veniqa-prod-db');
    const users = db.collection('users');

    const existing = await users.findOne({ email: 'test@test.com' });
    if (!existing) {
      const hash = await bcrypt.hash('password123', 10);
      await users.insertOne({
        email: 'test@test.com',
        password: hash,
        name: 'Test User',
        phone: '1234567890',
      });
      console.log('[globalSetup] Created test user: test@test.com');
    } else {
      console.log('[globalSetup] Test user already exists: test@test.com');
    }
  } finally {
    await client.close();
  }
}

module.exports = globalSetup;
