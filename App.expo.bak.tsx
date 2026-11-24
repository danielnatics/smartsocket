import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  SafeAreaView,
  StatusBar,
  ActivityIndicator,
  Animated,
  Dimensions,
  Modal,
  TextInput,
  Alert,
  Platform,
  Switch,
} from 'react-native';
// @ts-ignore
import Paho from 'paho-mqtt';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';

interface SocketItem {
  id: string; // Hardware Device ID (e.g., 'SOCKET-01', 'SOCKET-02')
  name: string; // User's custom nickname (e.g., 'Living Room Socket')
  relay: boolean;
  voltage: number | null;
  current: number | null;
  power: number | null;
  energy: number | null;
  temperature: number | null;
  uptime: number;
  wifi: number;
  gridStatus: 'LIGHT_OK' | 'NO_LIGHT';
  lastSeenTimestamp: number;
  outageStartTime?: number | null;
  isOnline: boolean;
  voltageGuard?: 'NORMAL' | 'SURGE' | 'BROWNOUT' | 'RECOVERING';
  recoveryCountdown?: number;
  timerActive?: boolean;
  timerRemaining?: number;
  voltageGuardEnabled?: boolean;
  startupDelaySeconds?: number;
  highTemperatureAlarm?: boolean;
}

interface DiscoveredSocket {
  id: string;
  voltage: number | null;
  relay: boolean;
  power: number | null;
  wifi: number;
  lastSeen: number;
}

const MQTT_CONFIG = {
  host: 'broker.emqx.io',
  port: 8084, // WSS
  path: '/mqtt',
  topicWildcardTelemetry: 'build_nigeria/sockets/+/status',
  topicLegacyTelemetry: 'build_nigeria/socket/telemetry',
};

const STORAGE_KEY = '@build_nigeria_smart_sockets_v4';
const HEARTBEAT_TIMEOUT_MS = 10000;

const parseTelemetryNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const formatMetric = (value: number | null | undefined, decimals: number): string =>
  typeof value === 'number' && Number.isFinite(value) ? value.toFixed(decimals) : 'N/A';

export default function App() {
  const [mqttStatus, setMqttStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
  const [mqttErrorMsg, setMqttErrorMsg] = useState<string | null>(null);

  // User's Linked Sockets (Initially empty until user searches & links)
  const [sockets, setSockets] = useState<SocketItem[]>([]);
  const [selectedSocketId, setSelectedSocketId] = useState<string | null>(null);

  // Available Sockets heard on the cloud/network (for Discovery search)
  const [discoveredDevices, setDiscoveredDevices] = useState<DiscoveredSocket[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  // Modals
  const [isSearchModalVisible, setIsSearchModalVisible] = useState(false);
  const [isRenameModalVisible, setIsRenameModalVisible] = useState(false);
  const [manualSocketId, setManualSocketId] = useState('');
  const [manualSocketName, setManualSocketName] = useState('');
  const [renameText, setRenameText] = useState('');
  const [customTimerMinutes, setCustomTimerMinutes] = useState('30');
  const [showSocketSettings, setShowSocketSettings] = useState(false);
  const [startupDelayInput, setStartupDelayInput] = useState('10');

  const clientRef = useRef<any>(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const radarAnim = useRef(new Animated.Value(0)).current;
  const pendingCommandsRef = useRef<Record<string, { targetRelay: boolean; expiresAt: number }>>({});
  const lastCommandTimeRef = useRef<Record<string, number>>({});
  const temperatureAlarmStateRef = useRef<Record<string, boolean>>({});

  // Selected socket object
  const activeSocket = sockets.find((s) => s.id.toUpperCase() === selectedSocketId?.toUpperCase()) || null;

  useEffect(() => {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });

    Notifications.requestPermissionsAsync().catch((error) => {
      console.warn('Notification permission request failed:', error);
    });
  }, []);

  useEffect(() => {
    if (activeSocket?.startupDelaySeconds !== undefined) {
      setStartupDelayInput(String(activeSocket.startupDelaySeconds));
    }
  }, [activeSocket?.id, activeSocket?.startupDelaySeconds]);

  // Load saved sockets from AsyncStorage
  useEffect(() => {
    (async () => {
      try {
        const saved = await AsyncStorage.getItem(STORAGE_KEY);
        if (saved) {
          const parsed: SocketItem[] = JSON.parse(saved);
          if (Array.isArray(parsed)) {
            setSockets(parsed);
          }
        }
      } catch (e) {
        console.error('Failed to load saved sockets:', e);
      }
    })();
  }, []);

  // Save sockets to AsyncStorage
  const persistSockets = async (updated: SocketItem[]) => {
    setSockets(updated);
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    } catch (e) {
      console.error('Failed to save sockets:', e);
    }
  };

  // Heartbeat Watchdog for Linked Sockets (detects outage if no ping for 10s)
  useEffect(() => {
    const watchdogInterval = setInterval(() => {
      const now = Date.now();
      setSockets((prev) =>
        prev.map((sock) => {
          const timeSinceLastPing = now - (sock.lastSeenTimestamp || 0);
          if (timeSinceLastPing > HEARTBEAT_TIMEOUT_MS && sock.gridStatus !== 'NO_LIGHT') {
            return {
              ...sock,
              gridStatus: 'NO_LIGHT',
              isOnline: false,
              voltage: null,
              current: null,
              power: null,
              energy: null,
              outageStartTime: sock.outageStartTime || now,
            };
          }
          return sock;
        })
      );
    }, 2500);

    return () => clearInterval(watchdogInterval);
  }, []);

  // Pulse animation for active socket
  useEffect(() => {
    if (activeSocket?.relay && activeSocket.gridStatus === 'LIGHT_OK') {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.05, duration: 800, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 800, useNativeDriver: true }),
        ])
      ).start();
    } else {
      pulseAnim.setValue(1);
    }
  }, [activeSocket?.relay, activeSocket?.gridStatus]);

  // Connect to MQTT
  const connectMQTT = () => {
    try {
      setMqttStatus('connecting');
      setMqttErrorMsg(null);

      const clientId = `SmartSocketApp-${Math.random().toString(16).substring(2, 10)}`;
      const client = new Paho.Client(MQTT_CONFIG.host, MQTT_CONFIG.port, MQTT_CONFIG.path, clientId);

      client.onConnectionLost = (responseObject: any) => {
        setMqttStatus('disconnected');
        setMqttErrorMsg(responseObject.errorMessage || 'Connection lost');
      };

      client.onMessageArrived = (message: any) => {
        try {
          const topic = message.destinationName;
          const payload = JSON.parse(message.payloadString);
          const rawId = payload.deviceId || (topic.includes('/') ? topic.split('/')[2] : 'SOCKET-01');
          const deviceId = (rawId || 'SOCKET-01').toUpperCase();
          const now = Date.now();
          const highTemperatureAlarm = payload.highTemperatureAlarm === true;
          const previousTemperatureAlarm =
            temperatureAlarmStateRef.current[deviceId] === true;

          if (highTemperatureAlarm && !previousTemperatureAlarm) {
            Notifications.scheduleNotificationAsync({
              content: {
                title: 'High temperature warning',
                body: `${deviceId} is above 50°C. Check the socket and appliance.`,
                sound: 'default',
              },
              trigger: null,
            }).catch((error) => {
              console.warn('High temperature notification failed:', error);
            });
          }
          temperatureAlarmStateRef.current[deviceId] = highTemperatureAlarm;

          const isOutage = payload.gridStatus === 'NO_LIGHT' || payload.isOnline === false;

          // 1. UPDATE DISCOVERED DEVICES POOL (Available for linking in Search)
          setDiscoveredDevices((prev) => {
            const idx = prev.findIndex((d) => d.id === deviceId);
            const devData: DiscoveredSocket = {
              id: deviceId,
              voltage: isOutage ? null : parseTelemetryNumber(payload.voltage),
              relay: Boolean(payload.relay),
              power: isOutage ? null : parseTelemetryNumber(payload.power),
              wifi: payload.wifi || -60,
              lastSeen: now,
            };
            if (idx !== -1) {
              const copy = [...prev];
              copy[idx] = devData;
              return copy;
            } else {
              return [...prev, devData];
            }
          });

          // 2. ONLY UPDATE IF THE SOCKET IS ALREADY LINKED BY THE USER!
          // (This prevents deleted sockets from mysteriously popping back up!)
          setSockets((prev) => {
            const index = prev.findIndex((s) => s.id.toUpperCase() === deviceId);
            if (index === -1) {
              // Not linked by user: ignore for home screen
              return prev;
            }

            const reportedRelay = Boolean(payload.relay);
            const reportedPower = parseTelemetryNumber(payload.power);
            const pending = pendingCommandsRef.current[deviceId];
            let effectiveRelay = isOutage ? false : reportedRelay;

            if (!isOutage && pending) {
              if (reportedRelay === pending.targetRelay) {
                // ESP32 hardware acknowledged and matched the commanded state! Release lock.
                delete pendingCommandsRef.current[deviceId];
                effectiveRelay = reportedRelay;
              } else if (Date.now() < pending.expiresAt) {
                // In-flight telemetry packet was sent before ESP32 processed the new command.
                // Hold optimistic state to eliminate the flicker (no ON->OFF->ON)!
                effectiveRelay = pending.targetRelay;
              } else {
                delete pendingCommandsRef.current[deviceId];
              }
            }

            const updated = [...prev];
            updated[index] = {
              ...updated[index],
              gridStatus: isOutage ? 'NO_LIGHT' : 'LIGHT_OK',
              isOnline: !isOutage,
              outageStartTime: isOutage ? (updated[index].outageStartTime || now) : null,
              relay: effectiveRelay,
              voltage: isOutage ? null : parseTelemetryNumber(payload.voltage),
              current: isOutage ? null : parseTelemetryNumber(payload.current),
              power: isOutage || reportedPower === null ? null : Math.max(0, reportedPower),
              energy: isOutage ? null : parseTelemetryNumber(payload.energy),
              temperature: isOutage ? null : parseTelemetryNumber(payload.temperatureC),
              uptime: payload.uptime || updated[index].uptime,
              wifi: payload.wifi || updated[index].wifi,
              lastSeenTimestamp: isOutage ? updated[index].lastSeenTimestamp : now,
              voltageGuard: payload.voltageGuard || 'NORMAL',
              recoveryCountdown: payload.recoveryCountdown !== undefined ? payload.recoveryCountdown : 0,
              timerActive: Boolean(payload.timerActive),
              timerRemaining: payload.timerRemaining !== undefined ? payload.timerRemaining : 0,
              voltageGuardEnabled:
                payload.voltageGuardEnabled !== undefined
                  ? Boolean(payload.voltageGuardEnabled)
                  : updated[index].voltageGuardEnabled,
              startupDelaySeconds:
                payload.startupDelaySeconds !== undefined
                  ? Number(payload.startupDelaySeconds)
                  : updated[index].startupDelaySeconds,
              highTemperatureAlarm,
            };
            return updated;
          });
        } catch (e) {
          console.warn('Error parsing telemetry:', e);
        }
      };

      client.connect({
        useSSL: true,
        timeout: 10,
        keepAliveInterval: 30,
        cleanSession: true,
        onSuccess: () => {
          setMqttStatus('connected');
          setMqttErrorMsg(null);
          // Subscribe only to wildcard status topic (avoids duplicate packet arrival)
          client.subscribe(MQTT_CONFIG.topicWildcardTelemetry, { qos: 0 });
        },
        onFailure: (err: any) => {
          setMqttStatus('error');
          setMqttErrorMsg(err.errorMessage || 'EMQX cloud unreachable');
        },
      });

      clientRef.current = client;
    } catch (e: any) {
      setMqttStatus('error');
      setMqttErrorMsg(e?.message || 'MQTT init failed');
    }
  };

  useEffect(() => {
    connectMQTT();
    return () => {
      if (clientRef.current && clientRef.current.isConnected()) {
        clientRef.current.disconnect();
      }
    };
  }, []);

  // Trigger discovery search animation
  const startSearching = () => {
    setIsSearching(true);
    setIsSearchModalVisible(true);
    Animated.loop(
      Animated.sequence([
        Animated.timing(radarAnim, { toValue: 1, duration: 1200, useNativeDriver: true }),
        Animated.timing(radarAnim, { toValue: 0, duration: 0, useNativeDriver: true }),
      ])
    ).start();

    // Re-check MQTT
    if (!clientRef.current || !clientRef.current.isConnected()) {
      connectMQTT();
    }
  };

  // Link a discovered socket to the user's dashboard
  const handleLinkDiscoveredSocket = (dev: DiscoveredSocket, customNickname?: string) => {
    if (sockets.some((s) => s.id.toUpperCase() === dev.id.toUpperCase())) {
      Alert.alert('Already Linked', `${dev.id} is already on your home dashboard.`);
      return;
    }

    const newLinked: SocketItem = {
      id: dev.id,
      name: customNickname || `Smart Socket ${dev.id}`,
      relay: dev.relay,
      voltage: dev.voltage,
      current: null,
      power: dev.power,
      energy: null,
      temperature: null,
      uptime: 0,
      wifi: dev.wifi,
      gridStatus: dev.voltage !== null && dev.voltage > 50 ? 'LIGHT_OK' : 'NO_LIGHT',
      lastSeenTimestamp: Date.now(),
      outageStartTime: null,
      isOnline: true,
    };

    const updatedList = [...sockets, newLinked];
    persistSockets(updatedList);
    setIsSearchModalVisible(false);
    Alert.alert('Socket Linked! 🔌', `${newLinked.name} (${dev.id}) has been added to your dashboard.`);
  };

  // Link manually by entering ID
  const handleManualLink = () => {
    const trimmedId = manualSocketId.trim().toUpperCase();
    const trimmedName = manualSocketName.trim() || `Smart Socket ${trimmedId}`;

    if (!trimmedId) {
      Alert.alert('Required', 'Please enter the Device ID shown on the OLED (e.g. SOCKET-01).');
      return;
    }

    if (sockets.some((s) => s.id.toUpperCase() === trimmedId)) {
      Alert.alert('Already Linked', 'This socket is already on your dashboard.');
      return;
    }

    const newSocket: SocketItem = {
      id: trimmedId,
      name: trimmedName,
      relay: false,
      voltage: null,
      current: null,
      power: null,
      energy: null,
      temperature: null,
      uptime: 0,
      wifi: -60,
      gridStatus: 'LIGHT_OK',
      lastSeenTimestamp: Date.now(),
      outageStartTime: null,
      isOnline: true,
    };

    persistSockets([...sockets, newSocket]);
    setManualSocketId('');
    setManualSocketName('');
    setIsSearchModalVisible(false);
  };

  // Delete / Unlink Socket (Permanently removes it from dashboard)
  const handleDeleteSocket = (idToDelete: string) => {
    Alert.alert(
      'Remove Socket',
      `Are you sure you want to remove ${idToDelete} from your app?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            const updated = sockets.filter((s) => s.id.toUpperCase() !== idToDelete.toUpperCase());
            persistSockets(updated);
            setSelectedSocketId(null);
          },
        },
      ]
    );
  };

  // Rename Socket
  const handleRenameSocket = () => {
    if (!renameText.trim() || !selectedSocketId) return;
    const updated = sockets.map((s) =>
      s.id.toUpperCase() === selectedSocketId.toUpperCase() ? { ...s, name: renameText.trim() } : s
    );
    persistSockets(updated);
    setIsRenameModalVisible(false);
  };

  // Send Command to a specific socket
  const sendSocketCommand = (targetSocketId: string, desiredState: boolean) => {
    const sId = targetSocketId.toUpperCase();
    const now = Date.now();

    // Prevent rapid double-tap stutter (debounce 350ms)
    if (now - (lastCommandTimeRef.current[sId] || 0) < 350) {
      return;
    }
    lastCommandTimeRef.current[sId] = now;

    const targetSocket = sockets.find((s) => s.id.toUpperCase() === sId);
    if (targetSocket?.gridStatus === 'NO_LIGHT') {
      Alert.alert('Power Outage', 'Cannot switch socket: There is currently NO LIGHT (0V AC).');
      return;
    }

    if (!clientRef.current || !clientRef.current.isConnected()) {
      Alert.alert('Connecting', 'Connecting to cloud broker. Please retry in a moment...');
      connectMQTT();
      return;
    }

    // Set command guard lock for 2.5s to prevent stale in-flight telemetry from reverting UI
    pendingCommandsRef.current[sId] = {
      targetRelay: desiredState,
      expiresAt: now + 2500,
    };

    const payload = JSON.stringify({ relay: desiredState, deviceId: targetSocketId });

    // Send single targeted command to this specific socket
    const topic = `build_nigeria/sockets/${targetSocketId}/command`;
    const message = new Paho.Message(payload);
    message.destinationName = topic;
    message.qos = 0;
    clientRef.current.send(message);

    // Optimistic UI update
    setSockets((prev) =>
      prev.map((s) => {
        if (s.id.toUpperCase() === sId) {
          return {
            ...s,
            relay: desiredState,
          };
        }
        return s;
      })
    );
  };

  // Feature 3: Smart Countdown Timer
  const sendSocketTimer = (targetSocketId: string, seconds: number) => {
    if (!clientRef.current || !clientRef.current.isConnected()) {
      Alert.alert('Connecting', 'Connecting to cloud broker. Please retry in a moment...');
      connectMQTT();
      return;
    }
    const payload = JSON.stringify({ timerSeconds: seconds, deviceId: targetSocketId });
    const topic = `build_nigeria/sockets/${targetSocketId}/command`;
    const message = new Paho.Message(payload);
    message.destinationName = topic;
    message.qos = 0;
    clientRef.current.send(message);

    // Optimistic timer state
    setSockets((prev) =>
      prev.map((s) =>
        s.id.toUpperCase() === targetSocketId.toUpperCase()
          ? { ...s, relay: true, timerActive: true, timerRemaining: seconds }
          : s
      )
    );
  };

  const cancelSocketTimer = (targetSocketId: string) => {
    if (!clientRef.current || !clientRef.current.isConnected()) return;
    const payload = JSON.stringify({ cancelTimer: true, deviceId: targetSocketId });
    const topic = `build_nigeria/sockets/${targetSocketId}/command`;
    const message = new Paho.Message(payload);
    message.destinationName = topic;
    message.qos = 0;
    clientRef.current.send(message);

    setSockets((prev) =>
      prev.map((s) =>
        s.id.toUpperCase() === targetSocketId.toUpperCase()
          ? { ...s, timerActive: false, timerRemaining: 0 }
          : s
      )
    );
  };

  const updateSocketSettings = (
    targetSocketId: string,
    settings: { voltageGuardEnabled?: boolean; startupDelaySeconds?: number }
  ) => {
    if (!clientRef.current || !clientRef.current.isConnected()) {
      Alert.alert('Connecting', 'Connecting to cloud broker. Please retry in a moment...');
      connectMQTT();
      return;
    }

    const topic = `build_nigeria/sockets/${targetSocketId}/command`;
    const message = new Paho.Message(
      JSON.stringify({ ...settings, deviceId: targetSocketId })
    );
    message.destinationName = topic;
    message.qos = 0;
    clientRef.current.send(message);

    setSockets((prev) =>
      prev.map((socket) =>
        socket.id.toUpperCase() === targetSocketId.toUpperCase()
          ? {
              ...socket,
              ...(settings.voltageGuardEnabled !== undefined
                ? { voltageGuardEnabled: settings.voltageGuardEnabled }
                : {}),
              ...(settings.startupDelaySeconds !== undefined
                ? { startupDelaySeconds: settings.startupDelaySeconds }
                : {}),
            }
          : socket
      )
    );
  };

  const formatTimerDuration = (seconds?: number) => {
    if (!seconds || seconds <= 0) return '00:00';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs < 10 ? '0' : ''}${secs}s`;
  };

  const formatUptime = (secs: number) => {
    const mins = Math.floor(secs / 60);
    const s = secs % 60;
    return `${mins}m ${s}s`;
  };

  const getOutageDurationText = (startTime?: number | null) => {
    if (!startTime) return 'Recent';
    const elapsedSecs = Math.floor((Date.now() - startTime) / 1000);
    if (elapsedSecs < 60) return `${elapsedSecs}s ago`;
    const elapsedMins = Math.floor(elapsedSecs / 60);
    return `${elapsedMins}m ago`;
  };

  // Unlinked discovered devices available to be added
  const availableToLink = discoveredDevices.filter(
    (dev) => !sockets.some((s) => s.id.toUpperCase() === dev.id.toUpperCase())
  );

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor="#0B0F19" />

      {/* Top App Bar with safe margin for Android status bar */}
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.appTitle}>Build Nigeria 🇳🇬</Text>
          <Text style={styles.appSubtitle}>Smart Energy Sockets</Text>
        </View>

        <TouchableOpacity
          onPress={connectMQTT}
          style={[
            styles.connectionBadge,
            mqttStatus === 'connected' ? styles.badgeOnline : styles.badgeOffline,
          ]}
        >
          {mqttStatus === 'connecting' ? (
            <ActivityIndicator size="small" color="#fff" style={{ marginRight: 6 }} />
          ) : (
            <View
              style={[
                styles.statusDot,
                { backgroundColor: mqttStatus === 'connected' ? '#10B981' : '#EF4444' },
              ]}
            />
          )}
          <Text style={styles.statusBadgeText}>
            {mqttStatus === 'connected' ? 'CLOUD' : 'RECONNECT'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Cloud Status Notice */}
      {mqttStatus !== 'connected' && (
        <TouchableOpacity onPress={connectMQTT} style={styles.cloudNoticeBar}>
          <Text style={styles.cloudNoticeText}>
            {mqttStatus === 'connecting'
              ? '⏳ Connecting to cloud...'
              : `⚠️ Cloud offline (${mqttErrorMsg || 'Tap to reconnect'})`}
          </Text>
        </TouchableOpacity>
      )}

      {/* ======================================================== */}
      {/* SCREEN 1: ALL SOCKETS LIST (When no socket is selected)  */}
      {/* ======================================================== */}
      {!selectedSocketId && (
        <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
          {/* Header Action Row */}
          <View style={styles.sectionTitleRow}>
            <Text style={styles.sectionHeader}>MY LINKED SOCKETS ({sockets.length})</Text>
            <TouchableOpacity onPress={startSearching} style={styles.searchButton}>
              <Text style={styles.searchButtonText}>🔍 Find Sockets</Text>
            </TouchableOpacity>
          </View>

          {/* Empty State: Initial state when user has no sockets */}
          {sockets.length === 0 ? (
            <View style={styles.emptyStateCard}>
              <Text style={styles.emptyStateIcon}>🔌</Text>
              <Text style={styles.emptyStateTitle}>No Sockets Linked Yet</Text>
              <Text style={styles.emptyStateDesc}>
                Plug in your Smart Socket. Tap the button below to search for available sockets on your network.
              </Text>
              <TouchableOpacity onPress={startSearching} style={styles.primaryActionButton}>
                <Text style={styles.primaryActionText}>🔍 Search for Available Sockets</Text>
              </TouchableOpacity>
            </View>
          ) : (
            sockets.map((sock) => {
              const hasLight = sock.gridStatus === 'LIGHT_OK';

              return (
                <TouchableOpacity
                  key={sock.id}
                  activeOpacity={0.85}
                  onPress={() => setSelectedSocketId(sock.id)}
                  style={[
                    styles.socketCard,
                    hasLight && sock.relay && styles.socketCardActive,
                    !hasLight && styles.socketCardOutage,
                  ]}
                >
                  <View style={styles.socketCardTop}>
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                        <View style={styles.socketIdBadge}>
                          <Text style={styles.socketIdText}>{sock.id}</Text>
                        </View>

                        <View
                          style={[
                            styles.gridStatusPill,
                            hasLight ? styles.pillLightOk : styles.pillNoLight,
                          ]}
                        >
                          <Text
                            style={[
                              styles.gridStatusText,
                              hasLight ? { color: '#10B981' } : { color: '#EF4444' },
                            ]}
                          >
                            {hasLight
                              ? `⚡ ${formatMetric(sock.voltage, 0)}V LIGHT ON`
                              : `⚠️ NO LIGHT (${getOutageDurationText(sock.outageStartTime)})`}
                          </Text>
                        </View>

                        {/* Voltage Guard Mini Badge */}
                        {sock.voltageGuard && sock.voltageGuard !== 'NORMAL' && (
                          <View
                            style={[
                              styles.guardMiniBadge,
                              sock.voltageGuard === 'SURGE'
                                ? { backgroundColor: 'rgba(239, 68, 68, 0.2)', borderColor: '#EF4444' }
                                : sock.voltageGuard === 'BROWNOUT'
                                ? { backgroundColor: 'rgba(249, 115, 22, 0.2)', borderColor: '#F97316' }
                                : { backgroundColor: 'rgba(234, 179, 8, 0.2)', borderColor: '#EAB308' },
                            ]}
                          >
                            <Text
                              style={[
                                styles.guardMiniBadgeText,
                                sock.voltageGuard === 'SURGE'
                                  ? { color: '#EF4444' }
                                  : sock.voltageGuard === 'BROWNOUT'
                                  ? { color: '#F97316' }
                                  : { color: '#EAB308' },
                              ]}
                            >
                              {sock.voltageGuard === 'SURGE'
                                ? '🚨 SURGE'
                                : sock.voltageGuard === 'BROWNOUT'
                                ? '⚠️ BROWNOUT'
                                : `⏳ WAIT ${sock.recoveryCountdown || 0}s`}
                            </Text>
                          </View>
                        )}

                        {/* Active Countdown Timer Badge */}
                        {sock.timerActive && (sock.timerRemaining || 0) > 0 && (
                          <View style={styles.timerMiniBadge}>
                            <Text style={styles.timerMiniBadgeText}>
                              ⏱️ {Math.ceil((sock.timerRemaining || 0) / 60)}m left
                            </Text>
                          </View>
                        )}
                      </View>

                      <Text style={styles.socketCardName}>{sock.name}</Text>
                    </View>

                    {/* Quick Switch directly on card */}
                    <TouchableOpacity
                      disabled={!hasLight}
                      onPress={() => sendSocketCommand(sock.id, !sock.relay)}
                      style={[
                        styles.quickSwitch,
                        hasLight && sock.relay && styles.quickSwitchOn,
                        hasLight && !sock.relay && styles.quickSwitchOff,
                        !hasLight && styles.quickSwitchDisabled,
                      ]}
                    >
                      <Text style={styles.quickSwitchText}>
                        {!hasLight ? 'DEAD' : sock.relay ? 'ON' : 'OFF'}
                      </Text>
                    </TouchableOpacity>
                  </View>

                  {/* Metrics preview row */}
                  <View style={styles.socketCardMetrics}>
                    <View style={styles.metricMini}>
                      <Text style={styles.metricMiniLabel}>GRID</Text>
                      <Text style={[styles.metricMiniValue, !hasLight && { color: '#EF4444' }]}>
                        {hasLight ? `${formatMetric(sock.voltage, 0)} V` : 'N/A'}
                      </Text>
                    </View>
                    <View style={styles.metricMini}>
                      <Text style={styles.metricMiniLabel}>POWER</Text>
                      <Text style={[styles.metricMiniValue, hasLight && sock.relay && { color: '#F59E0B' }]}>
                        {hasLight ? `${formatMetric(Math.max(0, sock.power ?? 0), 0)} W` : '0 W'}
                      </Text>
                    </View>
                    <View style={styles.metricMini}>
                      <Text style={styles.metricMiniLabel}>ENERGY</Text>
                      <Text style={[styles.metricMiniValue, { color: '#10B981' }]}>
                        {formatMetric(sock.energy ?? 0, 3)} kWh
                      </Text>
                    </View>
                    <View style={styles.metricMini}>
                      <Text style={styles.metricMiniLabel}>TEMP</Text>
                      <Text style={[styles.metricMiniValue, { color: '#F97316' }]}>
                        {formatMetric(sock.temperature, 1)} °C
                      </Text>
                    </View>
                  </View>

                  <View style={styles.cardFooterHint}>
                    <Text style={styles.cardFooterText}>Tap to open full controls & settings →</Text>
                  </View>
                </TouchableOpacity>
              );
            })
          )}
        </ScrollView>
      )}

      {/* ======================================================== */}
      {/* SCREEN 2: DETAILED SOCKET CONTROL (When socket selected) */}
      {/* ======================================================== */}
      {selectedSocketId && activeSocket && (
        <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
          {/* Back button & Socket Actions */}
          <View style={styles.detailNavRow}>
            <TouchableOpacity onPress={() => setSelectedSocketId(null)} style={styles.backButton}>
              <Text style={styles.backButtonText}>← All Sockets</Text>
            </TouchableOpacity>

            <View style={styles.detailActionsRow}>
              <TouchableOpacity
                onPress={() => {
                  setRenameText(activeSocket.name);
                  setIsRenameModalVisible(true);
                }}
                style={styles.actionChip}
              >
                <Text style={styles.actionChipText}>✏️ Rename</Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => handleDeleteSocket(activeSocket.id)}
                style={[styles.actionChip, { borderColor: '#EF4444' }]}
              >
                <Text style={[styles.actionChipText, { color: '#EF4444' }]}>🗑️ Remove</Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Grid Status Banner */}
          <View
            style={[
              styles.outageBanner,
              activeSocket.gridStatus === 'LIGHT_OK'
                ? styles.outageBannerLightOk
                : styles.outageBannerNoLight,
            ]}
          >
            <Text style={styles.outageBannerIcon}>
              {activeSocket.gridStatus === 'LIGHT_OK' ? '💡' : '⚡'}
            </Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.outageBannerTitle}>
                {activeSocket.gridStatus === 'LIGHT_OK'
                  ? 'MAINS POWER AVAILABLE'
                  : 'POWER OUTAGE: NO LIGHT'}
              </Text>
              <Text style={styles.outageBannerSub}>
                {activeSocket.gridStatus === 'LIGHT_OK'
                  ? 'Measured voltage received from the socket'
                  : `No mains telemetry (${getOutageDurationText(activeSocket.outageStartTime)})`}
              </Text>
            </View>
          </View>

          {/* Master Power Hero Section */}
          <View style={styles.heroCard}>
            <View style={styles.heroHeaderRow}>
              <Text style={styles.heroSocketName}>{activeSocket.name}</Text>
              <View style={styles.heroIdBadge}>
                <Text style={styles.heroIdText}>{activeSocket.id}</Text>
              </View>
            </View>

            <Animated.View style={{ transform: [{ scale: pulseAnim }], marginVertical: 20 }}>
              <TouchableOpacity
                activeOpacity={0.8}
                disabled={activeSocket.gridStatus === 'NO_LIGHT'}
                onPress={() => sendSocketCommand(activeSocket.id, !activeSocket.relay)}
                style={[
                  styles.powerButtonCircle,
                  activeSocket.gridStatus === 'NO_LIGHT'
                    ? styles.powerCircleDisabled
                    : activeSocket.relay
                    ? styles.powerCircleActive
                    : styles.powerCircleInactive,
                ]}
              >
                <View style={styles.powerIcon}>
                  <View style={styles.powerIconRing} />
                  <View style={styles.powerIconStem} />
                </View>
                <Text style={styles.powerButtonStateText}>
                  {activeSocket.gridStatus === 'NO_LIGHT'
                    ? 'NO POWER'
                    : activeSocket.relay
                    ? 'POWER ON'
                    : 'POWER OFF'}
                </Text>
              </TouchableOpacity>
            </Animated.View>

            <View style={styles.relayStatusRow}>
              <View
                style={[
                  styles.miniIndicator,
                  {
                    backgroundColor:
                      activeSocket.gridStatus === 'NO_LIGHT'
                        ? '#EF4444'
                        : activeSocket.relay
                        ? '#10B981'
                        : '#64748B',
                  },
                ]}
              />
              <Text style={styles.relayStatusText}>
                {activeSocket.gridStatus === 'NO_LIGHT'
                  ? 'Outage Detected • Socket Inactive'
                  : activeSocket.relay
                  ? 'Relay Active • AC Power Flowing'
                  : 'Relay Cut Off • Inactive'}
              </Text>
            </View>
          </View>

          <TouchableOpacity
            style={styles.settingsToggle}
            onPress={() => setShowSocketSettings((visible) => !visible)}
          >
            <Text style={styles.settingsToggleText}>
              ⚙️ Socket settings
            </Text>
            <Text style={styles.settingsToggleChevron}>
              {showSocketSettings ? '▲' : '▼'}
            </Text>
          </TouchableOpacity>

          {/* Electrical Metrics Grid */}
          <Text style={styles.sectionHeader}>LIVE ELECTRICAL TELEMETRY</Text>
          <View style={styles.gridContainer}>
            <View style={styles.metricCard}>
              <Text style={styles.metricCardLabel}>GRID VOLTAGE</Text>
              <Text
                style={[
                  styles.metricCardValue,
                  activeSocket.gridStatus === 'NO_LIGHT' && { color: '#EF4444' },
                ]}
              >
                {activeSocket.gridStatus === 'NO_LIGHT'
                  ? 'N/A'
                  : formatMetric(activeSocket.voltage, 0)}{' '}
                {activeSocket.voltage !== null && <Text style={styles.unitText}>V</Text>}
              </Text>
              <Text style={styles.metricCardFoot}>
                {activeSocket.gridStatus === 'NO_LIGHT' ? 'Outage Detected' : 'Measured AC RMS'}
              </Text>
            </View>

            <View style={styles.metricCard}>
              <Text style={styles.metricCardLabel}>REAL POWER</Text>
              <Text
                style={[
                  styles.metricCardValue,
                  {
                    color:
                      activeSocket.gridStatus === 'LIGHT_OK' && activeSocket.relay
                        ? '#F59E0B'
                        : '#94A3B8',
                  },
                ]}
              >
                {formatMetric(Math.max(0, activeSocket.power ?? 0), 1)}{' '}
                <Text style={styles.unitText}>W</Text>
              </Text>
              <Text style={styles.metricCardFoot}>Waveform average</Text>
            </View>

            <View style={styles.metricCard}>
              <Text style={styles.metricCardLabel}>LOAD CURRENT</Text>
              <Text
                style={[
                  styles.metricCardValue,
                  {
                    color:
                      activeSocket.gridStatus === 'LIGHT_OK' && activeSocket.relay
                        ? '#38BDF8'
                        : '#94A3B8',
                  },
                ]}
              >
                {formatMetric(activeSocket.current ?? 0, 2)}{' '}
                <Text style={styles.unitText}>A</Text>
              </Text>
              <Text style={styles.metricCardFoot}>Measured RMS current</Text>
            </View>

            <View style={styles.metricCard}>
              <Text style={styles.metricCardLabel}>TOTAL ENERGY</Text>
              <Text style={[styles.metricCardValue, { color: '#10B981' }]}>
                {formatMetric(activeSocket.energy ?? 0, 3)}
                <Text style={styles.unitText}> kWh</Text>
              </Text>
              <Text style={styles.metricCardFoot}>Accumulated real energy</Text>
            </View>

            <View style={styles.metricCard}>
              <Text style={styles.metricCardLabel}>TEMPERATURE</Text>
              <Text style={[styles.metricCardValue, { color: '#F97316' }]}>
                {formatMetric(activeSocket.temperature, 1)}
                <Text style={styles.unitText}> °C</Text>
              </Text>
              <Text style={styles.metricCardFoot}>DS18B20 sensor</Text>
            </View>
          </View>

          {showSocketSettings && (
            <>
          <View style={styles.settingsCard}>
            <Text style={styles.settingsTitle}>Protection and startup</Text>
            <View style={styles.settingRow}>
              <View style={styles.settingTextBlock}>
                <Text style={styles.settingLabel}>Appliance voltage guard</Text>
                <Text style={styles.settingHelp}>Disconnects the relay during surge or low voltage.</Text>
              </View>
              <Switch
                value={activeSocket.voltageGuardEnabled !== false}
                onValueChange={(enabled) =>
                  updateSocketSettings(activeSocket.id, { voltageGuardEnabled: enabled })
                }
                trackColor={{ false: '#334155', true: '#2563EB' }}
                thumbColor="#FFFFFF"
              />
            </View>
            <View style={styles.settingRow}>
              <View style={styles.settingTextBlock}>
                <Text style={styles.settingLabel}>Startup delay</Text>
                <Text style={styles.settingHelp}>Wait before allowing the socket to turn on after power-up.</Text>
              </View>
              <View style={styles.delayInputRow}>
                <TextInput
                  style={styles.delayInput}
                  keyboardType="number-pad"
                  value={startupDelayInput}
                  onChangeText={setStartupDelayInput}
                  maxLength={4}
                />
                <Text style={styles.secondsLabel}>sec</Text>
              </View>
            </View>
            <TouchableOpacity
              style={styles.saveSettingsButton}
              onPress={() => {
                const seconds = Number.parseInt(startupDelayInput, 10);
                if (!Number.isInteger(seconds) || seconds < 0 || seconds > 3600) {
                  Alert.alert('Invalid delay', 'Enter a value between 0 and 3600 seconds.');
                  return;
                }
                updateSocketSettings(activeSocket.id, { startupDelaySeconds: seconds });
              }}
            >
              <Text style={styles.saveSettingsText}>Save startup delay</Text>
            </TouchableOpacity>
          </View>

          {/* Smart countdown is available under Settings instead of occupying
              the main socket screen. */}
          <View style={styles.featureCard}>
            <View style={styles.featureHeaderRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.featureTitle}>⏱️ Smart Countdown Off-Timer</Text>
                <Text style={styles.featureSub}>
                  Auto-cutoff for water pumping machines, chargers & heaters
                </Text>
              </View>
              {activeSocket.timerActive && (
                <View style={styles.activeTimerBadge}>
                  <Text style={styles.activeTimerBadgeText}>ACTIVE</Text>
                </View>
              )}
            </View>

            {activeSocket.timerActive ? (
              <View style={styles.runningTimerBox}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.runningTimerLabel}>AUTO-CUTOFF IN:</Text>
                  <Text style={styles.runningTimerClock}>
                    {formatTimerDuration(activeSocket.timerRemaining)}
                  </Text>
                  <Text style={styles.runningTimerSub}>
                    Socket will automatically switch OFF when timer reaches 00:00
                  </Text>
                </View>
                <TouchableOpacity
                  onPress={() => cancelSocketTimer(activeSocket.id)}
                  style={styles.cancelTimerBtn}
                >
                  <Text style={styles.cancelTimerBtnText}>Cancel</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View>
                <Text style={styles.presetLabel}>QUICK PRESETS:</Text>
                <View style={styles.timerPresetRow}>
                  <TouchableOpacity
                    onPress={() => sendSocketTimer(activeSocket.id, 15 * 60)}
                    style={styles.presetChip}
                  >
                    <Text style={styles.presetChipText}>⚡ 15 mins</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => sendSocketTimer(activeSocket.id, 30 * 60)}
                    style={styles.presetChip}
                  >
                    <Text style={styles.presetChipText}>🚰 30m Pump</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => sendSocketTimer(activeSocket.id, 45 * 60)}
                    style={styles.presetChip}
                  >
                    <Text style={styles.presetChipText}>💧 45m Tank</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => sendSocketTimer(activeSocket.id, 60 * 60)}
                    style={styles.presetChip}
                  >
                    <Text style={styles.presetChipText}>🔋 1 Hour</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => sendSocketTimer(activeSocket.id, 120 * 60)}
                    style={styles.presetChip}
                  >
                    <Text style={styles.presetChipText}>⚡ 2 Hours</Text>
                  </TouchableOpacity>
                </View>

                {/* Custom Minutes Input */}
                <View style={styles.customTimerRow}>
                  <TextInput
                    style={styles.customTimerInput}
                    placeholder="Mins"
                    placeholderTextColor="#64748B"
                    keyboardType="number-pad"
                    value={customTimerMinutes}
                    onChangeText={setCustomTimerMinutes}
                  />
                  <TouchableOpacity
                    onPress={() => {
                      const mins = parseInt(customTimerMinutes, 10);
                      if (!mins || mins <= 0) {
                        Alert.alert('Invalid Duration', 'Enter a valid number of minutes.');
                        return;
                      }
                      sendSocketTimer(activeSocket.id, mins * 60);
                    }}
                    style={styles.startCustomTimerBtn}
                  >
                    <Text style={styles.startCustomTimerText}>Start Custom Timer</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </View>

          {/* Current voltage guard state, when relevant */}
          <View style={styles.featureCard}>
            <View style={styles.featureHeaderRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.featureTitle}>🛡️ Appliance Voltage Guard</Text>
                <Text style={styles.featureSub}>
                  Automatic surge (≥250V) & brownout (≤175V) fridge protection
                </Text>
              </View>
              <View
                style={[
                  styles.guardStatusPill,
                  activeSocket.voltageGuard === 'SURGE'
                    ? styles.pillSurge
                    : activeSocket.voltageGuard === 'BROWNOUT'
                    ? styles.pillBrownout
                    : activeSocket.voltageGuard === 'RECOVERING'
                    ? styles.pillRecovering
                    : styles.pillNormal,
                ]}
              >
                <Text
                  style={[
                    styles.guardStatusPillText,
                    activeSocket.voltageGuard === 'SURGE'
                      ? { color: '#EF4444' }
                      : activeSocket.voltageGuard === 'BROWNOUT'
                      ? { color: '#F97316' }
                      : activeSocket.voltageGuard === 'RECOVERING'
                      ? { color: '#EAB308' }
                      : { color: '#10B981' },
                  ]}
                >
                  {activeSocket.voltageGuard === 'SURGE'
                    ? '🚨 SURGE TRIP'
                    : activeSocket.voltageGuard === 'BROWNOUT'
                    ? '⚠️ BROWNOUT TRIP'
                    : activeSocket.voltageGuard === 'RECOVERING'
                    ? `⏳ RECONNECT IN ${activeSocket.recoveryCountdown || 0}s`
                    : '🟢 NORMAL & SAFE'}
                </Text>
              </View>
            </View>

            {/* Explanation box */}
            <View style={styles.guardExplainBox}>
              <Text style={styles.guardExplainText}>
                {activeSocket.voltageGuard === 'SURGE'
                  ? '⚡ DANGER: High voltage surge detected! Relay has been cut OFF instantly to protect your refrigerator, TV, or inverter from burning.'
                  : activeSocket.voltageGuard === 'BROWNOUT'
                  ? '⚠️ WARNING: Dangerous low voltage brownout detected! Relay has been cut OFF to prevent electric motor overheat and compressor burnout.'
                  : activeSocket.voltageGuard === 'RECOVERING'
                  ? `⏳ Mains grid voltage is back in the safe window. Holding a 10s stabilization delay (${activeSocket.recoveryCountdown || 0}s left) before safely re-engaging power.`
                  : '✅ Grid line is within safe operating range (180V - 245V). Refrigerator, compressor, and appliances are fully shielded.'}
              </Text>
            </View>

          </View>
            </>
          )}
        </ScrollView>
      )}

      {/* ======================================================== */}
      {/* SEARCH & DISCOVERY MODAL: FIND AVAILABLE SOCKETS         */}
      {/* ======================================================== */}
      <Modal visible={isSearchModalVisible} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.searchModalContent}>
            <View style={styles.searchModalHeader}>
              <View>
                <Text style={styles.modalTitle}>Search Available Sockets</Text>
                <Text style={styles.modalDesc}>
                  Scanning cloud network for broadcasting smart sockets...
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => setIsSearchModalVisible(false)}
                style={styles.closeSearchButton}
              >
                <Text style={styles.closeSearchText}>✕</Text>
              </TouchableOpacity>
            </View>

            {/* Radar Scanning Indicator */}
            <View style={styles.radarBox}>
              <ActivityIndicator size="small" color="#38BDF8" style={{ marginRight: 8 }} />
              <Text style={styles.radarStatusText}>
                {availableToLink.length > 0
                  ? `Found ${availableToLink.length} new socket(s) nearby!`
                  : 'Listening for socket signals... Ensure socket is powered on.'}
              </Text>
            </View>

            {/* Discovered Sockets List */}
            <Text style={styles.foundHeader}>FOUND SOCKETS READY TO LINK:</Text>
            <ScrollView style={{ maxHeight: 200, marginBottom: 14 }}>
              {availableToLink.length === 0 ? (
                <View style={styles.noDeviceBox}>
                  <Text style={styles.noDeviceText}>
                    No unlinked sockets found yet. Plug in your ESP32 socket or enter ID manually below.
                  </Text>
                </View>
              ) : (
                availableToLink.map((dev) => (
                  <View key={dev.id} style={styles.discoveredItem}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.discoveredId}>{dev.id}</Text>
                      <Text style={styles.discoveredSub}>
                        Signal: {dev.wifi} dBm • Voltage:{' '}
                        {formatMetric(dev.voltage, 0)}{dev.voltage === null ? '' : 'V AC'}
                      </Text>
                    </View>
                    <TouchableOpacity
                      onPress={() => handleLinkDiscoveredSocket(dev)}
                      style={styles.linkActionButton}
                    >
                      <Text style={styles.linkActionText}>+ Link</Text>
                    </TouchableOpacity>
                  </View>
                ))
              )}
            </ScrollView>

            <View style={styles.detailsDivider} />

            {/* Manual ID fallback */}
            <Text style={styles.manualEntryTitle}>Or Enter Device ID Manually:</Text>
            <TextInput
              style={styles.modalInput}
              placeholder="e.g. SOCKET-01"
              placeholderTextColor="#64748B"
              value={manualSocketId}
              onChangeText={setManualSocketId}
              autoCapitalize="characters"
            />
            <TextInput
              style={styles.modalInput}
              placeholder="Nickname (e.g. Living Room Socket)"
              placeholderTextColor="#64748B"
              value={manualSocketName}
              onChangeText={setManualSocketName}
            />

            <TouchableOpacity onPress={handleManualLink} style={styles.manualSubmitButton}>
              <Text style={styles.manualSubmitText}>Link Socket Manually</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ======================================================== */}
      {/* RENAME MODAL                                             */}
      {/* ======================================================== */}
      <Modal visible={isRenameModalVisible} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Rename Socket</Text>
            <Text style={styles.modalDesc}>Give this socket an identifiable nickname.</Text>

            <TextInput
              style={[styles.modalInput, { marginTop: 14 }]}
              placeholder="New Socket Name"
              placeholderTextColor="#64748B"
              value={renameText}
              onChangeText={setRenameText}
            />

            <View style={styles.modalButtonRow}>
              <TouchableOpacity
                onPress={() => setIsRenameModalVisible(false)}
                style={styles.modalCancelButton}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>

              <TouchableOpacity onPress={handleRenameSocket} style={styles.modalSubmitButton}>
                <Text style={styles.modalSubmitText}>Save Name</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#0B0F19',
    paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight || 28) + 8 : 0,
  },
  container: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 40,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#1E293B',
  },
  appTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: '#F8FAFC',
    letterSpacing: 0.3,
  },
  appSubtitle: {
    fontSize: 13,
    color: '#94A3B8',
    marginTop: 2,
  },
  connectionBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 20,
    borderWidth: 1,
  },
  badgeOnline: {
    backgroundColor: 'rgba(16, 185, 129, 0.12)',
    borderColor: 'rgba(16, 185, 129, 0.4)',
  },
  badgeOffline: {
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
    borderColor: 'rgba(239, 68, 68, 0.4)',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  statusBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#F8FAFC',
    letterSpacing: 0.5,
  },
  cloudNoticeBar: {
    backgroundColor: '#1E293B',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
    alignItems: 'center',
  },
  cloudNoticeText: {
    color: '#38BDF8',
    fontSize: 11,
    fontWeight: '600',
  },
  sectionTitleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 12,
  },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '700',
    color: '#64748B',
    letterSpacing: 1,
  },
  searchButton: {
    backgroundColor: '#2563EB',
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: 16,
  },
  searchButtonText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 12,
  },
  socketCard: {
    backgroundColor: '#1E293B',
    borderRadius: 16,
    padding: 16,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#334155',
  },
  socketCardActive: {
    borderColor: '#10B981',
    backgroundColor: '#132238',
  },
  socketCardOutage: {
    borderColor: '#7F1D1D',
    backgroundColor: '#1C151B',
  },
  socketCardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 14,
  },
  socketIdBadge: {
    backgroundColor: '#0F172A',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    alignSelf: 'flex-start',
  },
  socketIdText: {
    color: '#38BDF8',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  gridStatusPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
  },
  pillLightOk: {
    backgroundColor: 'rgba(16, 185, 129, 0.1)',
    borderColor: 'rgba(16, 185, 129, 0.3)',
  },
  pillNoLight: {
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    borderColor: 'rgba(239, 68, 68, 0.4)',
  },
  gridStatusText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  socketCardName: {
    fontSize: 18,
    fontWeight: '700',
    color: '#F8FAFC',
  },
  quickSwitch: {
    width: 60,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  quickSwitchOn: {
    backgroundColor: '#10B981',
    borderColor: '#34D399',
  },
  quickSwitchOff: {
    backgroundColor: '#0F172A',
    borderColor: '#334155',
  },
  quickSwitchDisabled: {
    backgroundColor: '#374151',
    borderColor: '#4B5563',
  },
  quickSwitchText: {
    color: '#FFFFFF',
    fontWeight: '800',
    fontSize: 12,
  },
  socketCardMetrics: {
    flexDirection: 'row',
    backgroundColor: '#0F172A',
    borderRadius: 12,
    padding: 10,
    justifyContent: 'space-between',
  },
  metricMini: {
    alignItems: 'center',
    flex: 1,
  },
  metricMiniLabel: {
    fontSize: 9,
    color: '#64748B',
    fontWeight: '700',
  },
  metricMiniValue: {
    fontSize: 14,
    color: '#F8FAFC',
    fontWeight: '700',
    marginTop: 2,
  },
  cardFooterHint: {
    marginTop: 10,
    alignItems: 'flex-end',
  },
  cardFooterText: {
    color: '#38BDF8',
    fontSize: 11,
    fontWeight: '500',
  },
  emptyStateCard: {
    backgroundColor: '#1E293B',
    borderRadius: 20,
    padding: 30,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#334155',
    marginTop: 20,
  },
  emptyStateIcon: {
    fontSize: 48,
    marginBottom: 12,
  },
  emptyStateTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#F8FAFC',
    marginBottom: 6,
  },
  emptyStateDesc: {
    fontSize: 13,
    color: '#94A3B8',
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: 20,
  },
  primaryActionButton: {
    backgroundColor: '#2563EB',
    paddingVertical: 12,
    paddingHorizontal: 22,
    borderRadius: 12,
  },
  primaryActionText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 14,
  },
  detailNavRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  backButton: {
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  backButtonText: {
    color: '#38BDF8',
    fontSize: 14,
    fontWeight: '600',
  },
  detailActionsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  actionChip: {
    backgroundColor: '#1E293B',
    borderWidth: 1,
    borderColor: '#334155',
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 12,
  },
  actionChipText: {
    color: '#CBD5E1',
    fontSize: 12,
    fontWeight: '600',
  },
  outageBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    marginBottom: 18,
    gap: 12,
  },
  outageBannerLightOk: {
    backgroundColor: 'rgba(16, 185, 129, 0.1)',
    borderColor: 'rgba(16, 185, 129, 0.3)',
  },
  outageBannerNoLight: {
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    borderColor: 'rgba(239, 68, 68, 0.4)',
  },
  outageBannerIcon: {
    fontSize: 24,
  },
  outageBannerTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: '#F8FAFC',
    letterSpacing: 0.3,
  },
  outageBannerSub: {
    fontSize: 11,
    color: '#94A3B8',
    marginTop: 2,
  },
  heroCard: {
    backgroundColor: '#1E293B',
    borderRadius: 20,
    padding: 22,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#334155',
    marginBottom: 20,
  },
  heroHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  heroSocketName: {
    fontSize: 20,
    fontWeight: '800',
    color: '#F8FAFC',
  },
  heroIdBadge: {
    backgroundColor: '#0F172A',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  heroIdText: {
    color: '#38BDF8',
    fontSize: 10,
    fontWeight: '800',
  },
  powerButtonCircle: {
    width: 135,
    height: 135,
    borderRadius: 68,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 8,
  },
  powerCircleActive: {
    backgroundColor: '#10B981',
    borderWidth: 4,
    borderColor: '#34D399',
  },
  powerCircleInactive: {
    backgroundColor: '#0F172A',
    borderWidth: 4,
    borderColor: '#334155',
  },
  powerCircleDisabled: {
    backgroundColor: '#1E293B',
    borderWidth: 4,
    borderColor: '#7F1D1D',
  },
  powerIcon: {
    width: 40,
    height: 40,
    alignItems: 'center',
  },
  powerIconRing: {
    position: 'absolute',
    top: 4,
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 3,
    borderColor: '#FFFFFF',
  },
  powerIconStem: {
    position: 'absolute',
    top: 0,
    width: 3,
    height: 19,
    borderRadius: 2,
    backgroundColor: '#FFFFFF',
  },
  powerButtonStateText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 1,
    marginTop: 4,
  },
  relayStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  miniIndicator: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  relayStatusText: {
    fontSize: 13,
    color: '#CBD5E1',
    fontWeight: '500',
  },
  gridContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginBottom: 16,
  },
  metricCard: {
    width: (Dimensions.get('window').width - 44) / 2,
    backgroundColor: '#1E293B',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#334155',
  },
  metricCardLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: '#64748B',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  metricCardValue: {
    fontSize: 22,
    fontWeight: '800',
    color: '#F8FAFC',
  },
  unitText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#94A3B8',
  },
  metricCardFoot: {
    fontSize: 11,
    color: '#94A3B8',
    marginTop: 6,
  },
  costCard: {
    backgroundColor: '#1E293B',
    borderRadius: 16,
    padding: 18,
    borderWidth: 1,
    borderColor: '#334155',
    marginBottom: 16,
  },
  costHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  costTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#F8FAFC',
  },
  costSub: {
    fontSize: 11,
    color: '#94A3B8',
    marginTop: 2,
  },
  nairaIcon: {
    fontSize: 22,
    fontWeight: '800',
    color: '#10B981',
  },
  costValueRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 10,
  },
  costValue: {
    fontSize: 28,
    fontWeight: '800',
    color: '#10B981',
  },
  costDuration: {
    fontSize: 12,
    color: '#94A3B8',
  },
  detailsDivider: {
    height: 1,
    backgroundColor: '#334155',
    marginVertical: 14,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  searchModalContent: {
    backgroundColor: '#1E293B',
    borderRadius: 20,
    padding: 22,
    width: '100%',
    maxWidth: 400,
    borderWidth: 1,
    borderColor: '#334155',
  },
  searchModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  closeSearchButton: {
    padding: 6,
  },
  closeSearchText: {
    fontSize: 18,
    color: '#94A3B8',
    fontWeight: '700',
  },
  radarBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(56, 189, 248, 0.08)',
    borderColor: 'rgba(56, 189, 248, 0.3)',
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    marginBottom: 14,
  },
  radarStatusText: {
    fontSize: 12,
    color: '#38BDF8',
    flex: 1,
    fontWeight: '500',
  },
  foundHeader: {
    fontSize: 11,
    fontWeight: '800',
    color: '#64748B',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  discoveredItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#0F172A',
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#334155',
  },
  discoveredId: {
    fontSize: 15,
    fontWeight: '800',
    color: '#F8FAFC',
  },
  discoveredSub: {
    fontSize: 11,
    color: '#94A3B8',
    marginTop: 2,
  },
  linkActionButton: {
    backgroundColor: '#10B981',
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: 10,
  },
  linkActionText: {
    color: '#FFFFFF',
    fontWeight: '800',
    fontSize: 12,
  },
  noDeviceBox: {
    backgroundColor: '#0F172A',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#334155',
  },
  noDeviceText: {
    fontSize: 12,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 18,
  },
  manualEntryTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#CBD5E1',
    marginBottom: 8,
  },
  manualSubmitButton: {
    backgroundColor: '#2563EB',
    paddingVertical: 11,
    borderRadius: 10,
    alignItems: 'center',
  },
  manualSubmitText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 13,
  },
  modalContent: {
    backgroundColor: '#1E293B',
    borderRadius: 20,
    padding: 24,
    width: '100%',
    maxWidth: 380,
    borderWidth: 1,
    borderColor: '#334155',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#F8FAFC',
    marginBottom: 6,
  },
  modalDesc: {
    fontSize: 13,
    color: '#94A3B8',
    lineHeight: 18,
    marginBottom: 16,
  },
  modalInput: {
    backgroundColor: '#0F172A',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: '#F8FAFC',
    fontSize: 14,
    borderWidth: 1,
    borderColor: '#334155',
    marginBottom: 10,
  },
  modalButtonRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 8,
  },
  modalCancelButton: {
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  modalCancelText: {
    color: '#94A3B8',
    fontWeight: '600',
    fontSize: 14,
  },
  modalSubmitButton: {
    backgroundColor: '#2563EB',
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 10,
  },
  modalSubmitText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 14,
  },
  // Feature Cards & Elements
  settingsToggle: {
    backgroundColor: '#1E293B',
    borderRadius: 14,
    paddingVertical: 13,
    paddingHorizontal: 16,
    marginBottom: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#334155',
  },
  settingsToggleText: {
    color: '#F8FAFC',
    fontSize: 14,
    fontWeight: '700',
  },
  settingsToggleChevron: {
    color: '#94A3B8',
    fontSize: 12,
  },
  settingsCard: {
    backgroundColor: '#1E293B',
    borderRadius: 18,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#334155',
  },
  settingsTitle: {
    color: '#F8FAFC',
    fontSize: 15,
    fontWeight: '800',
    marginBottom: 12,
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#334155',
  },
  settingTextBlock: {
    flex: 1,
    paddingRight: 12,
  },
  settingLabel: {
    color: '#F8FAFC',
    fontSize: 13,
    fontWeight: '700',
  },
  settingHelp: {
    color: '#94A3B8',
    fontSize: 11,
    lineHeight: 15,
    marginTop: 3,
  },
  delayInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  delayInput: {
    backgroundColor: '#0F172A',
    borderRadius: 9,
    borderWidth: 1,
    borderColor: '#475569',
    color: '#FFFFFF',
    width: 58,
    paddingVertical: 7,
    paddingHorizontal: 8,
    textAlign: 'center',
  },
  secondsLabel: {
    color: '#CBD5E1',
    fontSize: 12,
    marginLeft: 6,
  },
  saveSettingsButton: {
    backgroundColor: '#2563EB',
    borderRadius: 10,
    alignItems: 'center',
    paddingVertical: 10,
    marginTop: 10,
  },
  saveSettingsText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 12,
  },
  featureCard: {
    backgroundColor: '#1E293B',
    borderRadius: 18,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#334155',
  },
  featureHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  featureTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#F8FAFC',
    marginBottom: 3,
  },
  featureSub: {
    fontSize: 11,
    color: '#94A3B8',
    lineHeight: 16,
  },
  activeTimerBadge: {
    backgroundColor: 'rgba(56, 189, 248, 0.2)',
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#38BDF8',
  },
  activeTimerBadgeText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#38BDF8',
  },
  runningTimerBox: {
    backgroundColor: '#0F172A',
    borderRadius: 14,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#38BDF8',
  },
  runningTimerLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#38BDF8',
    letterSpacing: 0.5,
  },
  runningTimerClock: {
    fontSize: 26,
    fontWeight: '900',
    color: '#FFFFFF',
    fontVariant: ['tabular-nums'],
    marginVertical: 4,
  },
  runningTimerSub: {
    fontSize: 10,
    color: '#64748B',
  },
  cancelTimerBtn: {
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    borderWidth: 1,
    borderColor: '#EF4444',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 10,
  },
  cancelTimerBtnText: {
    color: '#EF4444',
    fontWeight: '700',
    fontSize: 12,
  },
  presetLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748B',
    marginBottom: 8,
    letterSpacing: 0.5,
  },
  timerPresetRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
  },
  presetChip: {
    backgroundColor: '#0F172A',
    paddingVertical: 7,
    paddingHorizontal: 11,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
  },
  presetChipText: {
    color: '#CBD5E1',
    fontWeight: '600',
    fontSize: 11,
  },
  customTimerRow: {
    flexDirection: 'row',
    gap: 8,
  },
  customTimerInput: {
    backgroundColor: '#0F172A',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: '#FFFFFF',
    fontSize: 13,
    borderWidth: 1,
    borderColor: '#334155',
    width: 65,
    textAlign: 'center',
  },
  startCustomTimerBtn: {
    flex: 1,
    backgroundColor: '#2563EB',
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 8,
  },
  startCustomTimerText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 12,
  },
  guardStatusPill: {
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  pillNormal: {
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    borderColor: '#10B981',
  },
  pillSurge: {
    backgroundColor: 'rgba(239, 68, 68, 0.2)',
    borderColor: '#EF4444',
  },
  pillBrownout: {
    backgroundColor: 'rgba(249, 115, 22, 0.2)',
    borderColor: '#F97316',
  },
  pillRecovering: {
    backgroundColor: 'rgba(234, 179, 8, 0.2)',
    borderColor: '#EAB308',
  },
  guardStatusPillText: {
    fontSize: 10,
    fontWeight: '800',
  },
  guardExplainBox: {
    backgroundColor: '#0F172A',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: '#1E293B',
    marginBottom: 12,
  },
  guardExplainText: {
    fontSize: 11,
    color: '#94A3B8',
    lineHeight: 16,
  },
  demoHeader: {
    fontSize: 10,
    fontWeight: '800',
    color: '#F59E0B',
    marginBottom: 8,
    letterSpacing: 0.5,
  },
  demoButtonsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  demoBtn: {
    flex: 1,
    backgroundColor: '#0F172A',
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
  },
  demoBtnText: {
    fontSize: 10,
    fontWeight: '700',
  },
  guardMiniBadge: {
    paddingVertical: 3,
    paddingHorizontal: 6,
    borderRadius: 6,
    borderWidth: 1,
  },
  guardMiniBadgeText: {
    fontSize: 9,
    fontWeight: '800',
  },
  timerMiniBadge: {
    backgroundColor: 'rgba(56, 189, 248, 0.15)',
    borderColor: '#38BDF8',
    borderWidth: 1,
    paddingVertical: 3,
    paddingHorizontal: 6,
    borderRadius: 6,
  },
  timerMiniBadgeText: {
    fontSize: 9,
    fontWeight: '800',
    color: '#38BDF8',
  },
});
