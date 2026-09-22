import { EventEmitter } from 'node:events';
import { reverse as dnsReverse } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Atem, Enums } from 'atem-connection';
import type { SomeAtemAudioLevels } from 'atem-connection/dist/state/levels.js';
import type { DeviceConfig } from '../config.js';
import type { AudioLevels, DeviceSnapshot, MediaPool, RecordMode } from '../types.js';
import { normalize } from './normalize.js';
import type { DeviceRunner, StreamInfo, StreamingServiceInput } from './runner.js';

/**
 * A real Blackmagic ATEM, driven over atem-connection's UDP protocol.
 * Reconnects automatically (the library handles retry). Emits a normalized
 * snapshot on every state change and program-bus levels on every metering tick.
 */
export class RealDevice extends EventEmitter implements DeviceRunner {
  readonly id: string;
  readonly meta: DeviceConfig;
  private atem: Atem;
  private connection: DeviceSnapshot['connection'] = 'connecting';
  private getStream: (id: string) => StreamInfo;
  private hostname: string | null = null;
  private durationPoll: ReturnType<typeof setInterval> | null = null;

  constructor(meta: DeviceConfig, getStream: (id: string) => StreamInfo) {
    super();
    this.id = meta.id;
    this.meta = meta;
    this.getStream = getStream;
    // if the configured address is itself a hostname, use it directly
    if (isIP(meta.address) === 0) this.hostname = meta.address;
    this.atem = new Atem();

    this.atem.on('connected', () => {
      this.connection = 'connected';
      // ask the switcher to start streaming Fairlight meter data
      this.atem.startFairlightMixerSendLevels().catch(() => undefined);
      this.startDurationPolling();
      this.pushSnapshot();
    });
    this.atem.on('disconnected', () => {
      this.connection = 'disconnected';
      this.stopDurationPolling();
      this.pushSnapshot();
    });
    this.atem.on('stateChanged', () => this.pushSnapshot());
    this.atem.on('levelChanged', (levels: SomeAtemAudioLevels) => this.onLevels(levels));
    this.atem.on('error', (e) => this.emit('error', e));
  }

  async start(): Promise<void> {
    // best-effort reverse DNS so the device panel can show a hostname
    if (!this.hostname && isIP(this.meta.address) !== 0) {
      dnsReverse(this.meta.address)
        .then((names) => {
          if (names[0]) {
            this.hostname = names[0];
            this.pushSnapshot();
          }
        })
        .catch(() => undefined);
    }
    await this.atem.connect(this.meta.address);
  }

  async stop(): Promise<void> {
    this.stopDurationPolling();
    await this.atem.disconnect().catch(() => undefined);
  }

  /**
   * The ATEM only reports record/stream *duration* when asked — it doesn't push
   * a per-second tick. Without this the tile timer sits frozen at 00:00:00 for
   * the whole capture. So while a recording or stream is actually running, poll
   * the duration once a second; each reply updates state.{recording,streaming}
   * .duration and fires 'stateChanged', which re-pushes the snapshot. Idle the
   * rest of the time so we add no traffic when nothing is being captured.
   */
  private startDurationPolling(): void {
    if (this.durationPoll) return;
    this.durationPoll = setInterval(() => {
      const state = this.atem.state;
      if (!state) return;
      if (state.recording?.status?.state === Enums.RecordingStatus.Recording) {
        this.atem.requestRecordingDuration().catch(() => undefined);
      }
      if (state.streaming?.status?.state === Enums.StreamingStatus.Streaming) {
        this.atem.requestStreamingDuration().catch(() => undefined);
      }
    }, 1000);
    // don't keep the event loop alive just for this poll
    this.durationPoll.unref?.();
  }

  private stopDurationPolling(): void {
    if (this.durationPoll) {
      clearInterval(this.durationPoll);
      this.durationPoll = null;
    }
  }

  snapshot(): DeviceSnapshot {
    const stream = this.getStream(this.id);
    if (!this.atem.state) {
      return this.placeholder(stream);
    }
    return normalize(this.atem.state, {
      id: this.id,
      name: this.meta.name,
      address: this.meta.address,
      connection: this.connection,
      flvUrl: stream.flvUrl,
      live: stream.live,
      hostname: this.hostname,
    });
  }

  private placeholder(stream: StreamInfo): DeviceSnapshot {
    return {
      id: this.id,
      name: this.meta.name,
      address: this.meta.address,
      model: 'ATEM',
      connection: this.connection,
      record: { status: 'idle', mode: 'pgm', duration: null, filename: '', timeAvailable: 0 },
      stream: {
        status: 'idle',
        duration: null,
        bitrate: 0,
        cacheUsed: 0,
        serviceName: '',
        flvUrl: stream.flvUrl,
        live: stream.live,
      },
      disks: [],
      hostname: this.hostname,
      protocolVersion: '—',
      audio: { leftLevel: -100, rightLevel: -100, leftPeak: -100, rightPeak: -100 },
      monitorMuted: false,
      mediaPlayers: [],
      lastUpdate: Date.now(),
    };
  }

  private pushSnapshot(): void {
    this.emit('snapshot', this.snapshot());
  }

  private onLevels(levels: SomeAtemAudioLevels): void {
    if (levels.type !== 'master') return;
    const l = levels.levels;
    const audio: AudioLevels = {
      leftLevel: l.leftLevel,
      rightLevel: l.rightLevel,
      leftPeak: l.leftPeak,
      rightPeak: l.rightPeak,
    };
    this.emit('levels', audio);
  }

  // ---- commands ----

  /**
   * Refuse a command when the switcher is not actually connected.
   *
   * Without this, every write below reports success against a switcher that
   * was never reached. atem-connection only rejects with "Socket process is
   * not open" before `connect()` is called; once it has been — and the manager
   * calls it for every configured device at boot, then retries forever — a
   * command against an address that never answers is accepted and its promise
   * RESOLVES. The route returns `{ ok: true }` and the gear panel says "Local
   * streaming service applied to switcher" for a device that is greyed out and
   * offline in the same window.
   *
   * Verified against 192.168.12.104 on 2026-09-22: a reachable host that is
   * not an ATEM, `connected` never fired, setStreamingService resolved.
   */
  private connected(what: string): void {
    if (this.connection === 'connected') return;
    throw new Error(`${this.meta.name || this.id} is ${this.connection} — cannot ${what}`);
  }

  async setRecording(on: boolean): Promise<void> {
    this.connected(on ? 'start recording' : 'stop recording');
    await (on ? this.atem.startRecording() : this.atem.stopRecording());
  }

  async setStreaming(on: boolean): Promise<void> {
    this.connected(on ? 'start streaming' : 'stop streaming');
    await (on ? this.atem.startStreaming() : this.atem.stopStreaming());
  }

  async setRecordMode(mode: RecordMode): Promise<void> {
    this.connected(`set record mode to ${mode}`);
    await this.atem.setEnableISORecording(mode === 'iso');
  }

  async setMonitorMute(muted: boolean): Promise<void> {
    this.connected('set the monitor mute');
    await this.atem.setFairlightAudioMixerMonitorProps({ inputMasterMuted: muted });
  }

  async assignMediaPlayer(playerIndex: number, sourceType: 'still' | 'clip', slotIndex: number): Promise<void> {
    this.connected(`assign media player ${playerIndex + 1}`);
    await this.atem.setMediaPlayerSource(
      sourceType === 'still'
        ? { sourceType: Enums.MediaSourceType.Still, stillIndex: slotIndex }
        : { sourceType: Enums.MediaSourceType.Clip, clipIndex: slotIndex },
      playerIndex,
    );
  }

  async uploadStill(slotIndex: number, name: string, data: Buffer): Promise<void> {
    this.connected(`upload a still to slot ${slotIndex + 1}`);
    // `data` is raw RGBA at the switcher resolution (converted browser-side).
    await this.atem.uploadStill(slotIndex, data, name, '');
  }

  async setStreamingService(svc: StreamingServiceInput): Promise<void> {
    this.connected('apply the streaming service');
    await this.atem.setStreamingService({
      serviceName: svc.serviceName,
      url: svc.url,
      key: svc.key,
      bitrates: svc.bitrates,
    });
  }

  mediaPool(): MediaPool {
    const st = this.atem.state;
    const stills = (st?.media.stillPool ?? []).map((f, i) => ({
      slotIndex: i,
      isUsed: !!f?.isUsed,
      name: f?.fileName || `Still ${i + 1}`,
    }));
    const clips = (st?.media.clipPool ?? []).map((c, i) => ({
      slotIndex: i,
      isUsed: !!c?.isUsed,
      name: c?.name || `Clip ${i + 1}`,
    }));
    return { stills, clips };
  }
}
