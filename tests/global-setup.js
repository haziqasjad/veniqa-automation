// Runs once before any Playwright test.
// Registers test@test.com via the real API so the password is hashed by the
// app's own library (bcrypt-nodejs). Then confirms the email directly in MongoDB
// so the login flow works without clicking an email link.

const { MongoClient } = require('mongodb');

const MONGO_URL = process.env.MONGODB_URL || 'mongodb://localhost:27000';
const API_URL   = process.env.SHOPPING_API_URL || 'http://localhost:4201';

async function waitForApi(url, maxAttempts = 15, delaySec = 3) {
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      const res = await fetch(url);
      if (res.status < 500) {
        console.log(`[globalSetup] API ready at ${url}`);
        return;
      }
    } catch (_) {}
    console.log(`[globalSetup] Waiting for API... attempt ${i}/${maxAttempts}`);
    await new Promise(r => setTimeout(r, delaySec * 1000));
  }
  throw new Error(`[globalSetup] API not ready after ${maxAttempts} attempts: ${url}`);
}

async function globalSetup() {
  await waitForApi(`${API_URL}/security/isLoggedIn`);

  try {
    const res = await fetch(`${API_URL}/security/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'test@test.com',
        password: 'password123',
        name: 'Test User',
        phone: '1234567890',
      }),
    });
    const data = await res.json();
    console.log(`[globalSetup] Signup response: ${res.status}`, JSON.stringify(data));
  } catch (err) {
    // User probably already exists — $unset below will still confirm them
    console.log('[globalSetup] Signup call failed (user may already exist):', err.message);
  }

  // Clear emailConfirmationToken so the user can log in without email verification
  const client = new MongoClient(MONGO_URL);
  try {
    await client.connect();
    const db = client.db('veniqa-prod-db');
    const result = await db.collection('users').updateOne(
      { email: 'test@test.com' },
      { $unset: { emailConfirmationToken: '' } }
    );
    if (result.matchedCount > 0) {
      console.log('[globalSetup] Email confirmed for test@test.com');
    } else {
      console.log('[globalSetup] WARNING: test@test.com not found in MongoDB after signup');
    }
  } finally {
    await client.close();
  }
}

module.exports = globalSetup;
