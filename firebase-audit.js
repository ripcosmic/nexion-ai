const { cert, getApp, getApps, initializeApp } = require('firebase-admin/app');
const { FieldValue, getFirestore } = require('firebase-admin/firestore');
const fs = require('fs');
const path = require('path');

let firestore = null;
let initializationError = null;

function initialize() {
  if (firestore || initializationError) return firestore;
  let credentials;
  const credentialFile = process.env.FIREBASE_SERVICE_ACCOUNT_FILE;

  if (credentialFile) {
    try {
      const filePath = path.resolve(credentialFile);
      const serviceAccount = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      credentials = {
        projectId: serviceAccount.projectId || serviceAccount.project_id,
        clientEmail: serviceAccount.clientEmail || serviceAccount.client_email,
        privateKey: serviceAccount.privateKey || serviceAccount.private_key
      };
    } catch (error) {
      initializationError = new Error(`Could not read Firebase service account file: ${error.message}`);
      console.error('FIREBASE_AUDIT_INIT_ERROR', initializationError.message);
      return null;
    }
  } else {
    credentials = {
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY
    };
  }

  if (!credentials.projectId || !credentials.clientEmail || !credentials.privateKey) {
    initializationError = new Error(
      'Firebase audit is disabled. Set FIREBASE_SERVICE_ACCOUNT_FILE or the Firebase environment variables.'
    );
    console.warn(initializationError.message);
    return null;
  }

  try {
    const app = getApps().length
      ? getApp()
      : initializeApp({
          credential: cert({
            projectId: credentials.projectId,
            clientEmail: credentials.clientEmail,
            privateKey: credentials.privateKey.replace(/\\n/g, '\n')
          })
        });
    firestore = getFirestore(app);
    return firestore;
  } catch (error) {
    initializationError = error;
    console.error('FIREBASE_AUDIT_INIT_ERROR', error.message);
    return null;
  }
}

function clean(value, maxLength = 500) {
  if (value === undefined || value === null) return null;
  return String(value).slice(0, maxLength);
}

async function record(event) {
  const db = initialize();
  if (!db) return;
  try {
    await db.collection('audit_events').add({
      ...event,
      userId: clean(event.userId, 120),
      email: clean(event.email, 254),
      ipAddress: clean(event.ipAddress, 100),
      userAgent: clean(event.userAgent, 500),
      path: clean(event.path, 500),
      error: clean(event.error, 1000),
      createdAt: FieldValue.serverTimestamp()
    });
  } catch (error) {
    console.error('FIREBASE_AUDIT_WRITE_ERROR', error.message);
  }
}

function recordAuth(event, details = {}) {
  return record({ category: 'auth', ...details, event });
}

function recordApi(details = {}) {
  return record({ category: 'api', ...details, event: 'request' });
}

module.exports = { record, recordAuth, recordApi };
