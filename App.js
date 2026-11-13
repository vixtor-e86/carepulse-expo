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
  Platform,
  useWindowDimensions
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Path, Defs, LinearGradient as SvgGradient, Stop, Circle, Line } from 'react-native-svg';
import {
  getDb,
  clearLocalReadings,
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
  BluetoothIcon,
  TrashIcon
} from './src/components/Icons';

const TAB_KEYS = ['vitals', 'history', 'contacts', 'doctor', 'settings'];

const TAB_TITLES = {
  vitals: 'Live Vitals',
  history: 'Telemetry Log',
  contacts: 'Emergency Contacts',
  doctor: 'Clinical Team',
  settings: 'Device Settings'
};

export default function App() {
  const { width: screenWidth } = useWindowDimensions();
  const pagerRef = useRef(null);

  const [activeTab, setActiveTab] = useState('vitals');

  const [backendUrl, setBackendUrl] = useState('http://192.168.137.1:8000');
  const [urlInput, setUrlInput] = useState('http://192.168.137.1:8000');

  // Zero mock values: starts empty until live watch telemetry arrives
  const [vitals, setVitals] = useState({
    heartRate: null,
    spo2: null,
    temperature: null,
    finger: false,
    source: 'none'
  });

  const [hrTrend, setHrTrend] = useState([]);

  const [watchConnected, setWatchConnected] = useState(false);
  const [watchLinkName, setWatchLinkName] = useState('Not Connected');
  const [bleNotice, setBleNotice] = useState('');
  const [lastPacketTime, setLastPacketTime] = useState(null);

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

  const backendUrlRef = useRef(backendUrl);
  useEffect(() => {
    backendUrlRef.current = backendUrl;
  }, [backendUrl]);

  // Navigate to a tab via tap or back button and scroll the horizontal pager
  const goToTab = (tabKey) => {
    const idx = TAB_KEYS.indexOf(tabKey);
    if (idx === -1) return;
    setActiveTab(tabKey);
    if (pagerRef.current && screenWidth > 0) {
      pagerRef.current.scrollTo({ x: idx * screenWidth, animated: true });
    }
  };

  // Sync activeTab when user swipes horizontally between pages
  const handleSwipeScrollEnd = (e) => {
    if (!screenWidth) return;
    const offsetX = e.nativeEvent.contentOffset.x;
    const pageIndex = Math.round(offsetX / screenWidth);
    const nextTab = TAB_KEYS[pageIndex];
    if (nextTab && nextTab !== activeTab) {
      setActiveTab(nextTab);
    }
  };

  // Initialize Local SQLite DB on Launch (purges any legacy mock readings)
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
    const readings = await getLocalReadings(40);
    setHistoryList(readings || []);

    const alerts = await getLocalAlerts();
    setAlertsList(alerts || []);
    const pending = (alerts || []).find(
      a => a.status === 'PENDING_PATIENT_ACK' || a.status === 'ESCALATED_TO_DOCTOR'
    );
    setActiveAlert(pending || null);

    const cts = await getLocalContacts();
    setContacts(cts || []);
  };

  // Process a live hardware reading from the CarePulse Watch
  const recordVitalReading = async (hr, spo2, temp, source = 'watch_ble', finger = true) => {
    const validHr = finger && hr > 0 ? Number(hr) : null;
    const validSpo2 = finger && spo2 > 0 ? Number(spo2) : null;
    const validTemp = temp > 0 ? Number(temp) : null;

    setVitals({
      heartRate: validHr,
      spo2: validSpo2,
      temperature: validTemp,
      finger,
      source
    });
    setLastPacketTime(new Date().toLocaleTimeString());

    if (validHr !== null) {
      setHrTrend(prev => [...prev.slice(-19), Math.round(validHr)]);
    }

    const createdAlert = await saveLocalReading(
      validHr || 0,
      validSpo2 || 0,
      validTemp || 0,
      source,
      finger
    );
    if (createdAlert) {
      setActiveAlert(createdAlert);
      setCountdown(60);
    }
    await refreshFromLocalDb();

    // Optional sync to PC Doctor Portal if reachable
    if (validHr !== null || validTemp !== null) {
      try {
        await fetch(`${backendUrlRef.current}/api/readings/ingest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            patient_id: 2,
            heart_rate: validHr ? Math.round(validHr) : 0,
            spo2: validSpo2 ? Number(validSpo2.toFixed(1)) : 0,
            temperature: validTemp ? Number(validTemp.toFixed(1)) : 0,
            is_simulated: false,
            reading_source: source,
            finger
          })
        });
      } catch (e) {
        // Offline mode: reading is already saved in on-device SQLite
      }
    }
  };

  // Poll Backend ONLY if Watch is connected to PC USB and NOT connected via Phone BLE
  useEffect(() => {
    const poll = setInterval(async () => {
      if (watchConnected && watchLinkName.includes('BLE')) return;
      try {
        const res = await fetch(`${backendUrlRef.current}/api/readings/latest/2`);
        if (res.ok) {
          const data = await res.json();
          if (data && data.watch_connected && !data.is_simulated) {
            const finger = data.finger !== undefined ? Boolean(data.finger) : true;
            setWatchConnected(true);
            setWatchLinkName(data.watch_port ? `${data.watch_port} (USB)` : 'Host USB');
            setVitals({
              heartRate: finger && data.heart_rate > 0 ? Number(data.heart_rate) : null,
              spo2: finger && data.spo2 > 0 ? Number(data.spo2) : null,
              temperature: data.temperature > 0 ? Number(data.temperature) : null,
              finger,
              source: 'watch_usb'
            });
            setLastPacketTime(new Date().toLocaleTimeString());
            if (finger && data.heart_rate > 0) {
              setHrTrend(prev => [...prev.slice(-19), Math.round(data.heart_rate)]);
            }
          }
        }
      } catch (e) {}
    }, 2000);
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
    setBleNotice('Scanning for CarePulse Watch over Bluetooth...');
    connectToCarePulseWatch({
      onConnected: (name) => {
        setWatchConnected(true);
        setWatchLinkName(`${name} (BLE)`);
        setBleNotice('');
      },
      onTelemetry: (data) => {
        const finger = data.finger !== undefined ? Boolean(data.finger) : true;
        const hr = data.heart_rate !== undefined ? Number(data.heart_rate) : 0;
        const spo2 = data.spo2 !== undefined ? Number(data.spo2) : 0;
        const temp = data.temperature !== undefined ? Number(data.temperature) : 0;
        recordVitalReading(hr, spo2, temp, 'watch_ble', finger);
      },
      onDisconnected: () => {
        setWatchConnected(false);
        setWatchLinkName('Disconnected');
        setVitals({
          heartRate: null,
          spo2: null,
          temperature: null,
          finger: false,
          source: 'none'
        });
      },
      onError: (msg) => {
        setBleNotice(msg);
      }
    });
  };

  const handleClearHistory = async () => {
    await clearLocalReadings();
    setHrTrend([]);
    setActiveAlert(null);
    await refreshFromLocalDb();
  };

  const handleCreateContact = async () => {
    if (!newContact.name.trim() || !newContact.phone.trim()) return;
    await addLocalContact(
      newContact.name.trim(),
      newContact.relationship.trim() || 'Family',
      newContact.phone.trim(),
      false
    );
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

  // Build SVG Heart Rate Area Chart Path from Live Watch Readings
  const chartW = 300;
  const chartH = 84;
  const displayTrend = hrTrend.length > 1 ? hrTrend : hrTrend.length === 1 ? [hrTrend[0], hrTrend[0]] : [];
  const stepX = displayTrend.length > 1 ? chartW / (displayTrend.length - 1) : chartW;
  const pointsCoords = displayTrend.map((val, idx) => {
    const clamped = Math.max(50, Math.min(180, val));
    const y = chartH - ((clamped - 50) / 130) * (chartH - 16) - 8;
    return { x: idx * stepX, y };
  });

  const linePath =
    pointsCoords.length > 0
      ? pointsCoords.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`).join(' ')
      : '';
  const areaPath = linePath ? `${linePath} L ${chartW} ${chartH} L 0 ${chartH} Z` : '';

  const hasLiveHr = vitals.heartRate !== null && vitals.heartRate > 0;
  const hasLiveSpo2 = vitals.spo2 !== null && vitals.spo2 > 0;
  const hasLiveTemp = vitals.temperature !== null && vitals.temperature > 0;

  const isHrAbnormal = hasLiveHr && (vitals.heartRate > 110 || vitals.heartRate < 50);
  const isSpo2Abnormal = hasLiveSpo2 && vitals.spo2 < 92.0;
  const isTempAbnormal = hasLiveTemp && vitals.temperature > 38.0;
  const hasAnomaly = isHrAbnormal || isSpo2Abnormal || isTempAbnormal;
  const stabilityScore = !watchConnected
    ? '--'
    : !vitals.finger
    ? 'Wait'
    : hasAnomaly
    ? '4.2'
    : '9.8';

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor="#08080A" />

      {/* TOP HEADER */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.circleBtn} onPress={() => goToTab('vitals')}>
          <ChevronLeftIcon size={17} color="#FFFFFF" />
        </TouchableOpacity>

        <View style={{ alignItems: 'center' }}>
          <Text style={styles.headerTitle}>{TAB_TITLES[activeTab]}</Text>
          <View style={styles.pageDotsRow}>
            {TAB_KEYS.map(key => (
              <View
                key={key}
                style={[styles.pageDot, activeTab === key && styles.pageDotActive]}
              />
            ))}
          </View>
        </View>

        <TouchableOpacity
          style={[styles.blePillBtn, watchConnected && styles.blePillBtnActive]}
          onPress={handlePairBluetoothWatch}
        >
          <BluetoothIcon size={13} color={watchConnected ? '#0A0D0A' : '#D4FF47'} />
          <Text
            style={[
              styles.blePillText,
              watchConnected && { color: '#0A0D0A', fontWeight: '700' }
            ]}
          >
            {watchConnected ? 'Linked' : 'Pair Watch'}
          </Text>
        </TouchableOpacity>
      </View>

      {bleNotice ? (
        <View style={[styles.noticeCard, { marginHorizontal: 18, marginBottom: 4 }]}>
          <Text style={styles.noticeText}>{bleNotice}</Text>
        </View>
      ) : null}

      {/* HORIZONTAL SWIPEABLE PAGER FOR ALL 5 TABS */}
      <ScrollView
        ref={pagerRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={handleSwipeScrollEnd}
        scrollEventThrottle={16}
        style={styles.pager}
      >
        {/* ==================== PAGE 1: LIVE VITALS ==================== */}
        <View style={{ width: screenWidth }}>
          <ScrollView
            style={styles.scrollArea}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
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
                  <TouchableOpacity style={styles.ackButton} onPress={handleAcknowledgeAlert}>
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
                  {!watchConnected
                    ? 'BLUETOOTH DISCONNECTED · TAP PAIR WATCH'
                    : vitals.finger
                    ? `${watchLinkName.toUpperCase()} · FINGER ON SENSOR`
                    : `${watchLinkName.toUpperCase()} · PLACE FINGER ON WATCH`}
                </Text>
                <Text style={styles.heroMetaText}>
                  {watchConnected ? (lastPacketTime || 'LIVE') : 'OFFLINE'}
                </Text>
              </View>

              <Text style={styles.heroLabel}>Blood Oxygen</Text>
              <Text style={styles.heroMainValue}>
                {hasLiveSpo2 ? Number(vitals.spo2).toFixed(1) : '--'}
              </Text>
              <Text style={styles.heroUnit}>Percent SpO2</Text>

              <View style={styles.heroSplitRow}>
                <View style={styles.heroSplitCol}>
                  <Text style={styles.heroSubLabel}>Temperature</Text>
                  <Text style={styles.heroSubVal}>
                    {hasLiveTemp ? Number(vitals.temperature).toFixed(1) : '--'}
                  </Text>
                  <Text style={styles.heroSubUnit}>Celsius</Text>
                </View>
                <View style={styles.heroSplitCol}>
                  <Text style={styles.heroSubLabel}>Heart Rate</Text>
                  <Text style={styles.heroSubVal}>
                    {hasLiveHr ? Math.round(vitals.heartRate) : '--'}
                  </Text>
                  <Text style={styles.heroSubUnit}>bpm</Text>
                </View>
              </View>
            </LinearGradient>

            {/* Heart Rate Area Chart Card */}
            <View style={styles.surfaceCard}>
              <View style={styles.cardTopRow}>
                <Text style={styles.cardTitle}>Heart Rate Live Stream</Text>
                <Text style={styles.cardMeta}>
                  Current{' '}
                  <Text style={styles.redHighlight}>
                    {hasLiveHr ? `${Math.round(vitals.heartRate)} bpm` : '-- bpm'}
                  </Text>
                </Text>
              </View>

              <View style={styles.chartWrapper}>
                {linePath ? (
                  <Svg width="100%" height={chartH} viewBox={`0 0 ${chartW} ${chartH}`}>
                    <Defs>
                      <SvgGradient id="hrGrad" x1="0" y1="0" x2="0" y2="1">
                        <Stop offset="0" stopColor="#FF4D4D" stopOpacity="0.35" />
                        <Stop offset="1" stopColor="#FF4D4D" stopOpacity="0.0" />
                      </SvgGradient>
                    </Defs>
                    <Line
                      x1="0"
                      y1="16"
                      x2={chartW}
                      y2="16"
                      stroke="rgba(255,255,255,0.06)"
                      strokeWidth="1"
                    />
                    <Line
                      x1="0"
                      y1={chartH - 12}
                      x2={chartW}
                      y2={chartH - 12}
                      stroke="rgba(255,255,255,0.06)"
                      strokeWidth="1"
                    />
                    <Path d={areaPath} fill="url(#hrGrad)" />
                    <Path d={linePath} fill="none" stroke="#FF4D4D" strokeWidth="2" />
                  </Svg>
                ) : (
                  <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={styles.axisLabel}>
                      {watchConnected
                        ? 'Place your finger on the watch sensor to plot live BPM...'
                        : 'Pair CarePulse Watch via Bluetooth to stream live BPM...'}
                    </Text>
                  </View>
                )}
              </View>

              <View style={styles.chartAxisRow}>
                <Text style={styles.axisLabel}>60 bpm</Text>
                <Text style={styles.axisLabel}>110 bpm</Text>
                <Text style={styles.axisLabel}>180 bpm</Text>
              </View>
            </View>

            {/* Stability Index Circular Gauge Card */}
            <View style={styles.surfaceCard}>
              <Text style={[styles.cardTitle, { marginBottom: 12 }]}>Sensor Telemetry Status</Text>
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
                      stroke={!watchConnected ? '#5C5C66' : hasAnomaly ? '#FF4D4D' : '#D4FF47'}
                      strokeWidth="5"
                      strokeDasharray="175"
                      strokeDashoffset={!watchConnected ? '175' : hasAnomaly ? '95' : '22'}
                      strokeLinecap="round"
                      fill="none"
                      rotation="-90"
                      origin="34, 34"
                    />
                  </Svg>
                  <View style={styles.ringCenterText}>
                    <Text style={styles.ringScoreText}>{stabilityScore}</Text>
                    <Text style={styles.ringSubText}>
                      {!watchConnected ? 'Idle' : hasAnomaly ? 'Alert' : 'Live'}
                    </Text>
                  </View>
                </View>

                <Text style={styles.ringDescText}>
                  {!watchConnected
                    ? 'Tap "Pair Watch" in the top-right corner to connect directly to your CarePulse Watch over Bluetooth.'
                    : !vitals.finger
                    ? 'Bluetooth connected. Place your finger on the MAX30102 sensor to read live Heart Rate & SpO2. Temperature updates continuously.'
                    : hasAnomaly
                    ? 'Vital parameters outside baseline range. Escalation monitoring is active.'
                    : 'Live MAX30102 & MLX90614 watch readings are streaming over Bluetooth and saving to SQLite.'}
                </Text>
              </View>
            </View>
          </ScrollView>
        </View>

        {/* ==================== PAGE 2: HISTORY (LOCAL SQLITE) ==================== */}
        <View style={{ width: screenWidth }}>
          <ScrollView
            style={styles.scrollArea}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.sectionRow}>
              <Text style={styles.sectionSub}>On-Device SQLite Watch Log ({historyList.length})</Text>
              {historyList.length > 0 && (
                <TouchableOpacity onPress={handleClearHistory}>
                  <Text style={[styles.sectionSub, { color: '#FF4D4D', fontWeight: '600' }]}>
                    Clear Log
                  </Text>
                </TouchableOpacity>
              )}
            </View>
            {historyList.length === 0 ? (
              <View style={styles.surfaceCard}>
                <Text style={styles.ringDescText}>
                  No watch readings recorded yet. Connect your CarePulse Watch via Bluetooth to log live sensor data.
                </Text>
              </View>
            ) : (
              historyList.map((item, idx) => {
                const abnormal =
                  (item.heart_rate > 0 && (item.heart_rate > 110 || item.heart_rate < 50)) ||
                  (item.spo2 > 0 && item.spo2 < 92) ||
                  item.temperature > 38;
                return (
                  <View key={item.id || idx} style={styles.listRowCard}>
                    <View>
                      <Text style={styles.listRowPrimary}>
                        {item.heart_rate > 0 ? `${item.heart_rate} bpm` : '-- bpm'}  ·  {item.spo2 > 0 ? `${Number(item.spo2).toFixed(1)}%` : '--%'}  ·  {item.temperature > 0 ? `${Number(item.temperature).toFixed(1)}°C` : '--°C'}
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
              })
            )}
          </ScrollView>
        </View>

        {/* ==================== PAGE 3: EMERGENCY CONTACTS ==================== */}
        <View style={{ width: screenWidth }}>
          <ScrollView
            style={styles.scrollArea}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            {contacts.length === 0 ? (
              <View style={[styles.surfaceCard, { marginBottom: 10 }]}>
                <Text style={styles.ringDescText}>
                  No emergency contacts saved yet. Add a contact below.
                </Text>
              </View>
            ) : (
              contacts.map(c => (
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
              ))
            )}

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
          </ScrollView>
        </View>

        {/* ==================== PAGE 4: CLINICAL TEAM ==================== */}
        <View style={{ width: screenWidth }}>
          <ScrollView
            style={styles.scrollArea}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
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
                Unacknowledged alerts automatically escalate after 60 seconds and sync with the clinical portal.
              </Text>
            </View>
          </ScrollView>
        </View>

        {/* ==================== PAGE 5: SETTINGS ==================== */}
        <View style={{ width: screenWidth }}>
          <ScrollView
            style={styles.scrollArea}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.surfaceCard}>
              <Text style={[styles.cardTitle, { marginBottom: 8 }]}>Hardware & Storage</Text>
              <Text style={styles.listRowSecondary}>Watch BLE Name: CarePulse Watch</Text>
              <Text style={[styles.listRowSecondary, { marginTop: 4 }]}>
                On-Device DB: carepulse_mobile.db (SQLite)
              </Text>
              <Text style={[styles.listRowSecondary, { marginTop: 4 }]}>
                Link Status: {watchConnected ? watchLinkName : 'Not Connected'}
              </Text>
              <TouchableOpacity
                style={[styles.ackButton, { marginTop: 12, backgroundColor: '#232329' }]}
                onPress={handleClearHistory}
              >
                <Text style={[styles.ackButtonText, { color: '#FF4D4D' }]}>
                  Clear Stored Readings
                </Text>
              </TouchableOpacity>
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
          </ScrollView>
        </View>
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
              onPress={() => goToTab(key)}
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
  pageDotsRow: {
    flexDirection: 'row',
    gap: 5,
    marginTop: 5
  },
  pageDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: '#2A2A32'
  },
  pageDotActive: {
    width: 14,
    backgroundColor: '#D4FF47'
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
  pager: {
    flex: 1
  },
  scrollArea: {
    flex: 1
  },
  scrollContent: {
    paddingHorizontal: 18,
    paddingTop: 10,
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
  alertCard: {
    backgroundColor: 'rgba(255, 77, 77, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255, 77, 77, 0.35)',
    borderRadius: 20,
    padding: 16
  },
  alertTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  alertTitleText: {
    color: '#FF4D4D',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.4
  },
  alertTimerText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700'
  },
  alertMessageText: {
    color: '#FFFFFF',
    fontSize: 13,
    marginTop: 6,
    lineHeight: 18
  },
  ackButton: {
    marginTop: 12,
    backgroundColor: '#D4FF47',
    borderRadius: 12,
    paddingVertical: 11,
    alignItems: 'center'
  },
  ackButtonText: {
    color: '#0A0D0A',
    fontSize: 13,
    fontWeight: '700'
  },
  heroCard: {
    borderRadius: 26,
    padding: 22
  },
  heroMetaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10
  },
  heroMetaText: {
    color: 'rgba(10, 13, 10, 0.65)',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.6
  },
  heroLabel: {
    color: '#0A0D0A',
    fontSize: 14,
    fontWeight: '600'
  },
  heroMainValue: {
    color: '#0A0D0A',
    fontSize: 54,
    fontWeight: '700',
    letterSpacing: -2,
    marginVertical: 2
  },
  heroUnit: {
    color: 'rgba(10, 13, 10, 0.72)',
    fontSize: 12,
    fontWeight: '600'
  },
  heroSplitRow: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: 'rgba(10, 13, 10, 0.14)',
    marginTop: 16,
    paddingTop: 14
  },
  heroSplitCol: {
    flex: 1
  },
  heroSubLabel: {
    color: 'rgba(10, 13, 10, 0.72)',
    fontSize: 12,
    fontWeight: '600'
  },
  heroSubVal: {
    color: '#0A0D0A',
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: -0.8,
    marginTop: 2
  },
  heroSubUnit: {
    color: 'rgba(10, 13, 10, 0.68)',
    fontSize: 11,
    fontWeight: '600'
  },
  surfaceCard: {
    backgroundColor: '#141417',
    borderRadius: 22,
    padding: 18,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.06)'
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
    fontWeight: '700'
  },
  chartWrapper: {
    height: 86,
    marginVertical: 4
  },
  chartAxisRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 4
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
    alignItems: 'center',
    justifyContent: 'center'
  },
  ringScoreText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700'
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
  sectionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
    paddingHorizontal: 2
  },
  sectionSub: {
    color: '#8E8E98',
    fontSize: 12
  },
  listRowCard: {
    backgroundColor: '#141417',
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.06)',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8
  },
  listRowPrimary: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600'
  },
  listRowSecondary: {
    color: '#8E8E98',
    fontSize: 12,
    marginTop: 3
  },
  statusTag: {
    fontSize: 12,
    fontWeight: '600'
  },
  inputField: {
    backgroundColor: '#1C1C21',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    borderRadius: 12,
    color: '#FFFFFF',
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 13,
    marginBottom: 10
  },
  overlineVolt: {
    color: '#D4FF47',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.7,
    marginBottom: 4
  },
  docName: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '600',
    marginBottom: 4
  },
  bottomPillNav: {
    position: 'absolute',
    bottom: 18,
    left: 24,
    right: 24,
    backgroundColor: 'rgba(22, 22, 26, 0.96)',
    borderRadius: 999,
    padding: 6,
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)'
  },
  navPillItem: {
    flex: 1,
    height: 42,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center'
  },
  navPillItemActive: {
    backgroundColor: '#26262C'
  }
});
