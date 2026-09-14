(() => {
  const video = document.getElementById('frame-video');
  let stream = null;
  let port = null;

  function reply(message) {
    if (!port) return;
    port.postMessage(message);
  }

  async function startCamera() {
    if (stream) {
      reply({ type: 'GLIMP_STARTED' });
      return;
    }

    try {
      // The preview is only ever shown at 320x240 CSS px, so ask for a small
      // format instead of letting the camera negotiate its own (often higher,
      // slower to initialize) default.
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 } },
      });
      video.srcObject = stream;
      reply({ type: 'GLIMP_STARTED' });
    } catch (err) {
      reply({ type: 'GLIMP_ERROR', message: err && err.message });
    }
  }

  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }
    video.srcObject = null;
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
