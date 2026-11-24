import React, { useState, useEffect, useRef } from 'react';
// @ts-ignore
import * as PahoLib from 'paho-mqtt';
import {
  SocketItem,
  DiscoveredSocket,
  MQTT_CONFIG,
  HEARTBEAT_TIMEOUT_MS,
  formatMetric,
  formatTimerDuration,
  getOutageDurationText,
  parseTelemetryNumber,
} from './types';
import { loadSavedSockets, saveSocketsToStorage } from './services/storage';
import { requestNotificationPermissions, sendAppNotification } from './services/notifications';

const Paho = (PahoLib as any).default || (PahoLib as any).Paho || (window as any).Paho || PahoLib;

export default function App() {
  const [mqttStatus, setMqttStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
  const [mqttErrorMsg, setMqttErrorMsg] = useState<string | null>(null);

  // User's Linked Sockets
  const [sockets, setSockets] = useState<SocketItem[]>(() => {
    const saved = loadSavedSockets();
    // Default example if user starts fresh
    if (!saved || saved.length === 0) {
      return [
        {
          id: 'SOCKET-01',
          name: 'PowerSense Main',
          relay: false,
          voltage: null,
          current: null,
          power: null,
          energy: 0,
          temperature: null,
          uptime: 0,
          wifi: -60,
          gridStatus: 'LIGHT_OK',
          lastSeenTimestamp: Date.now(),
          isOnline: true,
          voltageGuardEnabled: true,
          startupDelaySeconds: 10,
        },
      ];
    }
    return saved;
  });

  const [selectedSocketId, setSelectedSocketId] = useState<string | null>(null);

  // Search & Discovery
  const [discoveredDevices, setDiscoveredDevices] = useState<DiscoveredSocket[]>([]);
  const [isSearchModalVisible, setIsSearchModalVisible] = useState(false);
  const [isRenameModalVisible, setIsRenameModalVisible] = useState(false);
  const [manualSocketId, setManualSocketId] = useState('');
  const [manualSocketName, setManualSocketName] = useState('');
  const [renameText, setRenameText] = useState('');

  const clientRef = useRef<any>(null);
  const pendingCommandsRef = useRef<Record<string, { targetRelay: boolean; expiresAt: number }>>({});
  const lastCommandTimeRef = useRef<Record<string, number>>({});
  const temperatureAlarmStateRef = useRef<Record<string, boolean>>({});

  const activeSocket = sockets.find((s) => s.id.toUpperCase() === selectedSocketId?.toUpperCase()) || null;

  useEffect(() => {
    requestNotificationPermissions();
  }, []);

  const persistSockets = (updated: SocketItem[]) => {
    setSockets(updated);
    saveSocketsToStorage(updated);
  };

  // Heartbeat watchdog: detect outage if no ping for 10s
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
              outageStartTime: sock.outageStartTime || now,
            };
          }
          return sock;
        })
      );
    }, 2500);

    return () => clearInterval(watchdogInterval);
  }, []);

  // Connect to MQTT
  const connectMQTT = () => {
    try {
      setMqttStatus('connecting');
      setMqttErrorMsg(null);

      const clientId = `PowerSense-${Math.random().toString(16).substring(2, 10)}`;
      const client = new Paho.Client(MQTT_CONFIG.host, MQTT_CONFIG.port, MQTT_CONFIG.path, clientId);

      client.onConnectionLost = (responseObject: any) => {
        setMqttStatus('disconnected');
        setMqttErrorMsg(responseObject?.errorMessage || 'Connection lost');
      };

      client.onMessageArrived = (message: any) => {
        try {
          const topic = message.destinationName;
          const payload = JSON.parse(message.payloadString);
          const rawId = payload.deviceId || (topic.includes('/') ? topic.split('/')[2] : 'SOCKET-01');
          const deviceId = (rawId || 'SOCKET-01').toUpperCase();
          const now = Date.now();
          const highTemp = payload.highTemperatureAlarm === true;

          if (highTemp && !temperatureAlarmStateRef.current[deviceId]) {
            sendAppNotification('PowerSense High Temp Warning ⚠️', `${deviceId} temperature is above 50°C!`);
          }
          temperatureAlarmStateRef.current[deviceId] = highTemp;

          const isOutage = payload.gridStatus === 'NO_LIGHT' || payload.isOnline === false;

          // Discovered devices pool
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
            }
            return [...prev, devData];
          });

          // Update linked sockets
          setSockets((prev) => {
            const index = prev.findIndex((s) => s.id.toUpperCase() === deviceId);
            if (index === -1) return prev;

            const reportedRelay = Boolean(payload.relay);
            const reportedPower = parseTelemetryNumber(payload.power);
            const pending = pendingCommandsRef.current[deviceId];
            let effectiveRelay = isOutage ? false : reportedRelay;

            if (!isOutage && pending) {
              if (reportedRelay === pending.targetRelay) {
                delete pendingCommandsRef.current[deviceId];
                effectiveRelay = reportedRelay;
              } else if (Date.now() < pending.expiresAt) {
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
              outageStartTime: isOutage ? updated[index].outageStartTime || now : null,
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
              highTemperatureAlarm: highTemp,
            };
            return updated;
          });
        } catch (e) {
          console.warn('Telemetry error:', e);
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
          client.subscribe(MQTT_CONFIG.topicWildcardTelemetry, { qos: 0 });
        },
        onFailure: (err: any) => {
          setMqttStatus('error');
          setMqttErrorMsg(err?.errorMessage || 'Cloud server unreachable');
        },
      });

      clientRef.current = client;
    } catch (e: any) {
      setMqttStatus('error');
      setMqttErrorMsg(e?.message || 'MQTT failed');
    }
  };

  useEffect(() => {
    connectMQTT();
    return () => {
      if (clientRef.current && clientRef.current.isConnected()) {
        try {
          clientRef.current.disconnect();
        } catch {}
      }
    };
  }, []);

  // Send power toggle command
  const sendPowerCommand = (targetSocketId: string, desiredState: boolean) => {
    const sId = targetSocketId.toUpperCase();
    const now = Date.now();

    if (now - (lastCommandTimeRef.current[sId] || 0) < 300) return;
    lastCommandTimeRef.current[sId] = now;

    const targetSocket = sockets.find((s) => s.id.toUpperCase() === sId);
    if (targetSocket?.gridStatus === 'NO_LIGHT') {
      alert('Power Outage: Cannot turn ON while there is No Light (0V).');
      return;
    }

    if (!clientRef.current || !clientRef.current.isConnected()) {
      connectMQTT();
    }

    pendingCommandsRef.current[sId] = {
      targetRelay: desiredState,
      expiresAt: now + 2500,
    };

    const payload = JSON.stringify({ relay: desiredState, deviceId: targetSocketId });
    const message = new Paho.Message(payload);
    message.destinationName = `build_nigeria/sockets/${targetSocketId}/command`;
    message.qos = 0;
    try {
      clientRef.current?.send(message);
    } catch {}

    setSockets((prev) =>
      prev.map((s) => (s.id.toUpperCase() === sId ? { ...s, relay: desiredState } : s))
    );
  };

  // Simplified Timer Commands
  const setQuickTimer = (targetSocketId: string, minutes: number) => {
    const seconds = minutes * 60;
    const payload = JSON.stringify({ timerSeconds: seconds, deviceId: targetSocketId });
    const message = new Paho.Message(payload);
    message.destinationName = `build_nigeria/sockets/${targetSocketId}/command`;
    message.qos = 0;
    try {
      clientRef.current?.send(message);
    } catch {}

    setSockets((prev) =>
      prev.map((s) =>
        s.id.toUpperCase() === targetSocketId.toUpperCase()
          ? { ...s, relay: true, timerActive: true, timerRemaining: seconds }
          : s
      )
    );
  };

  const cancelTimer = (targetSocketId: string) => {
    const payload = JSON.stringify({ cancelTimer: true, deviceId: targetSocketId });
    const message = new Paho.Message(payload);
    message.destinationName = `build_nigeria/sockets/${targetSocketId}/command`;
    message.qos = 0;
    try {
      clientRef.current?.send(message);
    } catch {}

    setSockets((prev) =>
      prev.map((s) =>
        s.id.toUpperCase() === targetSocketId.toUpperCase()
          ? { ...s, timerActive: false, timerRemaining: 0 }
          : s
      )
    );
  };

  // Simplified Settings Update
  const updateSettings = (
    targetSocketId: string,
    settings: { voltageGuardEnabled?: boolean; startupDelaySeconds?: number }
  ) => {
    const payload = JSON.stringify({ ...settings, deviceId: targetSocketId });
    const message = new Paho.Message(payload);
    message.destinationName = `build_nigeria/sockets/${targetSocketId}/command`;
    message.qos = 0;
    try {
      clientRef.current?.send(message);
    } catch {}

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

  // Add / Link Discovered Socket
  const linkSocket = (devId: string, customName?: string) => {
    const cleanId = devId.trim().toUpperCase();
    if (!cleanId) return;

    if (sockets.some((s) => s.id.toUpperCase() === cleanId)) {
      alert(`${cleanId} is already linked.`);
      return;
    }

    const newSocket: SocketItem = {
      id: cleanId,
      name: customName?.trim() || `PowerSense ${cleanId}`,
      relay: false,
      voltage: null,
      current: null,
      power: null,
      energy: 0,
      temperature: null,
      uptime: 0,
      wifi: -60,
      gridStatus: 'LIGHT_OK',
      lastSeenTimestamp: Date.now(),
      isOnline: true,
      voltageGuardEnabled: true,
      startupDelaySeconds: 10,
    };

    persistSockets([...sockets, newSocket]);
    setIsSearchModalVisible(false);
    setManualSocketId('');
    setManualSocketName('');
  };

  // Remove Socket
  const removeSocket = (id: string) => {
    if (confirm(`Remove ${id} from PowerSense?`)) {
      const updated = sockets.filter((s) => s.id.toUpperCase() !== id.toUpperCase());
      persistSockets(updated);
      setSelectedSocketId(null);
    }
  };

  // Rename Socket
  const saveRename = () => {
    if (!renameText.trim() || !selectedSocketId) return;
    const updated = sockets.map((s) =>
      s.id.toUpperCase() === selectedSocketId.toUpperCase() ? { ...s, name: renameText.trim() } : s
    );
    persistSockets(updated);
    setIsRenameModalVisible(false);
  };

  const unlinkedDevices = discoveredDevices.filter(
    (dev) => !sockets.some((s) => s.id.toUpperCase() === dev.id.toUpperCase())
  );

  return (
    <>
      {/* Top App Header */}
      <header className="app-header">
        <div className="brand-badge">
          <div className="brand-logo-icon">⚡</div>
          <div>
            <h1 className="brand-title">PowerSense</h1>
            <div className="brand-sub">Smart Power & Protection</div>
          </div>
        </div>

        <button
          onClick={connectMQTT}
          className={`cloud-pill ${mqttStatus === 'connected' ? 'cloud-online' : 'cloud-offline'}`}
          title="Cloud Connection Status"
        >
          <span
            className={`dot-indicator ${mqttStatus === 'connected' ? 'dot-green' : 'dot-red'}`}
          />
          <span>{mqttStatus === 'connected' ? 'CLOUD' : 'CONNECT'}</span>
        </button>
      </header>

      {/* Cloud Offline Banner */}
      {mqttStatus !== 'connected' && (
        <div onClick={connectMQTT} className="offline-bar">
          {mqttStatus === 'connecting'
            ? '⏳ Connecting to cloud...'
            : `⚠️ Cloud offline (${mqttErrorMsg || 'Tap to reconnect'})`}
        </div>
      )}

      {/* ========================================================== */}
      {/* 1. MAIN DASHBOARD: ALL SOCKETS                             */}
      {/* ========================================================== */}
      {!selectedSocketId && (
        <main className="main-content">
          <div className="section-head">
            <span className="section-title">My Sockets ({sockets.length})</span>
            <button
              onClick={() => {
                setIsSearchModalVisible(true);
                connectMQTT();
              }}
              className="btn-add"
            >
              + Add Socket
            </button>
          </div>

          {sockets.length === 0 ? (
            <div className="empty-box">
              <span className="empty-icon">🔌</span>
              <h2 className="empty-title">No Sockets Added</h2>
              <p className="empty-text">
                Plug in your PowerSense socket. Tap below to find it or add by ID.
              </p>
              <button
                onClick={() => setIsSearchModalVisible(true)}
                className="btn-add"
                style={{ padding: '10px 20px', fontSize: 14 }}
              >
                + Add PowerSense Socket
              </button>
            </div>
          ) : (
            sockets.map((sock) => {
              const hasLight = sock.gridStatus === 'LIGHT_OK';
              const isTrip = sock.voltageGuard && sock.voltageGuard !== 'NORMAL';

              return (
                <div
                  key={sock.id}
                  onClick={() => setSelectedSocketId(sock.id)}
                  className={`socket-card ${
                    hasLight && sock.relay ? 'socket-card-on' : !hasLight ? 'socket-card-outage' : ''
                  }`}
                >
                  <div className="socket-header-row">
                    <div className="socket-title-block">
                      <div className="socket-name">{sock.name}</div>
                      <div className="socket-meta">
                        <span className="badge-id">{sock.id}</span>

                        <span
                          className={`badge-status ${
                            !hasLight
                              ? 'status-cut'
                              : isTrip
                              ? 'status-trip'
                              : 'status-ok'
                          }`}
                        >
                          {!hasLight
                            ? `⚠️ No Light (${getOutageDurationText(sock.outageStartTime)})`
                            : isTrip
                            ? `🛡️ ${sock.voltageGuard}`
                            : `⚡ ${formatMetric(sock.voltage, 0)}V Normal`}
                        </span>

                        {sock.timerActive && (sock.timerRemaining || 0) > 0 && (
                          <span className="badge-status status-ok">
                            ⏱️ {Math.ceil((sock.timerRemaining || 0) / 60)}m left
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Quick Switch */}
                    <button
                      disabled={!hasLight}
                      onClick={(e) => {
                        e.stopPropagation();
                        sendPowerCommand(sock.id, !sock.relay);
                      }}
                      className={`switch-btn ${
                        !hasLight
                          ? 'switch-btn-disabled'
                          : sock.relay
                          ? 'switch-btn-on'
                          : 'switch-btn-off'
                      }`}
                    >
                      {!hasLight ? 'DEAD' : sock.relay ? 'ON' : 'OFF'}
                    </button>
                  </div>

                  {/* 3 Clean Numbers */}
                  <div className="metric-summary-grid">
                    <div className="metric-cell">
                      <span className="metric-cell-label">Power</span>
                      <span
                        className="metric-cell-val"
                        style={{ color: hasLight && sock.relay ? '#F59E0B' : undefined }}
                      >
                        {hasLight ? `${formatMetric(Math.max(0, sock.power ?? 0), 0)} W` : '0 W'}
                      </span>
                    </div>

                    <div className="metric-cell">
                      <span className="metric-cell-label">Voltage</span>
                      <span
                        className="metric-cell-val"
                        style={{ color: !hasLight ? '#F87171' : undefined }}
                      >
                        {hasLight ? `${formatMetric(sock.voltage, 0)} V` : '0 V'}
                      </span>
                    </div>

                    <div className="metric-cell">
                      <span className="metric-cell-label">Energy</span>
                      <span className="metric-cell-val" style={{ color: '#34D399' }}>
                        {formatMetric(sock.energy ?? 0, 2)} kWh
                      </span>
                    </div>
                  </div>

                  <div className="card-hint">Tap for controls & protection settings →</div>
                </div>
              );
            })
          )}
        </main>
      )}

      {/* ========================================================== */}
      {/* 2. DETAIL VIEW & SIMPLIFIED SETTINGS                      */}
      {/* ========================================================== */}
      {selectedSocketId && activeSocket && (
        <main className="main-content">
          {/* Navigation Bar */}
          <div className="nav-bar">
            <button onClick={() => setSelectedSocketId(null)} className="back-link">
              ← All Sockets
            </button>

            <div className="nav-actions">
              <button
                onClick={() => {
                  setRenameText(activeSocket.name);
                  setIsRenameModalVisible(true);
                }}
                className="btn-chip"
              >
                ✏️ Rename
              </button>
              <button
                onClick={() => removeSocket(activeSocket.id)}
                className="btn-chip btn-chip-danger"
              >
                🗑️ Remove
              </button>
            </div>
          </div>

          {/* Master Power Hero */}
          <div className="hero-box">
            <div className="hero-device-name">{activeSocket.name}</div>
            <span className="badge-id">{activeSocket.id}</span>

            <button
              disabled={activeSocket.gridStatus === 'NO_LIGHT'}
              onClick={() => sendPowerCommand(activeSocket.id, !activeSocket.relay)}
              className={`power-big-btn ${
                activeSocket.gridStatus === 'NO_LIGHT'
                  ? 'power-btn-outage'
                  : activeSocket.relay
                  ? 'power-btn-active'
                  : 'power-btn-inactive'
              }`}
            >
              <svg className="power-svg" viewBox="0 0 24 24">
                <path d="M12 2v10M18.36 6.64a9 9 0 1 1-12.73 0" />
              </svg>
              <span className="power-state-lbl">
                {activeSocket.gridStatus === 'NO_LIGHT'
                  ? 'NO LIGHT'
                  : activeSocket.relay
                  ? 'POWER ON'
                  : 'POWER OFF'}
              </span>
            </button>

            <div className="live-watts">
              {activeSocket.gridStatus === 'LIGHT_OK' && activeSocket.relay
                ? `⚡ ${formatMetric(Math.max(0, activeSocket.power ?? 0), 0)} W Draw`
                : activeSocket.gridStatus === 'NO_LIGHT'
                ? '⚠️ Mains Outage Detected'
                : 'Socket is switched off'}
            </div>
          </div>

          {/* 4 Clean Stats */}
          <div className="stats-4grid">
            <div className="stat-tile">
              <span className="stat-tile-title">Grid Voltage</span>
              <div
                className="stat-tile-value"
                style={{ color: activeSocket.gridStatus === 'NO_LIGHT' ? '#F87171' : undefined }}
              >
                {activeSocket.gridStatus === 'NO_LIGHT' ? '0 V' : `${formatMetric(activeSocket.voltage, 0)} V`}
              </div>
              <span className="stat-tile-sub">
                {activeSocket.gridStatus === 'NO_LIGHT' ? 'Power Outage' : 'Safe Operating Window'}
              </span>
            </div>

            <div className="stat-tile">
              <span className="stat-tile-title">Power Draw</span>
              <div
                className="stat-tile-value"
                style={{ color: activeSocket.relay ? '#F59E0B' : '#94A3B8' }}
              >
                {formatMetric(Math.max(0, activeSocket.power ?? 0), 0)} W
              </div>
              <span className="stat-tile-sub">
                {activeSocket.relay ? `${formatMetric(activeSocket.current ?? 0, 2)} A Current` : 'Idle'}
              </span>
            </div>

            <div className="stat-tile">
              <span className="stat-tile-title">Total Energy</span>
              <div className="stat-tile-value" style={{ color: '#34D399' }}>
                {formatMetric(activeSocket.energy ?? 0, 2)} kWh
              </div>
              <span className="stat-tile-sub">Recorded Usage</span>
            </div>

            <div className="stat-tile">
              <span className="stat-tile-title">Socket Temp</span>
              <div
                className="stat-tile-value"
                style={{ color: (activeSocket.temperature ?? 0) > 48 ? '#F87171' : '#38BDF8' }}
              >
                {formatMetric(activeSocket.temperature, 0)} °C
              </div>
              <span className="stat-tile-sub">
                {(activeSocket.temperature ?? 0) > 48 ? '⚠️ Warning' : 'Normal & Cool'}
              </span>
            </div>
          </div>

          {/* ==================================================== */}
          {/* SIMPLIFIED SOCKET SETTINGS                           */}
          {/* ==================================================== */}
          <div className="settings-sheet">
            <div className="sheet-header">⚙️ Socket Settings & Protection</div>

            {/* 1. Appliance Voltage Guard */}
            <div className="setting-item">
              <div className="setting-row-top">
                <span className="setting-title">🛡️ Appliance Voltage Guard</span>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={activeSocket.voltageGuardEnabled !== false}
                    onChange={(e) =>
                      updateSettings(activeSocket.id, { voltageGuardEnabled: e.target.checked })
                    }
                  />
                  <span className="slider"></span>
                </label>
              </div>
              <p className="setting-desc">
                Automatically cuts power during severe surges (≥250V) or low voltage brownouts (≤175V)
                to protect your refrigerator, TV, or inverter from burning.
              </p>
              {activeSocket.voltageGuard && activeSocket.voltageGuard !== 'NORMAL' && (
                <div
                  style={{
                    backgroundColor: 'rgba(239, 68, 68, 0.15)',
                    border: '1px solid #EF4444',
                    padding: '8px 12px',
                    borderRadius: 8,
                    fontSize: 12,
                    color: '#F87171',
                    fontWeight: 600,
                  }}
                >
                  {activeSocket.voltageGuard === 'SURGE'
                    ? '🚨 SURGE TRIP: Voltage exceeded 250V! Power cut for appliance safety.'
                    : activeSocket.voltageGuard === 'BROWNOUT'
                    ? '⚠️ BROWNOUT TRIP: Dangerous low voltage (<175V) detected.'
                    : `⏳ RECOVERING: Line normalized. Stabilizing for ${activeSocket.recoveryCountdown || 0}s...`}
                </div>
              )}
            </div>

            {/* 2. Safe Startup Delay */}
            <div className="setting-item">
              <span className="setting-title">⏱️ Safe Startup Delay</span>
              <p className="setting-desc">
                Delay power after power-up or grid return to avoid high inrush currents:
              </p>
              <div className="preset-pills-row">
                <button
                  onClick={() => updateSettings(activeSocket.id, { startupDelaySeconds: 0 })}
                  className={`pill-choice ${
                    activeSocket.startupDelaySeconds === 0 ? 'pill-choice-active' : ''
                  }`}
                >
                  Instant (0s)
                </button>
                <button
                  onClick={() => updateSettings(activeSocket.id, { startupDelaySeconds: 10 })}
                  className={`pill-choice ${
                    activeSocket.startupDelaySeconds === 10 || !activeSocket.startupDelaySeconds
                      ? 'pill-choice-active'
                      : ''
                  }`}
                >
                  Standard (10s)
                </button>
                <button
                  onClick={() => updateSettings(activeSocket.id, { startupDelaySeconds: 180 })}
                  className={`pill-choice ${
                    activeSocket.startupDelaySeconds === 180 ? 'pill-choice-active' : ''
                  }`}
                >
                  Fridge Safe (3 min)
                </button>
              </div>
            </div>

            {/* 3. Auto-Off Timer */}
            <div className="setting-item">
              <span className="setting-title">⏳ Auto-Off Timer</span>
              <p className="setting-desc">
                Automatically switch off the socket after a set time (great for water pumping machines & chargers):
              </p>

              {activeSocket.timerActive && (activeSocket.timerRemaining || 0) > 0 ? (
                <div className="active-timer-box">
                  <div>
                    <div style={{ fontSize: 11, color: '#38BDF8', fontWeight: 700 }}>
                      TURNING OFF IN:
                    </div>
                    <div className="timer-clock">
                      {formatTimerDuration(activeSocket.timerRemaining)}
                    </div>
                  </div>
                  <button
                    onClick={() => cancelTimer(activeSocket.id)}
                    className="btn-cancel-timer"
                  >
                    Cancel Timer
                  </button>
                </div>
              ) : (
                <div className="preset-pills-row">
                  <button
                    onClick={() => setQuickTimer(activeSocket.id, 15)}
                    className="pill-choice"
                  >
                    ⚡ 15 min
                  </button>
                  <button
                    onClick={() => setQuickTimer(activeSocket.id, 30)}
                    className="pill-choice"
                  >
                    🚰 30 min (Pump)
                  </button>
                  <button
                    onClick={() => setQuickTimer(activeSocket.id, 60)}
                    className="pill-choice"
                  >
                    🔋 1 Hour
                  </button>
                  <button
                    onClick={() => setQuickTimer(activeSocket.id, 120)}
                    className="pill-choice"
                  >
                    ⚡ 2 Hours
                  </button>
                </div>
              )}
            </div>
          </div>
        </main>
      )}

      {/* ========================================================== */}
      {/* ADD / DISCOVERY MODAL                                      */}
      {/* ========================================================== */}
      {isSearchModalVisible && (
        <div className="modal-backdrop" onClick={() => setIsSearchModalVisible(false)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2 className="modal-heading">Add PowerSense Socket</h2>
              <button onClick={() => setIsSearchModalVisible(false)} className="modal-close">
                ✕
              </button>
            </div>

            {unlinkedDevices.length > 0 ? (
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#94A3B8', marginBottom: 8 }}>
                  FOUND NEARBY:
                </div>
                {unlinkedDevices.map((dev) => (
                  <div
                    key={dev.id}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      backgroundColor: '#0D1626',
                      padding: 12,
                      borderRadius: 10,
                      marginBottom: 8,
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 800, color: '#fff' }}>{dev.id}</div>
                      <div style={{ fontSize: 11, color: '#94A3B8' }}>Signal: {dev.wifi} dBm</div>
                    </div>
                    <button
                      onClick={() => linkSocket(dev.id)}
                      className="btn-add"
                      style={{ padding: '6px 12px' }}
                    >
                      + Add
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p style={{ fontSize: 13, color: '#94A3B8', textAlign: 'center' }}>
                Scanning network for nearby sockets... You can also link manually below:
              </p>
            )}

            <input
              type="text"
              className="input-field"
              placeholder="Device ID (e.g. SOCKET-01)"
              value={manualSocketId}
              onChange={(e) => setManualSocketId(e.target.value.toUpperCase())}
            />
            <input
              type="text"
              className="input-field"
              placeholder="Socket Name (e.g. Living Room Socket)"
              value={manualSocketName}
              onChange={(e) => setManualSocketName(e.target.value)}
            />

            <button
              onClick={() => linkSocket(manualSocketId, manualSocketName)}
              className="btn-primary"
            >
              Link Socket
            </button>
          </div>
        </div>
      )}

      {/* ========================================================== */}
      {/* RENAME MODAL                                              */}
      {/* ========================================================== */}
      {isRenameModalVisible && (
        <div className="modal-backdrop" onClick={() => setIsRenameModalVisible(false)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2 className="modal-heading">Rename Socket</h2>
              <button onClick={() => setIsRenameModalVisible(false)} className="modal-close">
                ✕
              </button>
            </div>

            <input
              type="text"
              className="input-field"
              value={renameText}
              onChange={(e) => setRenameText(e.target.value)}
              placeholder="e.g. Kitchen Fridge"
              autoFocus
            />

            <button onClick={saveRename} className="btn-primary">
              Save Name
            </button>
          </div>
        </div>
      )}
    </>
  );
}
