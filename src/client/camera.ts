/**
 * Browser camera ownership.
 *
 * The camera is opened ONLY after the user clicks the explicit consent
 * button (never on page load, never automatically). `stop()` releases every
 * track immediately — the browser's camera indicator goes out in the same
 * tick as the call.
 */

export type CameraErrorKind = "denied" | "unavailable" | "unknown";

export class CameraError extends Error {
  readonly kind: CameraErrorKind;
  constructor(kind: CameraErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export class CameraManager {
  private stream: MediaStream | undefined;
  private video: HTMLVideoElement | undefined;
  private onUnexpectedEnd: () => void = () => undefined;

  /** Register a callback fired if the camera ends unexpectedly mid-session. */
  setOnUnexpectedEnd(cb: () => void): void {
    this.onUnexpectedEnd = cb;
  }

  get isActive(): boolean {
    return this.stream !== undefined;
  }

  /**
   * Open the camera and show it in `video` (muted, playsinline — the
   * preview is a local view; nothing is recorded or uploaded by the page
   * itself. Frames sent to the server are handled per the consent copy).
   */
  async start(video: HTMLVideoElement): Promise<void> {
    if (this.stream) return;
    if (!("mediaDevices" in navigator) || !navigator.mediaDevices.getUserMedia) {
      throw new CameraError(
        "unavailable",
        "This browser has no camera access. You can still use the breathing guide without one.",
      );
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          facingMode: "user",
        },
        audio: false,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        throw new CameraError(
          "denied",
          "The camera permission was not granted. You can allow it in your browser settings and try again, or continue without the camera.",
        );
      }
      if (err instanceof DOMException && err.name === "NotFoundError") {
        throw new CameraError(
          "unavailable",
          "No camera was found on this device. You can still use the breathing guide without one.",
        );
      }
      throw new CameraError("unknown", "The camera could not be opened. You can try again.");
    }

    this.stream = stream;
    this.video = video;
    video.srcObject = stream;
    for (const track of stream.getVideoTracks()) {
      track.addEventListener("ended", () => {
        // Unplugged / revoked by the OS: treat like a stop, and tell the UI.
        if (this.stream === stream) {
          this.stream = undefined;
          this.onUnexpectedEnd();
        }
      });
    }
    await video.play().catch(() => undefined);
  }

  /** Release the camera immediately. Safe to call when already stopped. */
  stop(): void {
    if (!this.stream) return;
    for (const track of this.stream.getVideoTracks()) {
      track.stop();
    }
    this.stream = undefined;
    if (this.video) {
      this.video.srcObject = null;
      this.video = undefined;
    }
  }
}
