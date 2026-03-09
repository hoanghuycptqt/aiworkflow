chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
    const el = document.getElementById('status');
    if (response && response.isActive) {
        el.className = 'status active';
        el.textContent = '✅ Active — Polling server at ' + response.serverUrl;
    } else {
        el.className = 'status inactive';
        el.textContent = '❌ Not connected';
    }
});
