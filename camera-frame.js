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

  function reply(message) {
    if (!port) return;
    port.postMessage(message);
  }

  async function startCamera() {
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
    // this runs, but never leave a recorder attached to tracks about to die.
    if (mediaRecorder) {
      mediaRecorder.stop();
    }
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

  function startRecording() {
    if (mediaRecorder || !stream) return;
    if (!video.videoWidth || !video.videoHeight) {
      // Camera just started and hasn't produced a frame yet — report it
      // instead of silently no-op'ing, so content.js's optimistic
      // "recording" UI gets rolled back rather than stuck on.
      reply({ type: 'GLIMP_RECORD_ERROR', message: 'Camera not ready yet' });
      return;
    }

    // MediaRecorder records raw track pixels — it can't apply the mirror the
    // live preview gets from a CSS transform. Recording from a canvas we
    // redraw mirrored every frame (same flip captureFrame() already does for
    // photos) is the only way to get a mirrored file out of it.
    recordingCanvas = document.createElement('canvas');
    recordingCanvas.width = video.videoWidth;
    recordingCanvas.height = video.videoHeight;
    recordingCtx = recordingCanvas.getContext('2d');
    recordingRafId = requestAnimationFrame(drawMirroredFrame);

    recordedChunks = [];
    try {
      mediaRecorder = new MediaRecorder(recordingCanvas.captureStream(30), { mimeType: 'video/webm' });
    } catch (err) {
      cancelAnimationFrame(recordingRafId);
      recordingRafId = null;
      recordingCanvas = null;
      recordingCtx = null;
      reply({ type: 'GLIMP_RECORD_ERROR', message: err && err.message });
      return;
    }

    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        recordedChunks.push(event.data);
      }
    };
    mediaRecorder.onstop = () => {
      cancelAnimationFrame(recordingRafId);
      recordingRafId = null;
      recordingCanvas = null;
      recordingCtx = null;
      const blob = new Blob(recordedChunks, { type: 'video/webm' });
      recordedChunks = [];
      mediaRecorder = null;
      reply({ type: 'GLIMP_RECORDING_STOPPED', blob });
    };
    mediaRecorder.start();
  }

  function stopRecording() {
    if (!mediaRecorder) return;
    mediaRecorder.stop();
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

    reply({ type: 'GLIMP_CAPTURED', dataUrl: canvas.toDataURL('image/png') });
  }

  function handlePortMessage(event) {
    const data = event.data;
    if (!data) return;

    if (data.type === 'GLIMP_START') startCamera();
    else if (data.type === 'GLIMP_STOP') stopCamera();
    else if (data.type === 'GLIMP_CAPTURE') captureFrame();
    else if (data.type === 'GLIMP_RECORD_START') startRecording();
    else if (data.type === 'GLIMP_RECORD_STOP') stopRecording();
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
