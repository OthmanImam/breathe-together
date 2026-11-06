/**
 * Test double for `@smartspectra/node-sdk` — implements only the surface the
 * worker uses (constructor options, on(), useCustomInput, start, sendFrame,
 * stopAsync, destroy). Emits scripted validation + metrics so the worker's
 * real IPC path can be exercised end-to-end without an API key or camera.
 *
 * Emitted metrics buffers are opaque tokens; the worker's injected decoder
 * (in tests) maps them to decoded-metric objects. This file is never loaded
 * by production code paths: the worker uses it only when `BT_FAKE_SDK=1`.
 */

export const FAKE_METRICS_OK = "fake-metrics-ok";
export const FAKE_METRICS_EMPTY = "fake-metrics-empty";

export class FakeSmartSpectraSDK {
  static instances: FakeSmartSpectraSDK[] = [];
  framesReceived = 0;
  started = false;
  destroyed = false;

  private handlers = new Map<string, (...args: unknown[]) => void>();
  private frameTimer: NodeJS.Timeout | undefined;

  constructor(
    public readonly options: Record<string, unknown> = {},
  ) {
    FakeSmartSpectraSDK.instances.push(this);
  }

  on(event: string, cb: (...args: unknown[]) => void): this {
    this.handlers.set(event, cb);
    return this;
  }

  useCustomInput(): this {
    return this;
  }

  start(): void {
    this.started = true;
    this.emit("processingStatus", 2); // kStarting
    this.emit("processingStatus", 3); // kRunning
    this.emit("validationStatus", 0, Date.now() * 1000, "ok");
    this.frameTimer = setInterval(() => {
      this.emit("metrics", Buffer.from(FAKE_METRICS_OK), Date.now() * 1000);
    }, 200);
    this.frameTimer.unref();
  }

  sendFrame(): boolean {
    if (this.wedged) {
      throw new Error("SmartSpectra is not in a valid state for this operation.");
    }
    this.framesReceived++;
    return true;
  }

  /** Test hook: wedge the engine like kProcessingFailed does. */
  wedge(): void {
    this.wedged = true;
    this.emit("error", 8, "SmartSpectra processing failed.", true);
  }

  resetCount = 0;
  reset(): void {
    this.resetCount++;
    this.wedged = false;
  }

  private wedged = false;

  async stopAsync(): Promise<void> {
    this.startLogStop();
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.startLogStop();
  }

  private startLogStop(): void {
    if (this.frameTimer) clearInterval(this.frameTimer);
    this.frameTimer = undefined;
    this.started = false;
  }

  private emit(event: string, ...args: unknown[]): void {
    this.handlers.get(event)?.(...args);
  }
}

export const FakeSmartSpectra = {
  SmartSpectraSDK: FakeSmartSpectraSDK,
  FrameTransform: { kNone: 0 },
  PixelFormat: { kRGBA: 2 },
  breathingMetrics: [2],
  SmartSpectraLogLevel: { kWarning: 2 },
};
