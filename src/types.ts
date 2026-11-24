export interface SocketItem {
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

export interface DiscoveredSocket {
  id: string;
  voltage: number | null;
  relay: boolean;
  power: number | null;
  wifi: number;
  lastSeen: number;
}

export const MQTT_CONFIG = {
  host: 'broker.emqx.io',
  port: 8084, // WSS
  path: '/mqtt',
  topicWildcardTelemetry: 'build_nigeria/sockets/+/status',
  topicLegacyTelemetry: 'build_nigeria/socket/telemetry',
};

export const STORAGE_KEY = '@build_nigeria_smart_sockets_v4';
export const HEARTBEAT_TIMEOUT_MS = 10000;

export const parseTelemetryNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const formatMetric = (value: number | null | undefined, decimals: number): string =>
  typeof value === 'number' && Number.isFinite(value) ? value.toFixed(decimals) : 'N/A';

export const formatTimerDuration = (seconds?: number): string => {
  if (!seconds || seconds <= 0) return '00:00';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs < 10 ? '0' : ''}${secs}s`;
};

export const formatUptime = (secs: number): string => {
  const mins = Math.floor(secs / 60);
  const s = secs % 60;
  return `${mins}m ${s}s`;
};

export const getOutageDurationText = (startTime?: number | null): string => {
  if (!startTime) return 'Recent';
  const elapsedSecs = Math.floor((Date.now() - startTime) / 1000);
  if (elapsedSecs < 60) return `${elapsedSecs}s ago`;
  const elapsedMins = Math.floor(elapsedSecs / 60);
  return `${elapsedMins}m ago`;
};
