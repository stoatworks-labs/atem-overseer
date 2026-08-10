// Mirror of packages/server/src/types.ts — keep in sync.

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';
export type RecordStatus = 'idle' | 'recording' | 'stopping';
export type StreamStatus = 'idle' | 'connecting' | 'streaming' | 'stopping';
export type RecordMode = 'pgm' | 'iso';

export interface DiskInfo {
  diskId: number;
  volumeName: string;
  timeAvailable: number;
  status: 'idle' | 'unformatted' | 'active' | 'recording' | 'removed';
  isWorkingSet: boolean;
}

export interface AudioLevels {
  leftLevel: number;
  rightLevel: number;
  leftPeak: number;
  rightPeak: number;
}

export interface MediaPlayerAssignment {
  index: number;
  sourceType: 'still' | 'clip';
  slotIndex: number;
  slotName: string;
}

export interface DeviceSnapshot {
  id: string;
  name: string;
  address: string;
  model: string;
  connection: ConnectionState;
  record: {
    status: RecordStatus;
    mode: RecordMode;
    duration: string | null;
    filename: string;
    timeAvailable: number;
  };
  stream: {
    status: StreamStatus;
    duration: string | null;
    bitrate: number;
    cacheUsed: number;
    serviceName: string;
    flvUrl: string | null;
    live: boolean;
  };
  disks: DiskInfo[];
  hostname: string | null;
  protocolVersion: string;
  audio: AudioLevels;
  monitorMuted: boolean;
  mediaPlayers: MediaPlayerAssignment[];
  lastUpdate: number;
}

export interface DiscoveredDevice {
  address: string;
  hostname: string | null;
  name: string;
  serviceType: string;
  alreadyManaged: boolean;
}

export interface ExternalAppInfo {
  key: string;
  label: string;
  autoSelect: boolean;
  available: boolean;
}

export interface RestreamerDestination {
  id: string;
  name: string;
  url: string;
  streamKey?: string;
  enabled: boolean;
}

export interface RestreamerStatus {
  enabled: boolean;
  configured: boolean;
  url?: string;
  reachable?: boolean;
  referencePrefix?: string;
  sourceKinds?: RestreamerSourceKind[];
  rendererUrl?: string;
}

export type RestreamerSourceKind = 'rtmp' | 'file' | 'browser';

/** What feeds a channel. Mirrors ChannelSource in @av/restreamer; kept
 *  structurally identical so the same JSON round-trips through the REST API. */
export interface RestreamerSource {
  kind: RestreamerSourceKind;
  /** rtmp/browser: internal ingest stream name */
  name?: string;
  /** file: path on the Restreamer's own filesystem */
  path?: string;
  loop?: boolean;
  silentAudio?: boolean;
  /** browser: the page to render */
  url?: string;
  width?: number;
  height?: number;
  frameRate?: string;
  videoBitrate?: string;
  renderer?: { url: string; token?: string; sourceId?: string };
}

export interface RestreamerSourceProcess {
  processId: string;
  provisioned: boolean;
  running: boolean;
  exec?: string;
  lastLog?: string;
}

export interface RestreamerRendererState {
  reachable: boolean;
  loadedUrl?: string;
  publishing?: boolean;
  error?: string;
}

export interface RestreamerChannel {
  channelId: string;
  processId: string;
  provisioned: boolean;
  running: boolean;
  exec?: string;
  lastLog?: string;
  ingestPushUrl: string;
  monitorUrl: string;
  destinations: RestreamerDestination[];
  source: RestreamerSource;
  sourceProcess?: RestreamerSourceProcess;
  renderer?: RestreamerRendererState;
}

export interface MediaPoolItem {
  slotIndex: number;
  isUsed: boolean;
  name: string;
}
export interface MediaPool {
  stills: MediaPoolItem[];
  clips: MediaPoolItem[];
}

export interface LevelPacket {
  id: string;
  audio: AudioLevels;
}

export type ServerMessage =
  | { type: 'snapshot'; devices: DeviceSnapshot[] }
  | { type: 'device'; device: DeviceSnapshot }
  | { type: 'levels'; levels: LevelPacket[] }
  | { type: 'toast'; level: 'info' | 'error'; text: string };

export type ClientMessage =
  | { type: 'record'; id: string; action: 'start' | 'stop' }
  | { type: 'stream'; id: string; action: 'start' | 'stop' }
  | { type: 'recordMode'; id: string; mode: RecordMode }
  | { type: 'monitorMute'; id: string; muted: boolean };
