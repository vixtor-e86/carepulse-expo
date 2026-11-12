import * as SQLite from 'expo-sqlite';

let dbInstance = null;

// In-memory fallback if running in an environment where native SQLite is unavailable
const memoryStore = {
  readings: [
    { id: 1, heart_rate: 74, spo2: 98.4, temperature: 36.6, source: 'watch_ble', recorded_at: new Date().toISOString() }
  ],
  alerts: [],
  contacts: [
    { id: 1, name: 'Eleanor Doe', relationship: 'Spouse', phone: '+1-555-0143', is_primary: 1 },
    { id: 2, name: 'Michael Doe', relationship: 'Brother', phone: '+1-555-0188', is_primary: 0 }
  ],
  settings: {
    backend_url: 'http://192.168.137.1:8000'
  }
};

export async function getDb() {
  if (dbInstance) return dbInstance;
  try {
    dbInstance = await SQLite.openDatabaseAsync('carepulse_mobile.db');
    await dbInstance.execAsync(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS readings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        heart_rate INTEGER NOT NULL,
        spo2 REAL NOT NULL,
        temperature REAL NOT NULL,
        source TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alert_type TEXT NOT NULL,
        severity TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolution_notes TEXT
      );
      CREATE TABLE IF NOT EXISTS emergency_contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        relationship TEXT NOT NULL,
        phone TEXT NOT NULL,
        is_primary INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
    `);

    const countRow = await dbInstance.getFirstAsync('SELECT COUNT(*) as cnt FROM emergency_contacts');
    if (!countRow || countRow.cnt === 0) {
      await dbInstance.runAsync(
        'INSERT INTO emergency_contacts (name, relationship, phone, is_primary) VALUES (?, ?, ?, ?)',
        ['Eleanor Doe', 'Spouse', '+1-555-0143', 1]
      );
      await dbInstance.runAsync(
        'INSERT INTO emergency_contacts (name, relationship, phone, is_primary) VALUES (?, ?, ?, ?)',
        ['Michael Doe', 'Brother', '+1-555-0188', 0]
      );
    }

    const rCount = await dbInstance.getFirstAsync('SELECT COUNT(*) as cnt FROM readings');
    if (!rCount || rCount.cnt === 0) {
      await dbInstance.runAsync(
        'INSERT INTO readings (heart_rate, spo2, temperature, source, recorded_at) VALUES (?, ?, ?, ?, ?)',
        [74, 98.4, 36.6, 'watch_ble', new Date().toISOString()]
      );
    }

    return dbInstance;
  } catch (err) {
    return null;
  }
}

export async function saveLocalReading(heartRate, spo2, temperature, source = 'watch_ble', finger = true) {
  const nowStr = new Date().toISOString();
  const db = await getDb();

  let newAlert = null;
  const violations = [];
  if (finger) {
    if (heartRate > 110) violations.push(`Elevated Heart Rate (${heartRate} bpm)`);
    else if (heartRate < 50) violations.push(`Low Heart Rate (${heartRate} bpm)`);
    if (spo2 < 92.0) violations.push(`Low Blood Oxygen (${spo2.toFixed(1)}%)`);
    if (temperature > 38.0) violations.push(`Elevated Temperature (${temperature.toFixed(1)}°C)`);
  }

  if (db) {
    await db.runAsync(
      'INSERT INTO readings (heart_rate, spo2, temperature, source, recorded_at) VALUES (?, ?, ?, ?, ?)',
      [Math.round(heartRate), Number(spo2.toFixed(1)), Number(temperature.toFixed(1)), source, nowStr]
    );

    if (violations.length > 0) {
      const existing = await db.getFirstAsync(
        "SELECT * FROM alerts WHERE status IN ('PENDING_PATIENT_ACK', 'ESCALATED_TO_DOCTOR') ORDER BY id DESC LIMIT 1"
      );
      if (!existing) {
        const alertType =
          violations.length > 1
            ? 'MULTIPLE_ANOMALY'
            : heartRate > 110
            ? 'TACHYCARDIA'
            : spo2 < 92.0
            ? 'HYPOXEMIA'
            : 'FEVER';
        const msg = violations.join(' · ');
        const res = await db.runAsync(
          'INSERT INTO alerts (alert_type, severity, message, status, created_at) VALUES (?, ?, ?, ?, ?)',
          [alertType, 'CRITICAL', msg, 'PENDING_PATIENT_ACK', nowStr]
        );
        newAlert = {
          id: res.lastInsertRowId,
          alert_type: alertType,
          severity: 'CRITICAL',
          message: msg,
          status: 'PENDING_PATIENT_ACK',
          created_at: nowStr
        };
      }
    }
  } else {
    memoryStore.readings.unshift({
      id: Date.now(),
      heart_rate: Math.round(heartRate),
      spo2: Number(spo2.toFixed(1)),
      temperature: Number(temperature.toFixed(1)),
      source,
      recorded_at: nowStr
    });
    if (violations.length > 0) {
      newAlert = {
        id: Date.now(),
        alert_type: heartRate > 110 ? 'TACHYCARDIA' : spo2 < 92 ? 'HYPOXEMIA' : 'FEVER',
        severity: 'CRITICAL',
        message: violations.join(' · '),
        status: 'PENDING_PATIENT_ACK',
        created_at: nowStr
      };
      memoryStore.alerts.unshift(newAlert);
    }
  }

  return newAlert;
}

export async function getLocalReadings(limit = 30) {
  const db = await getDb();
  if (db) {
    return await db.getAllAsync('SELECT * FROM readings ORDER BY id DESC LIMIT ?', [limit]);
  }
  return memoryStore.readings.slice(0, limit);
}

export async function getLocalAlerts() {
  const db = await getDb();
  if (db) {
    return await db.getAllAsync('SELECT * FROM alerts ORDER BY id DESC LIMIT 20');
  }
  return memoryStore.alerts;
}

export async function updateLocalAlertStatus(alertId, status, notes = '') {
  const db = await getDb();
  if (db) {
    await db.runAsync(
      'UPDATE alerts SET status = ?, resolution_notes = ? WHERE id = ?',
      [status, notes, alertId]
    );
  } else {
    memoryStore.alerts = memoryStore.alerts.map(a =>
      a.id === alertId ? { ...a, status, resolution_notes: notes } : a
    );
  }
}

export async function getLocalContacts() {
  const db = await getDb();
  if (db) {
    return await db.getAllAsync('SELECT * FROM emergency_contacts ORDER BY is_primary DESC, id ASC');
  }
  return memoryStore.contacts;
}

export async function addLocalContact(name, relationship, phone, isPrimary = false) {
  const db = await getDb();
  if (db) {
    if (isPrimary) {
      await db.runAsync('UPDATE emergency_contacts SET is_primary = 0');
    }
    await db.runAsync(
      'INSERT INTO emergency_contacts (name, relationship, phone, is_primary) VALUES (?, ?, ?, ?)',
      [name, relationship, phone, isPrimary ? 1 : 0]
    );
  } else {
    memoryStore.contacts.push({
      id: Date.now(),
      name,
      relationship,
      phone,
      is_primary: isPrimary ? 1 : 0
    });
  }
}

export async function deleteLocalContact(id) {
  const db = await getDb();
  if (db) {
    await db.runAsync('DELETE FROM emergency_contacts WHERE id = ?', [id]);
  } else {
    memoryStore.contacts = memoryStore.contacts.filter(c => c.id !== id);
  }
}

export async function getSavedSetting(key, fallback = '') {
  const db = await getDb();
  if (db) {
    const row = await db.getFirstAsync('SELECT value FROM app_settings WHERE key = ?', [key]);
    return row ? row.value : fallback;
  }
  return memoryStore.settings[key] || fallback;
}

export async function saveSetting(key, value) {
  const db = await getDb();
  if (db) {
    await db.runAsync(
      'INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)',
      [key, value]
    );
  } else {
    memoryStore.settings[key] = value;
  }
}
