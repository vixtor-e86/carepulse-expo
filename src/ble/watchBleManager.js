import { Platform, PermissionsAndroid } from 'react-native';

const SERVICE_UUID = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
const CHAR_TELEMETRY_UUID = 'beb5483e-36e1-4688-b7f5-ea07361b26a8';

let bleManager = null;
let readPollTimer = null;
let activeDevice = null;

function decodeBase64(b64) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  let str = '';
  let i = 0;
  const clean = (b64 || '').replace(/[^A-Za-z0-9+/=]/g, '');
  while (i < clean.length) {
    const enc1 = chars.indexOf(clean.charAt(i++));
    const enc2 = chars.indexOf(clean.charAt(i++));
    const enc3 = chars.indexOf(clean.charAt(i++));
    const enc4 = chars.indexOf(clean.charAt(i++));
    const chr1 = (enc1 << 2) | (enc2 >> 4);
    const chr2 = ((enc2 & 15) << 4) | (enc3 >> 2);
    const chr3 = ((enc3 & 3) << 6) | enc4;
    str += String.fromCharCode(chr1);
    if (enc3 !== 64) str += String.fromCharCode(chr2);
    if (enc4 !== 64) str += String.fromCharCode(chr3);
  }
  return str;
}

function parseWatchPayload(base64Value) {
  if (!base64Value) return null;
  const raw = decodeBase64(base64Value).trim();
  // Clean any trailing null bytes
  const cleaned = raw.replace(/\0/g, '').trim();

  // 1. Standard JSON payload from CarePulse Watch
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
    } catch (e) {}
  }

  // 2. Fallback partial regex extraction if MTU was capped on an older phone
  const hrMatch = cleaned.match(/"heart_rate"\s*:\s*([0-9.]+)/);
  const spo2Match = cleaned.match(/"spo2"\s*:\s*([0-9.]+)/);
  const tempMatch = cleaned.match(/"temperature"\s*:\s*([0-9.]+)/);
  const fingerMatch = cleaned.match(/"finger"\s*:\s*(true|false)/);
  if (hrMatch || spo2Match || tempMatch) {
    return {
      heart_rate: hrMatch ? Number(hrMatch[1]) : 0,
      spo2: spo2Match ? Number(spo2Match[1]) : 0,
      temperature: tempMatch ? Number(tempMatch[1]) : 0,
      finger: fingerMatch ? fingerMatch[1] === 'true' : true
    };
  }

  return null;
}

export async function requestBlePermissions() {
  if (Platform.OS !== 'android') return true;
  if (Platform.Version >= 31) {
    const result = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
    ]);
    return (
      result['android.permission.BLUETOOTH_CONNECT'] === PermissionsAndroid.RESULTS.GRANTED &&
      result['android.permission.BLUETOOTH_SCAN'] === PermissionsAndroid.RESULTS.GRANTED
    );
  } else {
    const granted = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
    );
    return granted === PermissionsAndroid.RESULTS.GRANTED;
  }
}

export async function connectToCarePulseWatch({ onConnected, onTelemetry, onDisconnected, onError }) {
  try {
    const hasPerm = await requestBlePermissions();
    if (!hasPerm) {
      onError && onError('Bluetooth permissions were denied.');
      return;
    }

    const { BleManager } = require('react-native-ble-plx');
    if (!bleManager) {
      bleManager = new BleManager();
    }

    if (readPollTimer) {
      clearInterval(readPollTimer);
      readPollTimer = null;
    }

    bleManager.stopDeviceScan();

    bleManager.startDeviceScan(null, { allowDuplicates: false }, async (error, device) => {
      if (error) {
        onError && onError(error.message || 'BLE scan error');
        return;
      }

      const name = device?.name || device?.localName || '';
      if (name.includes('CarePulse')) {
        bleManager.stopDeviceScan();
        try {
          const connectedDevice = await device.connect({ autoConnect: false });
          activeDevice = connectedDevice;

          // Request 256-byte MTU so the full 120-byte JSON telemetry packet is never truncated at 20 bytes
          try {
            await connectedDevice.requestMTU(256);
          } catch (mtuErr) {}

          await connectedDevice.discoverAllServicesAndCharacteristics();
          onConnected && onConnected(name);

          let lastNotifyTime = 0;

          connectedDevice.onDisconnected(() => {
            if (readPollTimer) {
              clearInterval(readPollTimer);
              readPollTimer = null;
            }
            activeDevice = null;
            onDisconnected && onDisconnected();
          });

          // 1. Live BLE Notification Stream
          connectedDevice.monitorCharacteristicForService(
            SERVICE_UUID,
            CHAR_TELEMETRY_UUID,
            (err, characteristic) => {
              if (err || !characteristic?.value) return;
              const data = parseWatchPayload(characteristic.value);
              if (data) {
                lastNotifyTime = Date.now();
                onTelemetry && onTelemetry(data);
              }
            }
          );

          // 2. Active GATT Characteristic Read Fallback (uses ATT Read Blob so works even if MTU is 23)
          readPollTimer = setInterval(async () => {
            if (!activeDevice) return;
            // If notifications are already arriving every second, skip redundant read
            if (Date.now() - lastNotifyTime < 1100) return;
            try {
              const char = await activeDevice.readCharacteristicForService(
                SERVICE_UUID,
                CHAR_TELEMETRY_UUID
              );
              if (char?.value) {
                const data = parseWatchPayload(char.value);
                if (data) {
                  onTelemetry && onTelemetry(data);
                }
              }
            } catch (readErr) {}
          }, 1200);
        } catch (connErr) {
          onError && onError(connErr.message || 'Failed to connect to watch');
        }
      }
    });
  } catch (e) {
    onError &&
      onError(
        'Native Bluetooth requires the installed APK build.'
      );
  }
}
