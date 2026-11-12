import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  ScrollView,
  TouchableOpacity,
  TextInput,
  SafeAreaView,
  StatusBar,
  Platform
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Path, Defs, LinearGradient as SvgGradient, Stop, Circle, Line } from 'react-native-svg';
import {
  getDb,
  saveLocalReading,
  getLocalReadings,
  getLocalAlerts,
  updateLocalAlertStatus,
  getLocalContacts,
  addLocalContact,
  deleteLocalContact,
  getSavedSetting,
  saveSetting
} from './src/db/localDb';
import { connectToCarePulseWatch } from './src/ble/watchBleManager';
import {
  ActivityIcon,
  CalendarIcon,
  TargetIcon,
  UserIcon,
  SettingsIcon,
  ChevronLeftIcon,
  MoreIcon,
  BluetoothIcon,
  TrashIcon
} from './src/components/Icons';

export default function App() {
  const [activeTab, setActiveTab] = useState('vitals'); // 'vitals' | 'history' | 'contacts' | 'doctor' | 'settings'
  const [subTab, setSubTab] = useState('overview'); // 'overview' | 'charts' | 'presets'

  const [backendUrl, setBackendUrl] = useState('http://192.168.137.1:8000');
  const [urlInput, setUrlInput] = useState('http://192.168.137.1:8000');

  const [vitals, setVitals] = useState({
    heartRate: 74,
    spo2: 98.4,
    temperature: 36.6,
    source: 'watch_ble'
  });

  const [hrTrend, setHrTrend] = useState([
    72, 74, 73, 75, 74, 76, 74, 73, 75, 74, 72, 74, 75, 74, 76, 75, 74, 73, 74, 74
  ]);

  const [watchConnected, setWatchConnected] = useState(false);
  const [watchLinkName, setWatchLinkName] = useState('Standby');
  const [bleNotice, setBleNotice] = useState('');

  const [activeAlert, setActiveAlert] = useState(null);
  const [countdown, setCountdown] = useState(60);
  const [alertsList, setAlertsList] = useState([]);
  const [historyList, setHistoryList] = useState([]);
  const [contacts, setContacts] = useState([]);

  const [newContact, setNewContact] = useState({
    name: '',
    relationship: 'Family',
    phone: ''
  });
  const [scenario, setScenario] = useState('normal');

  const backendUrlRef = useRef(backendUrl);
  useEffect(() => {
    backendUrlRef.current = backendUrl;
  }, [backendUrl]);

  // Initialize Local SQLite DB on Launch
  useEffect(() => {
    (async () => {
      await getDb();
      const savedUrl = await getSavedSetting('backend_url', 'http://192.168.137.1:8000');
      setBackendUrl(savedUrl);
      setUrlInput(savedUrl);
      await refreshFromLocalDb();
    })();
  }, []);

  const refreshFromLocalDb = async () => {
    const readings = await getLocalReadings(30);
    if (readings && readings.length > 0) {
      setHistoryList(readings);
      const latest = readings[0];
      setVitals({
        heartRate: latest.heart_rate,
        spo2: latest.spo2,
        temperature: latest.temperature,
        source: latest.source
      });
    }
    const alerts = await getLocalAlerts();
    setAlertsList(alerts);
    const pending = alerts.find(
      a => a.status === 'PENDING_PATIENT_ACK' || a.status === 'ESCALATED_TO_DOCTOR'
    );
    if (pending) {
      setActiveAlert(pending);
    }
    const cts = await getLocalContacts();
    setContacts(cts);
  };

  // Record a new reading into Local SQLite DB + Sync to Backend if reachable
  const recordVitalReading = async (hr, spo2, temp, source = 'watch_ble', finger = true) => {
    setVitals({ heartRate: hr, spo2, temperature: temp, source });
    setHrTrend(prev => [...prev.slice(1), Math.round(hr)]);

    const createdAlert = await saveLocalReading(hr, spo2, temp, source, finger);
    if (createdAlert) {
      setActiveAlert(createdAlert);
      setCountdown(60);
    }
    await refreshFromLocalDb();

    // Optional sync to PC Doctor Portal if connected on Wi-Fi / Hotspot
    try {
      await fetch(`${backendUrlRef.current}/api/readings/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          patient_id: 2,
          heart_rate: Math.round(hr),
          spo2: Number(spo2.toFixed(1)),
          temperature: Number(temp.toFixed(1)),
          is_simulated: source === 'scenario',
          reading_source: source,
          finger
        })
      });
    } catch (e) {
      // Offline mode: local SQLite DB already persisted the reading
    }
  };

  // Poll Backend if Watch is plugged into PC USB instead of Phone BLE
  useEffect(() => {
    const poll = setInterval(async () => {
      if (watchConnected && watchLinkName.includes('BLE')) return;
      try {
        const res = await fetch(`${backendUrlRef.current}/api/readings/latest/2`);
        if (res.ok) {
          const data = await res.json();
          if (data && data.heart_rate) {
            setVitals({
              heartRate: data.heart_rate,
              spo2: data.spo2,
              temperature: data.temperature,
              source: data.reading_source || 'server_sync'
            });
            setHrTrend(prev => [...prev.slice(1), Math.round(data.heart_rate)]);
            if (data.watch_connected) {
              setWatchConnected(true);
              setWatchLinkName(data.watch_port || 'Host USB');
            }
          }
        }
      } catch (e) {}
    }, 2500);
    return () => clearInterval(poll);
  }, [watchConnected, watchLinkName]);

  // 60-Second Patient Acknowledgement Countdown
  useEffect(() => {
    if (!activeAlert || activeAlert.status !== 'PENDING_PATIENT_ACK') return;
    const timer = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          clearInterval(timer);
          handleEscalateAlert(activeAlert.id);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [activeAlert]);

  const handleAcknowledgeAlert = async () => {
    if (!activeAlert) return;
    await updateLocalAlertStatus(activeAlert.id, 'ACKNOWLEDGED', 'Acknowledged on mobile');
    try {
      await fetch(`${backendUrl}/api/alerts/${activeAlert.id}/acknowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patient_notes: 'Acknowledged on mobile.' })
      });
    } catch (e) {}
    setActiveAlert(null);
    await refreshFromLocalDb();
  };

  const handleEscalateAlert = async (alertId) => {
    await updateLocalAlertStatus(alertId, 'ESCALATED_TO_DOCTOR', '60s timeout escalated');
    try {
      await fetch(`${backendUrl}/api/alerts/${alertId}/escalate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
    } catch (e) {}
    setActiveAlert(prev => (prev ? { ...prev, status: 'ESCALATED_TO_DOCTOR' } : null));
    await refreshFromLocalDb();
  };

  const handlePairBluetoothWatch = () => {
    setBleNotice('Scanning for CarePulse Watch...');
    connectToCarePulseWatch({
      onConnected: (name) => {
        setWatchConnected(true);
        setWatchLinkName(`${name} (BLE)`);
        setBleNotice('');
      },
      onTelemetry: (data) => {
        const hr = Number(data.heart_rate || 72);
        const spo2 = Number(data.spo2 || 98);
        const temp = Number(data.temperature || 36.6);
        const finger = Boolean(data.finger);
        recordVitalReading(hr, spo2, temp, 'watch_ble', finger);
      },
      onDisconnected: () => {
        setWatchConnected(false);
        setWatchLinkName('Disconnected');
      },
      onError: (msg) => {
        setBleNotice(msg);
      }
    });
  };

  const triggerScenario = (mode) => {
    setScenario(mode);
    if (mode === 'tachycardia') recordVitalReading(128, 97.4, 37.0, 'scenario', true);
    else if (mode === 'low_spo2') recordVitalReading(89, 88.5, 36.7, 'scenario', true);
    else if (mode === 'fever') recordVitalReading(106, 96.2, 38.8, 'scenario', true);
    else {
      setActiveAlert(null);
      recordVitalReading(74, 98.4, 36.6, 'scenario', true);
    }
  };

  const handleCreateContact = async () => {
    if (!newContact.name.trim() || !newContact.phone.trim()) return;
    await addLocalContact(newContact.name.trim(), newContact.relationship.trim() || 'Family', newContact.phone.trim(), false);
    setNewContact({ name: '', relationship: 'Family', phone: '' });
    await refreshFromLocalDb();
  };

  const handleRemoveContact = async (id) => {
    await deleteLocalContact(id);
    await refreshFromLocalDb();
  };

  const handleSaveBackendUrl = async () => {
    const cleaned = urlInput.trim().replace(/\/$/, '');
    setBackendUrl(cleaned);
    await saveSetting('backend_url', cleaned);
  };

  // Build SVG Heart Rate Area Chart Path
  const chartW = 300;
  const chartH = 84;
  const stepX = chartW / Math.max(1, hrTrend.length - 1);
  const pointsCoords = hrTrend.map((val, idx) => {
    const clamped = Math.max(50, Math.min(180, val));
    const y = chartH - ((clamped - 50) / 130) * (chartH - 16) - 8;
    return { x: idx * stepX, y };
  });

  const linePath = pointsCoords
    .map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`)
    .join(' ');
  const areaPath = `${linePath} L ${chartW} ${chartH} L 0 ${chartH} Z`;

  const isHrAbnormal = vitals.heartRate > 110 || vitals.heartRate < 50;
  const isSpo2Abnormal = vitals.spo2 < 92.0;
  const isTempAbnormal = vitals.temperature > 38.0;
  const hasAnomaly = isHrAbnormal || isSpo2Abnormal || isTempAbnormal;
  const stabilityScore = hasAnomaly ? '4.2' : '9.6';

  const tabTitles = {
    vitals: 'Live Vitals',
    history: 'Telemetry Log',
    contacts: 'Emergency Contacts',
    doctor: 'Clinical Team',
    settings: 'Device Settings'
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor="#08080A" />

      {/* TOP HEADER */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.circleBtn}
          onPress={() => setActiveTab('vitals')}
        >
          <ChevronLeftIcon size={17} color="#FFFFFF" />
        </TouchableOpacity>

        <Text style={styles.headerTitle}>{tabTitles[activeTab]}</Text>

        <TouchableOpacity
          style={[
            styles.blePillBtn,
            watchConnected && styles.blePillBtnActive
          ]}
          onPress={handlePairBluetoothWatch}
        >
          <BluetoothIcon size={13} color={watchConnected ? '#0A0D0A' : '#D4FF47'} />
          <Text
            style={[
              styles.blePillText,
              watchConnected && { color: '#0A0D0A', fontWeight: '700' }
            ]}
          >
            {watchConnected ? 'Linked' : 'Pair'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* SUB-TABS */}
      {activeTab === 'vitals' && (
        <View style={styles.subTabsBar}>
          {['overview', 'charts', 'presets'].map(key => (
            <TouchableOpacity
              key={key}
              style={[styles.subTabBtn, subTab === key && styles.subTabBtnActive]}
              onPress={() => setSubTab(key)}
            >
              <Text style={[styles.subTabText, subTab === key && styles.subTabTextActive]}>
                {key.charAt(0).toUpperCase() + key.slice(1)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* MAIN CONTENT SCROLL */}
      <ScrollView
        style={styles.scrollArea}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {bleNotice ? (
          <View style={styles.noticeCard}>
            <Text style={styles.noticeText}>{bleNotice}</Text>
          </View>
        ) : null}

        {/* ==================== TAB 1: VITALS ==================== */}
        {activeTab === 'vitals' && (
          <>
            {/* Active Alert Prompt */}
            {activeAlert && (
              <View style={styles.alertCard}>
                <View style={styles.alertTopRow}>
                  <Text style={styles.alertTitleText}>
                    {activeAlert.status === 'ESCALATED_TO_DOCTOR'
                      ? 'ESCALATED TO PHYSICIAN'
                      : activeAlert.alert_type}
                  </Text>
                  <Text style={styles.alertTimerText}>
                    {activeAlert.status === 'ESCALATED_TO_DOCTOR'
                      ? 'Notified'
                      : `${countdown}s`}
                  </Text>
                </View>
                <Text style={styles.alertMessageText}>{activeAlert.message}</Text>
                {activeAlert.status === 'PENDING_PATIENT_ACK' && (
                  <TouchableOpacity
                    style={styles.ackButton}
                    onPress={handleAcknowledgeAlert}
                  >
                    <Text style={styles.ackButtonText}>Acknowledge Status</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}

            {/* Signature Teal-to-Volt-Lime Gradient Hero Card */}
            <LinearGradient
              colors={['#2CE5C6', '#B4F046', '#D8FF48']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.heroCard}
            >
              <View style={styles.heroMetaRow}>
                <Text style={styles.heroMetaText}>
                  {watchConnected ? `WATCH · ${watchLinkName.toUpperCase()}` : 'LOCAL SQLITE · READY'}
                </Text>
                <Text style={styles.heroMetaText}>LIVE</Text>
              </View>

              <Text style={styles.heroLabel}>Blood Oxygen</Text>
              <Text style={styles.heroMainValue}>
                {Number(vitals.spo2).toFixed(1)}
              </Text>
              <Text style={styles.heroUnit}>Percent SpO2</Text>

              <View style={styles.heroSplitRow}>
                <View style={styles.heroSplitCol}>
                  <Text style={styles.heroSubLabel}>Temperature</Text>
                  <Text style={styles.heroSubVal}>
                    {Number(vitals.temperature).toFixed(1)}
                  </Text>
                  <Text style={styles.heroSubUnit}>Celsius</Text>
                </View>
                <View style={styles.heroSplitCol}>
                  <Text style={styles.heroSubLabel}>Heart Rate</Text>
                  <Text style={styles.heroSubVal}>
                    {Math.round(vitals.heartRate)}
                  </Text>
                  <Text style={styles.heroSubUnit}>bpm</Text>
                </View>
              </View>
            </LinearGradient>

            {/* Heart Rate Area Chart Card */}
            <View style={styles.surfaceCard}>
              <View style={styles.cardTopRow}>
                <Text style={styles.cardTitle}>Heart Rate</Text>
                <Text style={styles.cardMeta}>
                  Avg. <Text style={styles.redHighlight}>{Math.round(vitals.heartRate)} bpm</Text>
                </Text>
              </View>

              <View style={styles.chartWrapper}>
                <Svg width="100%" height={chartH} viewBox={`0 0 ${chartW} ${chartH}`}>
                  <Defs>
                    <SvgGradient id="hrGrad" x1="0" y1="0" x2="0" y2="1">
                      <Stop offset="0" stopColor="#FF4D4D" stopOpacity="0.35" />
                      <Stop offset="1" stopColor="#FF4D4D" stopOpacity="0.0" />
                    </SvgGradient>
                  </Defs>
                  <Line x1="0" y1="16" x2={chartW} y2="16" stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
                  <Line x1="0" y1={chartH - 12} x2={chartW} y2={chartH - 12} stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
                  <Path d={areaPath} fill="url(#hrGrad)" />
                  <Path d={linePath} fill="none" stroke="#FF4D4D" strokeWidth="2" />
                </Svg>
              </View>

              <View style={styles.chartAxisRow}>
                <Text style={styles.axisLabel}>60 bpm</Text>
                <Text style={styles.axisLabel}>110 bpm</Text>
                <Text style={styles.axisLabel}>180 bpm</Text>
              </View>
            </View>

            {/* Stability Index Circular Gauge Card */}
            <View style={styles.surfaceCard}>
              <Text style={[styles.cardTitle, { marginBottom: 12 }]}>Stability Index</Text>
              <View style={styles.ringRow}>
                <View style={styles.ringBox}>
                  <Svg width={68} height={68} viewBox="0 0 68 68">
                    <Circle
                      cx="34"
                      cy="34"
                      r="28"
                      stroke="rgba(255,255,255,0.08)"
                      strokeWidth="5"
                      fill="none"
                    />
                    <Circle
                      cx="34"
                      cy="34"
                      r="28"
                      stroke={hasAnomaly ? '#FF4D4D' : '#D4FF47'}
                      strokeWidth="5"
                      strokeDasharray="175"
                      strokeDashoffset={hasAnomaly ? '95' : '22'}
                      strokeLinecap="round"
                      fill="none"
                      rotation="-90"
                      origin="34, 34"
                    />
                  </Svg>
                  <View style={styles.ringCenterText}>
                    <Text style={styles.ringScoreText}>{stabilityScore}</Text>
                    <Text style={styles.ringSubText}>
                      {hasAnomaly ? 'Alert' : 'Optimal'}
                    </Text>
                  </View>
                </View>

                <Text style={styles.ringDescText}>
                  {hasAnomaly
                    ? 'Vital parameters outside baseline range. Escalation monitoring is active.'
                    : 'Cardiorespiratory telemetry is steady and saved to on-device SQLite.'}
                </Text>
              </View>
            </View>

            {/* Scenario Filter Pills */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.pillsRow}
            >
              {[
                { key: 'normal', label: 'Baseline' },
                { key: 'tachycardia', label: 'High BPM' },
                { key: 'low_spo2', label: 'Low SpO2' },
                { key: 'fever', label: 'High Temp' }
              ].map(item => (
                <TouchableOpacity
                  key={item.key}
                  style={[
                    styles.scenarioPill,
                    scenario === item.key && styles.scenarioPillActive
                  ]}
                  onPress={() => triggerScenario(item.key)}
                >
                  <Text
                    style={[
                      styles.scenarioPillText,
                      scenario === item.key && styles.scenarioPillTextActive
                    ]}
                  >
                    {item.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </>
        )}

        {/* ==================== TAB 2: HISTORY (LOCAL SQLITE) ==================== */}
        {activeTab === 'history' && (
          <View>
            <View style={styles.sectionRow}>
              <Text style={styles.sectionSub}>On-Device SQLite Records</Text>
              <Text style={styles.sectionSub}>{historyList.length} entries</Text>
            </View>
            {historyList.map((item, idx) => {
              const abnormal =
                item.heart_rate > 110 ||
                item.heart_rate < 50 ||
                item.spo2 < 92 ||
                item.temperature > 38;
              return (
                <View key={item.id || idx} style={styles.listRowCard}>
                  <View>
                    <Text style={styles.listRowPrimary}>
                      {item.heart_rate} bpm  ·  {Number(item.spo2).toFixed(1)}%  ·  {Number(item.temperature).toFixed(1)}°C
                    </Text>
                    <Text style={styles.listRowSecondary}>
                      {item.source} · {new Date(item.recorded_at).toLocaleTimeString()}
                    </Text>
                  </View>
                  <Text
                    style={[
                      styles.statusTag,
                      { color: abnormal ? '#FF4D4D' : '#D4FF47' }
                    ]}
                  >
                    {abnormal ? 'Alert' : 'Normal'}
                  </Text>
                </View>
              );
            })}
          </View>
        )}

        {/* ==================== TAB 3: EMERGENCY CONTACTS ==================== */}
        {activeTab === 'contacts' && (
          <View>
            {contacts.map(c => (
              <View key={c.id} style={styles.listRowCard}>
                <View>
                  <Text style={styles.listRowPrimary}>{c.name}</Text>
                  <Text style={styles.listRowSecondary}>
                    {c.relationship} · {c.phone}
                  </Text>
                </View>
                <TouchableOpacity
                  style={styles.circleBtn}
                  onPress={() => handleRemoveContact(c.id)}
                >
                  <TrashIcon size={15} color="#8E8E98" />
                </TouchableOpacity>
              </View>
            ))}

            <View style={[styles.surfaceCard, { marginTop: 10 }]}>
              <Text style={[styles.cardTitle, { marginBottom: 12 }]}>New Contact</Text>
              <TextInput
                style={styles.inputField}
                placeholder="Full name"
                placeholderTextColor="#5C5C66"
                value={newContact.name}
                onChangeText={t => setNewContact({ ...newContact, name: t })}
              />
              <TextInput
                style={styles.inputField}
                placeholder="Relationship"
                placeholderTextColor="#5C5C66"
                value={newContact.relationship}
                onChangeText={t => setNewContact({ ...newContact, relationship: t })}
              />
              <TextInput
                style={styles.inputField}
                placeholder="Phone number"
                placeholderTextColor="#5C5C66"
                value={newContact.phone}
                onChangeText={t => setNewContact({ ...newContact, phone: t })}
              />
              <TouchableOpacity style={styles.ackButton} onPress={handleCreateContact}>
                <Text style={styles.ackButtonText}>Save to Local DB</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* ==================== TAB 4: CLINICAL TEAM ==================== */}
        {activeTab === 'doctor' && (
          <View style={{ gap: 12 }}>
            <View style={styles.surfaceCard}>
              <Text style={styles.overlineVolt}>ASSIGNED PHYSICIAN</Text>
              <Text style={styles.docName}>Dr. Sarah Jenkins, MD</Text>
              <Text style={styles.listRowSecondary}>
                Cardiology · Metro General Teaching Hospital
              </Text>
              <Text style={[styles.listRowSecondary, { marginTop: 8 }]}>
                Direct Triage: +1-555-0199
              </Text>
            </View>

            <View style={styles.surfaceCard}>
              <Text style={[styles.cardTitle, { marginBottom: 6 }]}>Escalation Protocol</Text>
              <Text style={styles.ringDescText}>
                Unacknowledged alerts automatically escalate to Dr. Sarah Jenkins after 60 seconds and sync with the clinical portal.
              </Text>
            </View>
          </View>
        )}

        {/* ==================== TAB 5: SETTINGS ==================== */}
        {activeTab === 'settings' && (
          <View style={{ gap: 12 }}>
            <View style={styles.surfaceCard}>
              <Text style={[styles.cardTitle, { marginBottom: 8 }]}>Hardware & Storage</Text>
              <Text style={styles.listRowSecondary}>Watch BLE Name: CarePulse Watch</Text>
              <Text style={[styles.listRowSecondary, { marginTop: 4 }]}>
                On-Device DB: carepulse_mobile.db (SQLite)
              </Text>
              <Text style={[styles.listRowSecondary, { marginTop: 4 }]}>
                Link Status: {watchConnected ? watchLinkName : 'Standby'}
              </Text>
            </View>

            <View style={styles.surfaceCard}>
              <Text style={[styles.cardTitle, { marginBottom: 8 }]}>
                PC Hotspot / Server URL
              </Text>
              <TextInput
                style={styles.inputField}
                value={urlInput}
                onChangeText={setUrlInput}
                placeholder="http://192.168.137.1:8000"
                placeholderTextColor="#5C5C66"
                autoCapitalize="none"
              />
              <TouchableOpacity style={styles.ackButton} onPress={handleSaveBackendUrl}>
                <Text style={styles.ackButtonText}>Save Endpoint</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </ScrollView>

      {/* FLOATING PILL BOTTOM NAVIGATION BAR */}
      <View style={styles.bottomPillNav}>
        {[
          { key: 'vitals', Icon: ActivityIcon },
          { key: 'history', Icon: CalendarIcon },
          { key: 'contacts', Icon: TargetIcon },
          { key: 'doctor', Icon: UserIcon },
          { key: 'settings', Icon: SettingsIcon }
        ].map(({ key, Icon }) => {
          const isActive = activeTab === key;
          return (
            <TouchableOpacity
              key={key}
              style={[styles.navPillItem, isActive && styles.navPillItemActive]}
              onPress={() => setActiveTab(key)}
            >
              <Icon size={19} color={isActive ? '#D4FF47' : '#8E8E98'} />
            </TouchableOpacity>
          );
        })}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#08080A',
    paddingTop: Platform.OS === 'android' ? 10 : 0
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 12
  },
  circleBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#141417',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  headerTitle: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: -0.2
  },
  blePillBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(212, 255, 71, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(212, 255, 71, 0.35)',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999
  },
  blePillBtnActive: {
    backgroundColor: '#D4FF47',
    borderColor: '#D4FF47'
  },
  blePillText: {
    color: '#D4FF47',
    fontSize: 12,
    fontWeight: '600'
  },
  subTabsBar: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
    gap: 24
  },
  subTabBtn: {
    paddingBottom: 10
  },
  subTabBtnActive: {
    borderBottomWidth: 2,
    borderBottomColor: '#FFFFFF'
  },
  subTabText: {
    color: '#8E8E98',
    fontSize: 13,
    fontWeight: '500'
  },
  subTabTextActive: {
    color: '#FFFFFF',
    fontWeight: '600'
  },
  scrollArea: {
    flex: 1
  },
  scrollContent: {
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 105,
    gap: 12
  },
  noticeCard: {
    backgroundColor: '#141417',
    borderWidth: 1,
    borderColor: 'rgba(212, 255, 71, 0.3)',
    borderRadius: 16,
    padding: 12
  },
  noticeText: {
    color: '#D4FF47',
    fontSize: 12,
    lineHeight: 17
  },
  heroCard: {
    borderRadius: 24,
    padding: 20
  },
  heroMetaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10
  },
  heroMetaText: {
    color: '#0A0D0A',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.5,
    opacity: 0.75
  },
  heroLabel: {
    color: '#0A0D0A',
    fontSize: 13,
    fontWeight: '500',
    opacity: 0.8
  },
  heroMainValue: {
    color: '#0A0D0A',
    fontSize: 54,
    fontWeight: '300',
    letterSpacing: -2,
    lineHeight: 60
  },
  heroUnit: {
    color: '#0A0D0A',
    fontSize: 12,
    fontWeight: '500',
    opacity: 0.75,
    marginBottom: 14
  },
  heroSplitRow: {
    flexDirection: 'row',
    paddingTop: 6
  },
  heroSplitCol: {
    flex: 1
  },
  heroSubLabel: {
    color: '#0A0D0A',
    fontSize: 12,
    fontWeight: '500',
    opacity: 0.75
  },
  heroSubVal: {
    color: '#0A0D0A',
    fontSize: 22,
    fontWeight: '500',
    marginTop: 2
  },
  heroSubUnit: {
    color: '#0A0D0A',
    fontSize: 11,
    opacity: 0.75
  },
  surfaceCard: {
    backgroundColor: '#141417',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    borderRadius: 22,
    padding: 16
  },
  cardTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10
  },
  cardTitle: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600'
  },
  cardMeta: {
    color: '#8E8E98',
    fontSize: 12
  },
  redHighlight: {
    color: '#FF4D4D',
    fontWeight: '600'
  },
  chartWrapper: {
    height: 84,
    width: '100%'
  },
  chartAxisRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 6
  },
  axisLabel: {
    color: '#5C5C66',
    fontSize: 11
  },
  ringRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16
  },
  ringBox: {
    width: 68,
    height: 68,
    alignItems: 'center',
    justifyContent: 'center'
  },
  ringCenterText: {
    position: 'absolute',
    alignItems: 'center'
  },
  ringScoreText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600'
  },
  ringSubText: {
    color: '#8E8E98',
    fontSize: 9
  },
  ringDescText: {
    flex: 1,
    color: '#8E8E98',
    fontSize: 12,
    lineHeight: 18
  },
  alertCard: {
    backgroundColor: 'rgba(255, 77, 77, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255, 77, 77, 0.45)',
    borderRadius: 20,
    padding: 15
  },
  alertTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6
  },
  alertTitleText: {
    color: '#FF4D4D',
    fontSize: 12,
    fontWeight: '700'
  },
  alertTimerText: {
    color: '#FF4D4D',
    fontSize: 12,
    fontWeight: '600'
  },
  alertMessageText: {
    color: '#FFFFFF',
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 10
  },
  ackButton: {
    backgroundColor: '#D4FF47',
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: 'center'
  },
  ackButtonText: {
    color: '#0A0D0A',
    fontSize: 13,
    fontWeight: '600'
  },
  pillsRow: {
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 4
  },
  scenarioPill: {
    backgroundColor: '#141417',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999
  },
  scenarioPillActive: {
    backgroundColor: '#D4FF47',
    borderColor: '#D4FF47'
  },
  scenarioPillText: {
    color: '#8E8E98',
    fontSize: 12,
    fontWeight: '500'
  },
  scenarioPillTextActive: {
    color: '#0A0D0A',
    fontWeight: '600'
  },
  sectionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10
  },
  sectionSub: {
    color: '#8E8E98',
    fontSize: 12
  },
  listRowCard: {
    backgroundColor: '#141417',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    borderRadius: 18,
    padding: 14,
    marginBottom: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  listRowPrimary: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600'
  },
  listRowSecondary: {
    color: '#8E8E98',
    fontSize: 12,
    marginTop: 2
  },
  statusTag: {
    fontSize: 12,
    fontWeight: '600'
  },
  inputField: {
    backgroundColor: '#08080A',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: 12,
    color: '#FFFFFF',
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13,
    marginBottom: 8
  },
  overlineVolt: {
    color: '#D4FF47',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.5
  },
  docName: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '600',
    marginTop: 4
  },
  bottomPillNav: {
    position: 'absolute',
    bottom: 20,
    left: 20,
    right: 20,
    height: 58,
    backgroundColor: 'rgba(20, 20, 23, 0.94)',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingHorizontal: 8
  },
  navPillItem: {
    width: 50,
    height: 40,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center'
  },
  navPillItemActive: {
    backgroundColor: 'rgba(212, 255, 71, 0.16)'
  }
});
