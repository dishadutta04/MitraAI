"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type VoiceInputStatus = "idle" | "listening" | "transcribing" | "unsupported" | "denied" | "error";

/**
 * Where speech becomes text:
 * - "browser": the browser's own speech recognition (Chrome, Edge, Safari, Samsung Internet).
 *   Words appear live while the user speaks.
 * - "server": everywhere else (Firefox, Brave, in-app browsers). The mic is recorded here,
 *   converted to a 16 kHz WAV and transcribed by the Mitra backend after the user stops.
 */
export type VoiceEngine = "browser" | "server";

export type VoiceLanguage = "en-IN" | "hi-IN";

export const VOICE_LANGUAGES: { value: VoiceLanguage; label: string }[] = [
  { value: "en-IN", label: "English / Hinglish" },
  { value: "hi-IN", label: "Hindi" },
];

/** Longest one recording can run — enough to read out a full monthly list. */
const MAX_LISTEN_MS = 3 * 60_000;
/** Stop by itself after this much silence (counted from the start if nothing was said yet). */
const SILENCE_STOP_MS = 12_000;
/** Pause before re-opening the mic after the browser ends a session, so restarts don't hammer it. */
const RESTART_DELAY_MS = 250;
/**
 * Some browsers expose speech recognition but never actually start it (Chromium
 * builds without Google's speech service): no start event, no error, just
 * silence. If it hasn't started by then, Mitra's own engine takes over.
 */
const BROWSER_START_TIMEOUT_MS = 3_000;
/** Mic level (RMS, 0..1) above which the server recorder counts sound as speech. */
const SPEECH_LEVEL = 0.02;
const SERVER_SAMPLE_RATE = 16_000;

/** Browser speech errors that mean "this browser's speech service won't work here" — switch to the server. */
const BROWSER_SERVICE_ERRORS = new Set(["network", "service-not-allowed"]);

/** What went wrong, in words the user can act on (status === "error"). */
function describeError(code: string): string {
  switch (code) {
    case "language-not-supported":
      return "This browser can't recognise that language — try the other one.";
    case "audio-capture":
      return "No microphone found. Plug one in or check it isn't used by another app.";
    case "server-unavailable":
      return "Mitra's speech service isn't reachable right now — please type your order instead.";
    default:
      return "Voice typing stopped unexpectedly — tap the mic to try again.";
  }
}

/**
 * Joins a session's final results into one transcript. Desktop Chrome sends
 * each phrase once; Android Chrome in continuous mode re-sends the whole
 * sentence so far as each new final result ("rice", "rice 5kg", "rice 5kg
 * 60"), which plain appending would turn into "rice rice 5kg rice 5kg 60".
 */
export function joinFinals(finals: string[]): string {
  let text = "";
  for (const raw of finals) {
    const part = raw.trim();
    if (!part) continue;
    if (part.toLowerCase().startsWith(text.toLowerCase())) text = part; // cumulative repeat
    else if (!text.toLowerCase().endsWith(part.toLowerCase())) text = `${text} ${part}`.trim();
  }
  return text;
}

function pickEngine(): VoiceEngine | null {
  if (typeof window === "undefined") return null;
  const hasBrowserSpeech = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  // Brave exposes the API but blocks Google's speech service, so it always fails with "network".
  const isBrave = !!(navigator as Navigator & { brave?: unknown }).brave;
  if (hasBrowserSpeech && !isBrave) return "browser";
  if (canRecord()) return "server";
  return null;
}

function canRecord(): boolean {
  return (
    typeof window !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    !!(window.AudioContext || (window as Window & { webkitAudioContext?: unknown }).webkitAudioContext)
  );
}

/**
 * Mic samples at the browser's rate -> 16 kHz 16-bit PCM, chunk by chunk.
 * Averages each group of input samples (which also filters out frequencies
 * the lower rate can't hold) and carries leftovers into the next chunk.
 */
class Downsampler {
  private pending = new Float32Array(0);
  private readonly ratio: number;

  constructor(rate: number) {
    this.ratio = rate / SERVER_SAMPLE_RATE;
  }

  push(chunk: Float32Array): Int16Array {
    const input = new Float32Array(this.pending.length + chunk.length);
    input.set(this.pending);
    input.set(chunk, this.pending.length);
    const outLength = Math.floor(input.length / this.ratio);
    const pcm = new Int16Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const start = Math.floor(i * this.ratio);
      const end = Math.min(input.length, Math.floor((i + 1) * this.ratio));
      let sum = 0;
      for (let j = start; j < end; j++) sum += input[j]!;
      const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
      pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    this.pending = input.slice(Math.floor(outLength * this.ratio));
    return pcm;
  }
}

/** How long to wait for the live stream's final text before re-sending the whole recording. */
const FINAL_TEXT_TIMEOUT_MS = 10_000;

/** Mono Float32 chunks at `rate` -> 16 kHz 16-bit mono WAV. */
function encodeWav(chunks: Float32Array[], rate: number): Blob {
  const length = chunks.reduce((n, c) => n + c.length, 0);
  const input = new Float32Array(length);
  let offset = 0;
  for (const c of chunks) {
    input.set(c, offset);
    offset += c.length;
  }

  const pcm = new Downsampler(rate).push(input);

  const buffer = new ArrayBuffer(44 + pcm.byteLength);
  const view = new DataView(buffer);
  const writeString = (at: number, s: string) => [...s].forEach((ch, k) => view.setUint8(at + k, ch.charCodeAt(0)));
  writeString(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SERVER_SAMPLE_RATE, true);
  view.setUint32(28, SERVER_SAMPLE_RATE * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  new Int16Array(buffer, 44).set(pcm);
  return new Blob([buffer], { type: "audio/wav" });
}

/**
 * Mic-to-text for Mitra's voice orders — same input flow as CloseBy's
 * "Ask AI to shop", extended to browsers without built-in speech recognition.
 *
 * Browser engine: listens in continuous mode so pauses between words don't
 * end the recording; browsers still end a session on their own after a
 * while, so it silently restarts until the user taps stop, stays quiet for
 * SILENCE_STOP_MS, or MAX_LISTEN_MS runs out. `onFinal` gets each new phrase.
 *
 * Server engine: streams the mic to `${apiBase}/api/v1/voice/stream` while
 * recording, so the words heard so far show up live in `interimTranscript`;
 * when recording stops, `onFinal` gets the whole transcript once. If the live
 * stream isn't available, the recording is posted to /voice/transcribe
 * instead. `level` (0..1) follows the mic so the UI can show it.
 *
 * `getToken` returns the signed-in user's session token for the server engine.
 */
export function useVoiceInput(language: VoiceLanguage, apiBase: string, getToken?: () => Promise<string | null>) {
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  const [engine, setEngine] = useState<VoiceEngine | null>(null);
  const [status, setStatus] = useState<VoiceInputStatus>("idle");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [level, setLevel] = useState(0);

  const onFinalRef = useRef<(text: string) => void>(() => {});
  /** True while the user wants the mic on — lets onend tell our stop from the browser's. */
  const wantListeningRef = useRef(false);
  const silenceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  /** Ends the current server recording; `send` false drops the audio. */
  const stopRecorderRef = useRef<((send: boolean) => void) | null>(null);
  const startWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startServerRef = useRef<() => void>(() => {});

  const clearStartWatchdog = () => {
    if (startWatchdogRef.current) clearTimeout(startWatchdogRef.current);
    startWatchdogRef.current = null;
  };

  // Pick the engine after mount, so server and first client render match.
  useEffect(() => {
    const picked = pickEngine();
    setEngine(picked);
    if (!picked) setStatus("unsupported");
  }, []);

  const clearSilenceTimer = () => {
    if (silenceTimerRef.current) clearInterval(silenceTimerRef.current);
    silenceTimerRef.current = null;
  };

  // Stop and release everything if the component unmounts mid-listen.
  useEffect(() => {
    return () => {
      wantListeningRef.current = false;
      clearSilenceTimer();
      clearStartWatchdog();
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
      recognitionRef.current?.abort();
      stopRecorderRef.current?.(false);
    };
  }, []);

  const startBrowser = useCallback(() => {
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Ctor) return;

    // A second tap while a recording is still winding down must not leave two recognizers running.
    recognitionRef.current?.abort();
    if (restartTimerRef.current) clearTimeout(restartTimerRef.current);

    wantListeningRef.current = true;
    setStatus("listening");
    const startedAt = Date.now();
    let lastSpeechAt = startedAt;
    let everStarted = false;

    /** The browser's speech service isn't working here: keep recording with Mitra's own engine instead. */
    const fallBackToServer = () => {
      const failed = recognitionRef.current;
      recognitionRef.current = null; // ignore its late events
      failed?.abort();
      clearSilenceTimer();
      clearStartWatchdog();
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
      wantListeningRef.current = false;
      if (!canRecord()) {
        setErrorMessage(describeError("start-failed"));
        setStatus("error");
        return;
      }
      setEngine("server");
      setErrorMessage("");
      startServerRef.current();
    };

    clearStartWatchdog();
    startWatchdogRef.current = setTimeout(() => {
      if (!everStarted && wantListeningRef.current) fallBackToServer();
    }, BROWSER_START_TIMEOUT_MS);

    const finish = () => {
      wantListeningRef.current = false;
      clearSilenceTimer();
      recognitionRef.current?.stop();
    };

    clearSilenceTimer();
    silenceTimerRef.current = setInterval(() => {
      const now = Date.now();
      if (now - startedAt > MAX_LISTEN_MS || now - lastSpeechAt > SILENCE_STOP_MS) finish();
    }, 1000);

    const listen = () => {
      /** How much of this session's transcript was already handed to onFinal. */
      let sent = "";
      const recognition = new Ctor();
      recognition.lang = language;
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;

      recognition.onstart = () => {
        everStarted = true;
        clearStartWatchdog();
        setStatus("listening");
      };

      recognition.onresult = (event) => {
        if (recognitionRef.current !== recognition) return; // a replaced recognizer's late event
        // Rebuild from ALL results each time (not just from resultIndex):
        // that's the only way to spot Android's cumulative repeats.
        const finals: string[] = [];
        let interim = "";
        for (let i = 0; i < event.results.length; i++) {
          const result = event.results[i]!;
          if (result.isFinal) finals.push(result[0]?.transcript ?? "");
          else interim += result[0]?.transcript ?? "";
        }
        lastSpeechAt = Date.now();
        const full = joinFinals(finals);
        // Hand over only what's new since the last call; if the browser
        // rewrote earlier words, send nothing rather than a duplicate.
        const fresh = full.toLowerCase().startsWith(sent.toLowerCase()) ? full.slice(sent.length).trim() : "";
        if (full.length > sent.length) sent = full;
        const pending = interim.trim();
        setInterimTranscript(pending && !full.toLowerCase().endsWith(pending.toLowerCase()) ? pending : "");
        if (fresh) onFinalRef.current(fresh);
      };

      recognition.onerror = (event) => {
        if (recognitionRef.current !== recognition) return;
        // "no-speech"/"aborted" just mean a quiet stretch or our own
        // restart — keep going; anything else ends the recording.
        if (event.error === "no-speech" || event.error === "aborted") return;
        if (BROWSER_SERVICE_ERRORS.has(event.error)) {
          fallBackToServer();
          return;
        }
        wantListeningRef.current = false;
        clearSilenceTimer();
        clearStartWatchdog();
        if (event.error === "not-allowed" || event.error === "permission-denied") {
          setErrorMessage("");
          setStatus("denied");
        } else {
          setErrorMessage(describeError(event.error));
          setStatus("error");
        }
      };

      recognition.onend = () => {
        if (recognitionRef.current !== recognition) return;
        setInterimTranscript("");
        if (wantListeningRef.current && Date.now() - startedAt < MAX_LISTEN_MS) {
          // The browser ended the session on its own — pick up where it left off.
          restartTimerRef.current = setTimeout(() => {
            restartTimerRef.current = null;
            if (wantListeningRef.current) listen();
            else setStatus((prev) => (prev === "listening" ? "idle" : prev)); // stopped by the silence timer mid-gap
          }, RESTART_DELAY_MS);
          return;
        }
        wantListeningRef.current = false;
        clearSilenceTimer();
        setStatus((prev) => (prev === "listening" ? "idle" : prev));
      };

      recognitionRef.current = recognition;
      try {
        recognition.start();
      } catch {
        fallBackToServer();
      }
    };

    listen();
  }, [language]);

  const startServer = useCallback(async () => {
    stopRecorderRef.current?.(false);
    wantListeningRef.current = true;
    setStatus("listening");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      const name = (err as DOMException)?.name;
      if (name === "NotAllowedError" || name === "SecurityError") {
        setErrorMessage("");
        setStatus("denied");
      } else {
        setErrorMessage(describeError("audio-capture"));
        setStatus("error");
      }
      return;
    }
    if (!wantListeningRef.current) {
      // Stopped while the browser was still asking for mic permission.
      stream.getTracks().forEach((t) => t.stop());
      setStatus("idle");
      return;
    }

    const AudioCtx = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!;
    const ctx = new AudioCtx();
    const source = ctx.createMediaStreamSource(stream);
    // ScriptProcessorNode is deprecated but is the one raw-audio tap every browser still supports.
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    const chunks: Float32Array[] = [];
    const startedAt = Date.now();
    let lastSpeechAt = startedAt;
    let heardSpeech = false;
    let stopped = false;

    // Live stream to the backend, so text appears while the user is still speaking.
    const downsampler = new Downsampler(ctx.sampleRate);
    const backlog: ArrayBuffer[] = [];
    let live: WebSocket | null = null;
    let liveOpen = false;
    let onLiveFinal: ((text: string | null) => void) | null = null;
    const settleLive = (text: string | null) => {
      const resolve = onLiveFinal;
      onLiveFinal = null;
      resolve?.(text);
    };
    const token = (await getTokenRef.current?.()) ?? "";
    try {
      live = new WebSocket(`${apiBase.replace(/^http/, "ws")}/api/v1/voice/stream?token=${encodeURIComponent(token)}`);
      live.binaryType = "arraybuffer";
      live.onopen = () => {
        liveOpen = true;
        for (const buf of backlog.splice(0)) live!.send(buf);
      };
      live.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data)) as { type: string; text?: string };
        if (msg.type === "partial") setInterimTranscript(msg.text ?? "");
        else if (msg.type === "final") settleLive(msg.text ?? "");
        else {
          liveOpen = false; // "error": server has no live engine; the recording is posted at the end
          settleLive(null);
        }
      };
      live.onerror = live.onclose = () => {
        liveOpen = false;
        settleLive(null);
      };
    } catch {
      live = null;
    }

    processor.onaudioprocess = (e) => {
      if (stopped) return;
      const data = e.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(data));
      const pcm = downsampler.push(data);
      if (live && pcm.length) {
        if (liveOpen) live.send(pcm.buffer);
        else if (live.readyState === WebSocket.CONNECTING) backlog.push(pcm.buffer as ArrayBuffer);
      }
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i]! * data[i]!;
      const rms = Math.sqrt(sum / data.length);
      setLevel(Math.min(1, rms * 8));
      if (rms > SPEECH_LEVEL) {
        lastSpeechAt = Date.now();
        heardSpeech = true;
      }
    };
    source.connect(processor);
    processor.connect(ctx.destination); // some browsers only run the processor while it's connected

    const stopRecorder = async (send: boolean) => {
      if (stopped) return;
      stopped = true;
      stopRecorderRef.current = null;
      clearSilenceTimer();
      processor.disconnect();
      source.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      const rate = ctx.sampleRate;
      void ctx.close();
      setLevel(0);

      if (!send || !heardSpeech) {
        live?.close();
        setInterimTranscript("");
        setStatus("idle");
        return;
      }
      setStatus("transcribing");

      let text: string | null = null;
      if (live && liveOpen) {
        text = await new Promise<string | null>((resolve) => {
          onLiveFinal = resolve;
          live!.send("end");
          setTimeout(() => settleLive(null), FINAL_TEXT_TIMEOUT_MS);
        });
      }
      live?.close();

      try {
        if (text === null) {
          // No live stream (or it dropped): send the whole recording instead.
          const res = await fetch(`${apiBase}/api/v1/voice/transcribe`, {
            method: "POST",
            headers: { "Content-Type": "audio/wav", Authorization: `Bearer ${(await getTokenRef.current?.()) ?? ""}` },
            body: encodeWav(chunks, rate),
          });
          if (!res.ok) throw new Error(String(res.status));
          text = ((await res.json()) as { text?: string }).text ?? "";
        }
        setInterimTranscript("");
        if (text.trim()) onFinalRef.current(text.trim());
        setStatus("idle");
      } catch {
        setInterimTranscript("");
        setErrorMessage(describeError("server-unavailable"));
        setStatus("error");
      }
    };
    stopRecorderRef.current = (send) => void stopRecorder(send);

    clearSilenceTimer();
    silenceTimerRef.current = setInterval(() => {
      const now = Date.now();
      if (now - startedAt > MAX_LISTEN_MS || now - lastSpeechAt > SILENCE_STOP_MS) void stopRecorder(true);
    }, 500);

    if (ctx.state === "suspended") await ctx.resume();
  }, [apiBase]);
  startServerRef.current = () => void startServer();

  const start = useCallback(
    (onFinal: (text: string) => void) => {
      if (!engine) {
        setStatus("unsupported");
        return;
      }
      onFinalRef.current = onFinal;
      setErrorMessage("");
      setInterimTranscript("");
      if (engine === "browser") startBrowser();
      else void startServer();
    },
    [engine, startBrowser, startServer],
  );

  /** Stop listening. With `discard`, whatever was recorded is thrown away instead of transcribed. */
  const stop = useCallback((discard = false) => {
    wantListeningRef.current = false;
    clearSilenceTimer();
    clearStartWatchdog();
    if (restartTimerRef.current) {
      // Stopped between two sessions: no onend is coming, so settle the status here.
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
      setStatus((prev) => (prev === "listening" ? "idle" : prev));
    }
    recognitionRef.current?.stop();
    stopRecorderRef.current?.(!discard);
  }, []);

  return { engine, status, interimTranscript, errorMessage, level, start, stop };
}
