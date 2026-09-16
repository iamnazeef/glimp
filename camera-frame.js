(() => {
  const video = document.getElementById('frame-video');
  let stream = null;
  let port = null;
  let stopRequested = false;
  let starting = false;
  let mediaRecorder = null;
  let recordedChunks = [];
  let recordingCanvas = null;
  let recordingCtx = null;
  let recordingRafId = null;
  let recordingStarting = false;
  let recordingStopRequested = false;
  let micStream = null;
  let micStartPromise = null;
  let micStopRequested = false;

  function reply(message) {
    if (!port) return;
    port.postMessage(message);
  }

  // Mic hardware has a real ramp-up delay after getUserMedia resolves — audio
  // requested only once R is pressed lands a beat or two of silence at the
  // start of every recording. Acquiring it as soon as the camera itself
  // starts (including the Cmd/Ctrl+Shift prewarm, before L even lands) gives
  // it time to settle before a recording can possibly begin.
  function prewarmMic() {
    if (micStream) return Promise.resolve(micStream);
    if (micStartPromise) return micStartPromise;

    micStopRequested = false;
    micStartPromise = navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((acquired) => {
        if (micStopRequested) {
          micStopRequested = false;
          acquired.getTracks().forEach((track) => track.stop());
          return null;
        }
        micStream = acquired;
        return acquired;
      })
      .catch((err) => {
        console.error('Glimp: microphone prewarm failed', err);
        return null;
      })
      .finally(() => {
        micStartPromise = null;
      });
    return micStartPromise;
  }

  function stopMic() {
    if (micStream) {
      micStream.getTracks().forEach((track) => track.stop());
      micStream = null;
    } else if (micStartPromise) {
      micStopRequested = true;
    }
  }

  async function startCamera() {
    // Fire-and-forget: runs alongside the video negotiation below, not
    // blocking on it.
    prewarmMic();

    if (stream) {
      reply({ type: 'GLIMP_STARTED' });
      return;
    }
    // A getUserMedia negotiation is already in flight (e.g. the prewarm on
    // Cmd/Ctrl+Shift, followed moments later by the real start on L) — let
    // that one finish rather than opening a second, independent stream that
    // nothing would ever stop.
    if (starting) return;

    starting = true;
    stopRequested = false;
    try {
      // The preview is only ever shown at 320x240 CSS px, so ask for a small
      // format instead of letting the camera negotiate its own (often higher,
      // slower to initialize) default.
      const acquired = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 } },
      });

      // A stop can arrive while getUserMedia was still negotiating (e.g. the
      // prewarm was cancelled). Tear it straight back down instead of
      // letting the camera turn on after the user already backed out.
      if (stopRequested) {
        stopRequested = false;
        acquired.getTracks().forEach((track) => track.stop());
        return;
      }

      stream = acquired;
      video.srcObject = stream;
      reply({ type: 'GLIMP_STARTED' });
    } catch (err) {
      reply({ type: 'GLIMP_ERROR', message: err && err.message });
    } finally {
      starting = false;
    }
  }

  function stopCamera() {
    // Defensive: recording is always stopped explicitly by content.js before
    // this runs, but never leave a recorder (or an in-flight mic request)
    // attached to a camera that's about to die.
    stopRecording();
    stopMic();
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
      video.srcObject = null;
    } else {
      stopRequested = true;
    }
  }

  function drawMirroredFrame() {
    if (recordingCtx) {
      // A flip matrix set fresh every frame (rather than save/translate/scale
      // per draw) — cheap and correct since setTransform replaces, not
      // accumulates, the current transform.
      recordingCtx.setTransform(-1, 0, 0, 1, recordingCanvas.width, 0);
      recordingCtx.drawImage(video, 0, 0, recordingCanvas.width, recordingCanvas.height);
    }
    recordingRafId = requestAnimationFrame(drawMirroredFrame);
  }

  function teardownRecordingState() {
    cancelAnimationFrame(recordingRafId);
    recordingRafId = null;
    recordingCanvas = null;
    recordingCtx = null;
    // The mic stream is owned by the camera's lifecycle now (see prewarmMic),
    // not the recording's — leave it running so back-to-back recordings in
    // the same session reuse the already-warm stream instead of re-prompting
    // ramp-up delay each time. stopCamera() is what tears it down.
  }

  async function startRecording() {
    if (mediaRecorder || recordingStarting || !stream) return;
    if (!video.videoWidth || !video.videoHeight) {
      // Camera just started and hasn't produced a frame yet — report it
      // instead of silently no-op'ing, so content.js's optimistic
      // "recording" UI gets rolled back rather than stuck on.
      reply({ type: 'GLIMP_RECORD_ERROR', message: 'Camera not ready yet' });
      return;
    }

    recordingStarting = true;
    recordingStopRequested = false;

    // MediaRecorder records raw track pixels — it can't apply the mirror the
    // live preview gets from a CSS transform. Recording from a canvas we
    // redraw mirrored every frame (same flip captureFrame() already does for
    // photos) is the only way to get a mirrored file out of it.
    recordingCanvas = document.createElement('canvas');
    recordingCanvas.width = video.videoWidth;
    recordingCanvas.height = video.videoHeight;
    recordingCtx = recordingCanvas.getContext('2d');
    recordingRafId = requestAnimationFrame(drawMirroredFrame);

    const tracks = recordingCanvas.captureStream(30).getVideoTracks();

    // Reuses the mic prewarmed in startCamera() so it's already past its
    // hardware ramp-up by now. Only actually waits on getUserMedia here if
    // recording started before that prewarm finished (e.g. an instant
    // Cmd/Ctrl+Shift+L+R). If it's denied or unavailable, fall back to a
    // silent recording instead of failing.
    const mic = await prewarmMic();
    if (mic) {
      // Force-unmute so a mute left on from a previous recording in this
      // session doesn't silently carry over into a fresh one.
      mic.getAudioTracks().forEach((track) => {
        track.enabled = true;
      });
      tracks.push(...mic.getAudioTracks());
    } else {
      console.error('Glimp: microphone unavailable, recording without audio');
    }

    // A stop (or the camera itself stopping) can land while getUserMedia for
    // the mic was still negotiating — tear everything down instead of
    // starting a recording nobody wants anymore.
    if (recordingStopRequested) {
      recordingStopRequested = false;
      recordingStarting = false;
      teardownRecordingState();
      return;
    }

    recordedChunks = [];
    try {
      mediaRecorder = new MediaRecorder(new MediaStream(tracks), { mimeType: 'video/webm' });
    } catch (err) {
      recordingStarting = false;
      teardownRecordingState();
      reply({ type: 'GLIMP_RECORD_ERROR', message: err && err.message });
      return;
    }

    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        recordedChunks.push(event.data);
      }
    };
    mediaRecorder.onstop = () => {
      teardownRecordingState();
      const blob = new Blob(recordedChunks, { type: 'video/webm' });
      recordedChunks = [];
      mediaRecorder = null;
      reply({ type: 'GLIMP_RECORDING_STOPPED', blob });
    };
    mediaRecorder.start();
    recordingStarting = false;
  }

  function stopRecording() {
    if (mediaRecorder) {
      mediaRecorder.stop();
      return;
    }
    if (recordingStarting) {
      recordingStopRequested = true;
    }
  }

  // Toggles track.enabled rather than stopping/restarting the mic — the
  // recorder keeps running the whole time, it just encodes silence while
  // muted, so there's no gap or restart glitch in the output file.
  function toggleMute() {
    if (!micStream) return;
    const tracks = micStream.getAudioTracks();
    if (!tracks.length) return;
    const nowEnabled = !tracks[0].enabled;
    tracks.forEach((track) => {
      track.enabled = nowEnabled;
    });
    reply({ type: 'GLIMP_MUTE_STATE', muted: !nowEnabled });
  }

  function captureFrame() {
    if (!stream || !video.videoWidth || !video.videoHeight) {
      reply({ type: 'GLIMP_CAPTURE_FAILED' });
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');

    // Mirror the captured image to match the on-screen preview.
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // A Blob (not a data URL) so the download goes through the exact same
    // code path as recordings — a data URL vs. blob URL download visibly
    // behaves differently in Chrome's own download-bubble UI.
    canvas.toBlob((blob) => {
      reply({ type: 'GLIMP_CAPTURED', blob });
    }, 'image/png');
  }

  function handlePortMessage(event) {
    const data = event.data;
    if (!data) return;

    if (data.type === 'GLIMP_START') startCamera();
    else if (data.type === 'GLIMP_STOP') stopCamera();
    else if (data.type === 'GLIMP_CAPTURE') captureFrame();
    else if (data.type === 'GLIMP_RECORD_START') startRecording();
    else if (data.type === 'GLIMP_RECORD_STOP') stopRecording();
    else if (data.type === 'GLIMP_TOGGLE_MUTE') toggleMute();
  }

  // Only the first handshake is accepted so a page script racing to open its
  // own competing channel into this frame can't hijack an already-bound session.
  window.addEventListener('message', (event) => {
    if (port) return;
    if (event.data && event.data.type === 'GLIMP_INIT' && event.ports && event.ports[0]) {
      port = event.ports[0];
      port.onmessage = handlePortMessage;
    }
  });
})();
