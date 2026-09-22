/**
 * An ATEM with no recording media reports recordingTimeAvailable as
 * 0xFFFFFFFF, the protocol's "not applicable". Taken literally that is
 * "1193046h 28m", which rendered as a full green bar beside the words "No
 * media" on a live Mini Extreme ISO on 2026-09-22. Anything at or past the
 * sentinel is unknown, not plenty.
 */
const NO_MEDIA = 0xffffffff;

export function fmtRemaining(seconds: number): string {
  if (!seconds || seconds < 0 || seconds >= NO_MEDIA) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${seconds}s`;
}

export function fmtBitrate(bps: number): string {
  if (!bps) return '—';
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
  return `${Math.round(bps / 1000)} kbps`;
}

/** severity of a remaining-time value, for colour coding */
export function remainingLevel(seconds: number): '' | 'low' | 'crit' {
  // No media is not "loads of headroom" — it is the one case where hitting
  // Record does nothing at all, so it reads as critical, not full.
  if (seconds >= NO_MEDIA) return 'crit';
  if (seconds <= 0) return 'crit';
  if (seconds < 15 * 60) return 'crit';
  if (seconds < 60 * 60) return 'low';
  return '';
}

/** bar fill fraction, using 4h as a nominal "full" reference */
export function remainingFrac(seconds: number): number {
  if (seconds >= NO_MEDIA) return 0.02;
  return Math.max(0.02, Math.min(1, seconds / (4 * 3600)));
}
