import { Platform, PermissionsAndroid } from 'react-native';

const SERVICE_UUID = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
const CHAR_TELEMETRY_UUID = 'beb5483e-36e1-4688-b7f5-ea07361b26a8';

let bleManager = null;

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

    // Dynamically instantiate BleManager from react-native-ble-plx (works in EAS APK build)
    const { BleManager } = require('react-native-ble-plx');
    if (!bleManager) {
      bleManager = new BleManager();
    }

    bleManager.startDeviceScan(null, { allowDuplicates: false }, async (error, device) => {
      if (error) {
        onError && onError(error.message || 'BLE scan error');
        return;
      }

      const name = device?.name || device?.localName || '';
      if (name.includes('CarePulse')) {
        bleManager.stopDeviceScan();
        try {
          const connectedDevice = await device.connect();
          await connectedDevice.discoverAllServicesAndCharacteristics();
          onConnected && onConnected(name);

          connectedDevice.onDisconnected(() => {
            onDisconnected && onDisconnected();
          });

          connectedDevice.monitorCharacteristicForService(
            SERVICE_UUID,
            CHAR_TELEMETRY_UUID,
            (err, characteristic) => {
              if (err || !characteristic?.value) return;
              const rawJson = decodeBase64(characteristic.value).trim();
              if (rawJson.startsWith('{') && rawJson.endsWith('}')) {
                try {
                  const data = JSON.parse(rawJson);
                  onTelemetry && onTelemetry(data);
                } catch (e) {}
              }
            }
          );
        } catch (connErr) {
          onError && onError(connErr.message || 'Failed to connect to watch');
        }
      }
    });
  } catch (e) {
    onError &&
      onError(
        'Native Bluetooth requires the EAS APK build (eas build -p android --profile preview). In Expo Go, Wi-Fi/Hotspot sync is active.'
      );
  }
}
