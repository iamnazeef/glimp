chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({
      url: chrome.runtime.getURL('permission.html')
    });
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'OPEN_PERMISSION_PAGE') {
    chrome.tabs.create({
      url: chrome.runtime.getURL('permission.html')
    });
    if (sendResponse) {
      sendResponse({ opened: true });
    }
  }
  return true;
});
