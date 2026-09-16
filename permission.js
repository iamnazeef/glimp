(() => {
  const video = document.getElementById('video');
  const enableBtn = document.getElementById('enableBtn');
  const status = document.getElementById('status');
  const spinner = document.getElementById('spinner');
  const placeholderText = document.getElementById('placeholderText');
  const modKeys = document.querySelectorAll('.mod-key');
  const permissionTip = document.getElementById('permissionTip');

  if (navigator.platform.toLowerCase().includes('mac') || navigator.userAgent.toLowerCase().includes('mac')) {
    modKeys.forEach((el) => {
      el.textContent = 'Cmd';
    });
  }

  let stream = null;

  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }
    if (video) {
      video.srcObject = null;
      video.classList.remove('active');
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopCamera();
    }
  });

  enableBtn.addEventListener('click', async () => {
    status.className = '';
    status.textContent = '';
    spinner.style.display = 'block';
    placeholderText.textContent = 'Requesting camera access...';
    enableBtn.disabled = true;

    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true });
      video.srcObject = stream;
      video.classList.add('active');

      status.textContent = 'Camera works on this page! On each website, allow access when Chrome asks.';
      status.className = 'success';
      if (permissionTip) permissionTip.style.display = 'none';
      enableBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
        </svg>
        Camera enabled
      `;
    } catch (err) {
      console.error('Glimp permission page: camera error', err);
      status.textContent = 'Permission denied. Please allow camera access in your browser and try again.';
      status.className = 'error';
      if (permissionTip) permissionTip.style.display = 'block';
      spinner.style.display = 'none';
      placeholderText.textContent = 'Camera preview';
      enableBtn.disabled = false;
    }
  });
})();
