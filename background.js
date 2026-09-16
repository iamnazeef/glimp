function openPermissionPage() {
  chrome.tabs.create({
    url: chrome.runtime.getURL('permission.html')
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    openPermissionPage();
  }
});

chrome.action.onClicked.addListener(() => {
  openPermissionPage();
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'OPEN_PERMISSION_PAGE') {
    openPermissionPage();
    if (sendResponse) {
      sendResponse({ opened: true });
    }
  }
  return true;
});
