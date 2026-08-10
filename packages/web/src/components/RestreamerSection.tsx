import { useEffect, useState } from 'react';
import type {
  RestreamerChannel,
  RestreamerDestination,
  RestreamerSource,
  RestreamerSourceKind,
  RestreamerStatus,
} from '../types';

let destSeq = 0;
const newId = () => `d${Date.now().toString(36)}${destSeq++}`;

const SOURCE_LABEL: Record<RestreamerSourceKind, string> = {
  rtmp: 'ATEM (RTMP in)',
  file: 'File playback',
  browser: 'Web page',
};

/** What the operator is told to do next, per source kind. The push URL is only
 *  the ATEM's business when the ATEM is what publishes. */
function sourceHint(source: RestreamerSource): string {
  switch (source.kind) {
    case 'file':
      return 'Restreamer plays the file into its own ingest — nothing needs to publish to it.';
    case 'browser':
      return 'WebLinked renders the page and publishes to the ingest below.';
    default:
      return 'Point the ATEM stream at the ingest below.';
  }
}

/**
 * Restreamer split-pipeline controls for one device, shown in the gear panel.
 * When enabled, the ATEM publishes to Restreamer (push URL shown here) which
 * copies the feed back to Overseer for the tile preview and fans it out to the
 * egress destinations managed below.
 */
export function RestreamerSection({ deviceId }: { deviceId: string }) {
  const [status, setStatus] = useState<RestreamerStatus | null>(null);
  const [channel, setChannel] = useState<RestreamerChannel | null>(null);
  const [dests, setDests] = useState<RestreamerDestination[]>([]);
  const [source, setSource] = useState<RestreamerSource>({ kind: 'rtmp' });
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const loadChannel = () =>
    fetch(`/api/devices/${deviceId}/restreamer`)
      .then((r) => r.json())
      .then((c: RestreamerChannel) => {
        setChannel(c);
        setDests(c.destinations ?? []);
        setSource(c.source ?? { kind: 'rtmp' });
      })
      .catch(() => undefined);

  useEffect(() => {
    fetch('/api/restreamer')
      .then((r) => r.json())
      .then((s: RestreamerStatus) => {
        setStatus(s);
        if (s.enabled) loadChannel();
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);

  const call = async (label: string, run: () => Promise<Response>) => {
    setBusy(true);
    setMsg(label);
    try {
      const r = await run();
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `${label} failed`);
      await loadChannel();
      setMsg('');
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const provision = () =>
    call('Provisioning…', () => fetch(`/api/devices/${deviceId}/restreamer/provision`, { method: 'POST' }));

  const teardown = () =>
    call('Tearing down…', () => fetch(`/api/devices/${deviceId}/restreamer`, { method: 'DELETE' }));

  const saveDests = () =>
    call('Saving destinations…', () =>
      fetch(`/api/devices/${deviceId}/restreamer/destinations`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ destinations: dests }),
      }),
    );

  const saveSource = () =>
    call('Saving source…', () =>
      fetch(`/api/devices/${deviceId}/restreamer/source`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source }),
      }),
    );

  const updateDest = (id: string, patch: Partial<RestreamerDestination>) =>
    setDests((ds) => ds.map((d) => (d.id === id ? { ...d, ...patch } : d)));

  const updateSource = (patch: Partial<RestreamerSource>) => setSource((s) => ({ ...s, ...patch }));

  /** Switching kind starts from that kind's defaults rather than carrying the
   *  previous kind's half-filled fields across, which the server would reject. */
  const changeKind = (kind: RestreamerSourceKind) => {
    if (kind === 'file') setSource({ kind, path: '', loop: true, silentAudio: false });
    else if (kind === 'browser') setSource({ kind, url: '', width: 1920, height: 1080, frameRate: '50' });
    else setSource({ kind: 'rtmp' });
  };

  if (!status) return null;

  if (!status.enabled) {
    return (
      <div className="section">
        <h3>Restreamer</h3>
        <p className="hint">
          Not configured. Add a <code>restreamer</code> block to the Overseer config to stream through
          Restreamer (a split that copies to this preview and fans out to the internet). No instance?
        </p>
        <div className="row-btns">
          <a className="toolbtn" href="/api/restreamer/compose" download>
            ⬇ docker-compose.yml
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="section">
      <h3>Restreamer</h3>
      <div className="assign-row">
        <span className={`ws-dot${status.reachable ? ' active' : ''}`} />
        <span className="hint">
          {status.url} — {status.reachable ? 'reachable' : 'unreachable'}
        </span>
        <span className="spacer" style={{ flex: 1 }} />
        {channel && (
          <span className={`chip ${channel.running ? 'live on' : channel.provisioned ? 'iso' : ''}`}>
            {channel.running ? 'RUNNING' : channel.provisioned ? 'PROVISIONED' : 'NOT PROVISIONED'}
          </span>
        )}
      </div>

      {channel && (
        <p className="hint">
          {sourceHint(source)}
          <br />
          Ingest:&nbsp;
          <code>{channel.ingestPushUrl}</code>{' '}
          <button
            className="applink"
            onClick={() => navigator.clipboard?.writeText(channel.ingestPushUrl).catch(() => undefined)}
          >
            copy
          </button>
          <br />
          Monitor copy → <code>{channel.monitorUrl}</code>
        </p>
      )}

      <h3 style={{ marginTop: 14 }}>Source</h3>
      <div className="assign-row">
        <select value={source.kind} onChange={(e) => changeKind(e.target.value as RestreamerSourceKind)}>
          {(status.sourceKinds ?? ['rtmp']).map((k) => (
            <option key={k} value={k}>
              {SOURCE_LABEL[k]}
            </option>
          ))}
        </select>
        <span style={{ flex: 1 }} />
        {channel?.sourceProcess && (
          <span className={`chip ${channel.sourceProcess.running ? 'live on' : ''}`}>
            {channel.sourceProcess.running
              ? 'PLAYING'
              : channel.sourceProcess.provisioned
                ? 'STOPPED'
                : 'NOT PROVISIONED'}
          </span>
        )}
        {channel?.renderer && (
          <span className={`chip ${channel.renderer.publishing ? 'live on' : ''}`}>
            {channel.renderer.reachable
              ? channel.renderer.publishing
                ? 'RENDERING'
                : 'RENDERER IDLE'
              : 'RENDERER UNREACHABLE'}
          </span>
        )}
      </div>

      {source.kind === 'file' && (
        <>
          <div className="dest-edit">
            <input
              type="text"
              placeholder="media/holding-slate.mp4"
              value={source.path ?? ''}
              style={{ flex: 1, minWidth: 200 }}
              onChange={(e) => updateSource({ path: e.target.value })}
            />
            <label className="hint">
              <input
                type="checkbox"
                checked={source.loop !== false}
                onChange={(e) => updateSource({ loop: e.target.checked })}
              />{' '}
              loop
            </label>
            <label className="hint">
              <input
                type="checkbox"
                checked={!!source.silentAudio}
                onChange={(e) => updateSource({ silentAudio: e.target.checked })}
              />{' '}
              add silent audio
            </label>
          </div>
          <p className="hint">
            Path is on the <em>Restreamer's</em> filesystem, not this machine's — a bare path is
            relative to its disk storage. Tick "add silent audio" for a file with no audio track;
            most platforms reject a video-only stream.
          </p>
        </>
      )}

      {source.kind === 'browser' && (
        <>
          <div className="dest-edit">
            <input
              type="text"
              placeholder="https://…"
              value={source.url ?? ''}
              style={{ flex: 1, minWidth: 200 }}
              onChange={(e) => updateSource({ url: e.target.value })}
            />
            <input
              type="number"
              title="width"
              value={source.width ?? 1920}
              style={{ width: 76 }}
              onChange={(e) => updateSource({ width: Number(e.target.value) })}
            />
            <input
              type="number"
              title="height"
              value={source.height ?? 1080}
              style={{ width: 76 }}
              onChange={(e) => updateSource({ height: Number(e.target.value) })}
            />
            <input
              type="text"
              title="frame rate"
              placeholder="50"
              value={source.frameRate ?? ''}
              style={{ width: 90 }}
              onChange={(e) => updateSource({ frameRate: e.target.value })}
            />
          </div>
          <p className="hint">
            Rendered by WebLinked at {status.rendererUrl ?? 'the renderer in the config'}, which
            publishes to the ingest above. Frame rate must be exact — <code>50</code> or{' '}
            <code>60000/1001</code>, never <code>59.94</code>.
            {channel?.renderer?.error && <> Renderer says: {channel.renderer.error}</>}
          </p>
        </>
      )}

      <div className="row-btns" style={{ marginTop: 8 }}>
        <button className="toolbtn" disabled={busy} onClick={saveSource}>
          Save source
        </button>
      </div>

      <h3 style={{ marginTop: 14 }}>Egress destinations</h3>
      {dests.length === 0 && <p className="hint">No destinations yet.</p>}
      {dests.map((d) => (
        <div key={d.id} className="dest-edit">
          <input
            type="checkbox"
            checked={d.enabled}
            title="enabled"
            onChange={(e) => updateDest(d.id, { enabled: e.target.checked })}
          />
          <input
            type="text"
            placeholder="Name"
            value={d.name}
            style={{ width: 110 }}
            onChange={(e) => updateDest(d.id, { name: e.target.value })}
          />
          <input
            type="text"
            placeholder="rtmp://…/app"
            value={d.url}
            style={{ flex: 1, minWidth: 160 }}
            onChange={(e) => updateDest(d.id, { url: e.target.value })}
          />
          <input
            type="text"
            placeholder="stream key"
            value={d.streamKey ?? ''}
            style={{ width: 120 }}
            onChange={(e) => updateDest(d.id, { streamKey: e.target.value })}
          />
          <button className="applink" onClick={() => setDests((ds) => ds.filter((x) => x.id !== d.id))}>
            ✕
          </button>
        </div>
      ))}

      <div className="row-btns" style={{ marginTop: 8 }}>
        <button
          className="toolbtn"
          onClick={() =>
            setDests((ds) => [...ds, { id: newId(), name: '', url: '', streamKey: '', enabled: true }])
          }
        >
          + Destination
        </button>
        <button className="toolbtn" disabled={busy} onClick={saveDests}>
          Save destinations
        </button>
        <span style={{ flex: 1 }} />
        <button className="toolbtn" disabled={busy} onClick={provision}>
          {channel?.provisioned ? 'Re-sync' : 'Provision'}
        </button>
        {channel?.provisioned && (
          <button className="toolbtn danger" disabled={busy} onClick={teardown}>
            Tear down
          </button>
        )}
      </div>

      {msg && <p className="hint" style={{ marginTop: 8 }}>{msg}</p>}
    </div>
  );
}
