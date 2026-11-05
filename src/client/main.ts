/**
 * Breathe Together browser app.
 *
 * Screen flow: consent -> setup -> session -> summary. Nothing here touches
 * the camera until the consent button is clicked, and consent is kept only
 * in page memory — a reload asks again, and Stop revokes it (ending the
 * session and releasing the camera immediately).
 *
 * The server is the source of truth for the coach; this client only renders
 * what it sends (pacer updates, samples, states, notices, summary lines).
 */

import { CameraError, CameraManager } from "./camera.js";
import { WsClient } from "./wsClient.js";
import { BreathingAudio } from "./audio.js";
import { DEFAULT_SETTINGS } from "../config.js";
import type {
  ClientSample,
  ServerMessage,
} from "../server/protocol.js";

const SCREENS = ["consent", "setup", "session", "summary"] as const;
type Screen = (typeof SCREENS)[number];

const STATE_LABELS: Record<string, string> = {
  calibrate: "Settling in",
  match: "Matching your pace",
  lead: "Slowing gently",
  hold: "Staying with you",
  cooldown: "Winding down",
  ended: "Done",
};

const STATUS_GUIDANCE: Record<string, string> = {
  starting: "Getting settled…",
  ok: "Looking good.",
  no_face: "Center your face in the frame.",
  off_center: "Center your face in the frame.",
  poor_light: "Move to better light.",
  lost: "No clear view — try adjusting your position.",
};

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element #${id}`);
  return found as T;
}

class App {
  private readonly camera = new CameraManager();
  private readonly ws = new WsClient();
  private readonly audio = new BreathingAudio();
  private readonly frameCanvas = document.createElement("canvas");
  private frameTimer: number | undefined;
  private rafId: number | undefined;

  private consentGranted = false;
  private sessionActive = false;
  private durationMin = 3 as 3 | 5 | 10;
  private sessionStartedAt = 0;
  private devScenario = "agitated_then_settling";
  private devControls = false;

  // Latest pacer snapshot for rAF interpolation between 10 Hz updates.
  private lastPacer: {
    rate: number;
    phase: "inhale" | "exhale";
    phaseProgress: number;
    receivedAt: number;
  } | undefined;

  constructor() {
    this.frameCanvas.width = 320;
    this.frameCanvas.height = 240;
    this.wireUi();
    this.ws.onMessage((m) => this.onServerMessage(m));
    this.ws.onState((s) => {
      if (s === "closed" && this.consentGranted) {
        this.handleDisconnect();
      }
    });
    this.ws.connect(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    this.ws.send({ type: "hello", clientVersion: "web-1" });
    this.showScreen("consent");
  }

  // -- UI wiring ------------------------------------------------------------

  private wireUi(): void {
    el<HTMLButtonElement>("consent-button").addEventListener("click", () =>
      void this.handleConsent(),
    );
    el<HTMLButtonElement>("stop-button").addEventListener("click", () =>
      this.handleStop(),
    );
    el<HTMLButtonElement>("begin-button").addEventListener("click", () =>
      this.handleBegin(),
    );
    el<HTMLButtonElement>("again-button").addEventListener("click", () => {
      this.showScreen("setup");
      this.ws.send({ type: "preview_start" });
    });
    el<HTMLButtonElement>("delete-button").addEventListener("click", () => {
      localStorage.removeItem("bt.history");
      el("delete-confirm").hidden = false;
    });

    const reduced = el<HTMLInputElement>("opt-reduced-motion");
    reduced.checked = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const saveHistory = el<HTMLInputElement>("opt-save-history");
    saveHistory.checked = localStorage.getItem("bt.historyEnabled") === "1";
    saveHistory.addEventListener("change", () => {
      localStorage.setItem("bt.historyEnabled", saveHistory.checked ? "1" : "0");
    });

    const volume = el<HTMLInputElement>("volume");
    this.audio.setVolume(Number(volume.value) / 100);
    volume.addEventListener("input", () => {
      this.audio.setVolume(Number(volume.value) / 100);
    });

    document
      .querySelectorAll<HTMLInputElement>('input[name="duration"]')
      .forEach((radio) =>
        radio.addEventListener("change", () => {
          if (radio.checked) this.durationMin = Number(radio.value) as 3 | 5 | 10;
        }),
      );

    el<HTMLSelectElement>("dev-scenario").addEventListener("change", (ev) => {
      this.devScenario = (ev.target as HTMLSelectElement).value;
      this.ws.send({ type: "set_scenario", scenario: this.devScenario });
    });

    this.camera.setOnUnexpectedEnd(() => {
      this.showError("The camera stopped unexpectedly. Stopping here — nothing was recorded.");
      this.handleStop(/* silent */ true);
    });

    // Hidden tabs: audio keeps its schedule (tones are the point of
    // eyes-closed sessions); the orb resyncs from server timestamps on
    // return because interpolation always measures against the last update.
    document.addEventListener("visibilitychange", () => undefined);
  }

  private showScreen(name: Screen): void {
    for (const s of SCREENS) {
      el(`screen-${s}`).hidden = s !== name;
    }
  }

  private showError(text: string): void {
    const err = el("camera-error");
    err.textContent = text;
    err.hidden = false;
  }

  // -- consent + camera -------------------------------------------------------

  private async handleConsent(): Promise<void> {
    el("camera-error").hidden = true;
    const video = el<HTMLVideoElement>("preview-video");
    try {
      await this.camera.start(video);
    } catch (err) {
      if (err instanceof CameraError) {
        this.showError(err.message);
      } else {
        this.showError("The camera could not be started. Nothing was opened.");
      }
      return;
    }
    this.consentGranted = true;
    this.ws.send({ type: "consent_granted" });
    el("camera-indicator").hidden = false;
    el("stop-button").hidden = false;
    this.showScreen("setup");
    this.ws.send({ type: "preview_start" });
    this.startFrameLoop();
  }

  private handleStop(silent = false): void {
    if (!silent) {
      this.ws.send({ type: "consent_revoked" });
    }
    this.audio.stop();
    this.camera.stop();
    this.stopFrameLoop();
    this.consentGranted = false;
    this.sessionActive = false;
    el("camera-indicator").hidden = true;
    el("stop-button").hidden = true;
    this.drawOrbIdle();
    this.showScreen("consent");
  }

  private handleDisconnect(): void {
    // The session cannot continue without the server; end safely and release
    // the camera rather than leaving it running.
    this.audio.stop();
    this.camera.stop();
    this.stopFrameLoop();
    this.consentGranted = false;
    this.sessionActive = false;
    el("camera-indicator").hidden = true;
    el("stop-button").hidden = true;
    this.showError("The connection was lost, so the session ended. The camera is off.");
    this.showScreen("consent");
  }

  // -- session ----------------------------------------------------------------

  private handleBegin(): void {
    this.sessionActive = true;
    this.sessionStartedAt = performance.now();
    // AudioContext may only start from a user gesture — Begin is that gesture.
    this.audio.ensureStarted();
    this.ws.send({
      type: "start_session",
      durationMin: this.durationMin,
      mode: "solo",
    });
    this.showScreen("session");
    el("session-notice").textContent = "";
    this.startOrbLoop();
  }

  private onServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "welcome": {
        this.devControls = msg.devControls;
        el("dev-panel").hidden = !msg.devControls;
        const note = el("source-note");
        if (msg.signalSourceNote) {
          note.textContent = msg.signalSourceNote;
          note.hidden = false;
        }
        break;
      }
      case "sample":
        this.onSample(msg.sample);
        break;
      case "pacer_update":
        this.lastPacer = {
          rate: msg.rate,
          phase: msg.phase,
          phaseProgress: msg.phaseProgress,
          receivedAt: performance.now(),
        };
        this.audio.onPacer(
          msg.phase,
          msg.rate,
          DEFAULT_SETTINGS.pacer.inhaleShare,
          this.audio.currentTime(),
        );
        this.renderSessionClock();
        break;
      case "state_changed":
        el("session-state").textContent = STATE_LABELS[msg.to] ?? "…";
        break;
      case "notice":
        el("session-notice").textContent = msg.text;
        break;
      case "session_end":
        this.sessionActive = false;
        this.stopOrbLoop();
        this.audio.stop();
        this.renderSummary(msg.lines);
        this.showScreen("summary");
        break;
      case "error":
        if (msg.code === "consent_required") {
          this.showError("Camera data is sent only after consent.");
        }
        break;
      default:
        break;
    }
  }

  private onSample(sample: ClientSample): void {
    if (!this.sessionActive) {
      // Setup preview guidance.
      const guidance = el("setup-guidance");
      const ready = el("setup-ready");
      guidance.textContent = STATUS_GUIDANCE[sample.status] ?? "";
      ready.hidden = sample.status !== "ok";
      return;
    }
    const rate = el("session-rate");
    rate.textContent =
      sample.breathingRate !== undefined
        ? `Your pace: about ${Math.round(sample.breathingRate)} breaths a minute`
        : "Your pace: —";
    const view = el("session-view");
    view.textContent =
      sample.status === "ok"
        ? "View: clear"
        : sample.status === "poor_light"
          ? "View: dim"
          : "View: unclear";
  }

  private renderSessionClock(): void {
    const elapsedSec = (performance.now() - this.sessionStartedAt) / 1000;
    const remaining = Math.max(0, this.durationMin * 60 - elapsedSec);
    const mm = Math.floor(remaining / 60);
    const ss = Math.floor(remaining % 60);
    el("session-time").textContent = `${mm}:${String(ss).padStart(2, "0")} left`;
  }

  // -- orb ----------------------------------------------------------------------

  private startOrbLoop(): void {
    this.stopOrbLoop();
    this.rafId = requestAnimationFrame(() => this.orbTick());
  }

  private stopOrbLoop(): void {
    if (this.rafId !== undefined) cancelAnimationFrame(this.rafId);
    this.rafId = undefined;
  }

  private drawOrbIdle(): void {
    el("orb").style.transform = "scale(1)";
  }

  private orbTick(): void {
    const orb = el("orb");
    const reduced = el<HTMLInputElement>("opt-reduced-motion").checked;
    const audioOnly = el<HTMLInputElement>("opt-audio-only").checked;
    const p = this.lastPacer;
    if (p) {
      const now = performance.now();
      const cycleMs = (60 / p.rate) * 1000;
      const inhaleMs = cycleMs * DEFAULT_SETTINGS.pacer.inhaleShare;
      const phaseMs = p.phase === "inhale" ? inhaleMs : cycleMs - inhaleMs;
      const extraMs = now - p.receivedAt;
      const progress = Math.min(
        1,
        p.phaseProgress + extraMs / Math.max(1, phaseMs),
      );
      const ease = (x: number) => x * x * (3 - 2 * x); // smoothstep
      const scale =
        p.phase === "inhale"
          ? 1 + 0.35 * ease(progress)
          : 1.35 - 0.35 * ease(progress);
      orb.style.transform = reduced ? `scale(${p.phase === "inhale" ? 1.35 : 1})` : `scale(${scale})`;
      const phaseText = el("session-phase");
      phaseText.textContent = audioOnly
        ? p.phase === "inhale"
          ? "Breathe in…"
          : "Breathe out…"
        : "";
      // Text alternative for the visual, kept current for assistive tech.
      orb.setAttribute(
        "aria-label",
        `Breathing guide: ${p.phase === "inhale" ? "breathe in" : "breathe out"}`,
      );
      el("orb").style.visibility = audioOnly ? "hidden" : "visible";
    }
    this.rafId = requestAnimationFrame(() => this.orbTick());
  }

  // -- frames ---------------------------------------------------------------------

  private startFrameLoop(): void {
    this.stopFrameLoop();
    const ctx = this.frameCanvas.getContext("2d");
    if (!ctx) return;
    this.frameTimer = window.setInterval(() => {
      const video = el<HTMLVideoElement>("preview-video");
      if (!this.camera.isActive || video.readyState < 2) return;
      ctx.drawImage(video, 0, 0, this.frameCanvas.width, this.frameCanvas.height);
      const img = ctx.getImageData(0, 0, this.frameCanvas.width, this.frameCanvas.height);
      // Monotonic µs for the SDK transport (performance.now is monotonic).
      this.ws.sendFrame(new Uint8Array(img.data.buffer), Math.round(performance.now() * 1000));
    }, Math.round(1000 / 15)); // 15 fps ceiling — the minimum the SDK needs, not 30
  }

  private stopFrameLoop(): void {
    if (this.frameTimer !== undefined) {
      clearInterval(this.frameTimer);
      this.frameTimer = undefined;
    }
  }

  // -- summary ----------------------------------------------------------------------

  private renderSummary(lines: string[]): void {
    const container = el("summary-lines");
    container.replaceChildren();
    for (const line of lines) {
      const p = document.createElement("p");
      p.textContent = line;
      container.appendChild(p);
    }
    // Opt-in history (OFF by default): only stored when the user enables it
    // in the future; "Delete my data" clears whatever is here.
    if (localStorage.getItem("bt.historyEnabled") === "1" && lines.length > 0) {
      try {
        const history = JSON.parse(localStorage.getItem("bt.history") ?? "[]") as unknown[];
        history.push({ at: new Date().toISOString(), lines });
        localStorage.setItem("bt.history", JSON.stringify(history));
      } catch {
        // Storage full/blocked: history is best-effort, never fatal.
      }
    }
    el("delete-confirm").hidden = true;
  }
}

new App();
