declare module 'node-media-server' {
  /**
   * node-media-server ships no types, so this stub stands in for them. It must
   * track the INSTALLED major: v4 rewrote both halves of the surface below, and
   * because the stub is hand-written nothing makes that mismatch a type error.
   * A stub left on v2 typechecks perfectly and crashes the process on the first
   * publish — see the handler signature note.
   */
  interface NmsConfig {
    /** listen address for every listener; unset means all interfaces */
    bind?: string;
    rtmp?: { port: number };
    http?: { port: number };
    /** v4's JSON store (relay tasks, record metadata, history); defaults to ./data */
    store?: { path?: string };
  }

  /**
   * v4 emits ONE session object per event, where v2 emitted
   * `(id, streamPath, args)`. Only the fields used here are declared.
   */
  interface NmsSession {
    id: string;
    streamPath: string;
  }

  type NmsHandler = (session: NmsSession) => void;

  export default class NodeMediaServer {
    constructor(config: NmsConfig);
    /**
     * Went async inside v4 (4.2 returns undefined, 4.4 returns a promise once
     * it awaits the store), so these are typed as either — see how
     * MediaServer.start() calls them.
     */
    run(): Promise<void> | void;
    stop(): Promise<void> | void;
    on(event: string, handler: NmsHandler): void;
  }
}
