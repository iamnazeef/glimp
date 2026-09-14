(() => {
  if (window.__glimpInstalled) return;
  window.__glimpInstalled = true;

  const WRAPPER_ID = 'glimp-camera-wrapper';
  const VIDEO_ID = 'glimp-camera-video';
  const PLACEHOLDER_ID = 'glimp-camera-placeholder';
  const SHUTTER_ID = 'glimp-camera-shutter';
  const EXTENSION_ORIGIN = chrome.runtime.getURL('').replace(/\/$/, '');

  let wrapper = null;
  let video = null;
  let placeholder = null;
  let shutter = null;
  let isVisible = false;
  let stopTimeout = null;
  let permissionDenied = false;

  let channel = null;
  let frameReady = false;
  let pendingStart = false;
  let cameraActive = false;

  function isLKey(event) {
    return event.code === 'KeyL' || (event.key && event.key.toLowerCase() === 'l');
  }

  function isModifierHeld(event) {
    return event.ctrlKey || event.metaKey;
  }

  function isShortcutKey(event) {
    return (
      isLKey(event) ||
      event.code === 'ControlLeft' ||
      event.code === 'ControlRight' ||
      event.code === 'ShiftLeft' ||
      event.code === 'ShiftRight' ||
      event.code === 'MetaLeft' ||
      event.code === 'MetaRight'
    );
  }

  function createOverlay() {
    if (document.getElementById(WRAPPER_ID)) return;

    wrapper = document.createElement('div');
    wrapper.id = WRAPPER_ID;
    wrapper.setAttribute('role', 'dialog');
    wrapper.setAttribute('aria-label', 'Camera preview');

    // The camera lives in an extension-origin iframe (not a <video> fed by a
    // page-scoped getUserMedia call) so the permission grant is tied to this
    // extension's own origin and persists across every site instead of
    // re-prompting per site.
    video = document.createElement('iframe');
    video.id = VIDEO_ID;
    video.setAttribute('allow', 'camera');
    video.setAttribute('frameborder', '0');
    video.addEventListener('load', initFrameChannel, { once: true });
    video.src = chrome.runtime.getURL('camera-frame.html');

    placeholder = document.createElement('div');
    placeholder.id = PLACEHOLDER_ID;
    const spinner = document.createElement('div');
    spinner.className = 'glimp-spinner';
    placeholder.appendChild(spinner);

    shutter = document.createElement('div');
    shutter.id = SHUTTER_ID;

    wrapper.appendChild(video);
    wrapper.appendChild(placeholder);
    wrapper.appendChild(shutter);

    if (document.body) {
      document.body.appendChild(wrapper);
    } else {
      document.documentElement.appendChild(wrapper);
    }
  }

  function initFrameChannel() {
    channel = new MessageChannel();
    channel.port1.onmessage = handleFrameMessage;
    frameReady = true;
    video.contentWindow.postMessage({ type: 'GLIMP_INIT' }, EXTENSION_ORIGIN, [channel.port2]);

    if (pendingStart) {
      pendingStart = false;
      sendStart();
    }
  }

  function handleFrameMessage(event) {
    const data = event.data;
    if (!data) return;

    if (data.type === 'GLIMP_STARTED') {
      cameraActive = true;
      permissionDenied = false;
      if (video) video.classList.add('glimp-active');
    } else if (data.type === 'GLIMP_ERROR') {
      cameraActive = false;
      console.error('Glimp camera error:', data.message);
      if (!permissionDenied) {
        permissionDenied = true;
        openPermissionPage();
      }
      hideOverlay(true);
    } else if (data.type === 'GLIMP_CAPTURED') {
      downloadCapture(data.dataUrl);
    }
  }

  function sendStart() {
    if (!channel) return;
    channel.port1.postMessage({ type: 'GLIMP_START' });
  }

  function startCamera() {
    if (cameraActive) return;
    if (!frameReady) {
      pendingStart = true;
      return;
    }
    sendStart();
  }

  function stopCamera() {
    if (channel && cameraActive) {
      channel.port1.postMessage({ type: 'GLIMP_STOP' });
    }
    cameraActive = false;
    if (video) {
      video.classList.remove('glimp-active');
    }
  }

  function showOverlay() {
    clearTimeout(stopTimeout);
    createOverlay();
    isVisible = true;
    if (wrapper) {
      wrapper.classList.add('glimp-active');
    }
    startCamera();
  }

  function hideOverlay(immediate = false) {
    isVisible = false;
    if (wrapper) {
      wrapper.classList.remove('glimp-active');
    }

    clearTimeout(stopTimeout);
    if (immediate) {
      stopCamera();
    } else {
      // Keep the camera warm for 1 second so quick re-opens are instant.
      stopTimeout = setTimeout(() => stopCamera(), 1000);
    }
  }

  function triggerShutter() {
    if (!shutter) return;
    shutter.classList.remove('glimp-active');
    // Force reflow so the animation can restart if triggered rapidly.
    void shutter.offsetWidth;
    shutter.classList.add('glimp-active');
  }

  function captureImage() {
    if (!cameraActive || !channel) return;

    triggerShutter();
    playCaptureSound();
    channel.port1.postMessage({ type: 'GLIMP_CAPTURE' });
  }

  function downloadCapture(dataUrl) {
    if (!dataUrl) return;

    const filename = `glimp-${Date.now()}.png`;
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function playCaptureSound() {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.08);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.08);
      setTimeout(() => ctx.close(), 200);
    } catch (e) {
      console.error('Glimp: failed to play capture sound', e);
    }
  }

  function openPermissionPage() {
    try {
      chrome.runtime.sendMessage({ type: 'OPEN_PERMISSION_PAGE' });
    } catch (e) {
      console.error('Glimp: failed to open permission page', e);
    }
  }

  document.addEventListener('keydown', (event) => {
    if (event.repeat) return;

    if (isVisible && event.code === 'Enter') {
      event.preventDefault();
      captureImage();
      return;
    }

    if (isLKey(event) && isModifierHeld(event) && event.shiftKey && !isVisible) {
      event.preventDefault();
      showOverlay();
    }
  });

  document.addEventListener('keyup', (event) => {
    if (isVisible && isShortcutKey(event)) {
      hideOverlay();
    }
  });

  window.addEventListener('blur', () => {
    if (isVisible) {
      hideOverlay(true);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && isVisible) {
      hideOverlay(true);
    }
  });

  // Preload the overlay element as soon as the page is ready so the first
  // shortcut press opens instantly without waiting for DOM creation.
  createOverlay();
})();
