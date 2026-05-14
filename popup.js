// popup.js - Extension popup UI handler

document.addEventListener('DOMContentLoaded', () => {
  const status = document.getElementById('status');

  function setStatus(message, type = 'info') {
    status.textContent = message;
    status.className = type;
  }

  // Test highlighting
  document.getElementById('testHighlight').addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      const response = await chrome.tabs.sendMessage(tab.id, {
        action: 'highlight',
        selector: 'h1'
      });
      
      if (response.success) {
        setStatus(`Highlighted: ${response.result.tagName}`, 'success');
      } else {
        setStatus('No h1 element found', 'error');
      }
    } catch (error) {
      setStatus(`Error: ${error.message}`, 'error');
    }
  });

  // Clear highlights
  document.getElementById('clearHighlights').addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      const response = await chrome.tabs.sendMessage(tab.id, {
        action: 'clearHighlights'
      });
      
      setStatus(`Cleared ${response.cleared} highlight(s)`, 'success');
    } catch (error) {
      setStatus(`Error: ${error.message}`, 'error');
    }
  });

  // Test native connection
  document.getElementById('testNative').addEventListener('click', async () => {
    try {
      setStatus('Connecting to native host...', 'info');
      
      const response = await chrome.runtime.sendMessage({
        toNative: {
          action: 'testHighlight'
        }
      });
      
      setStatus('Command sent to native host', 'success');
    } catch (error) {
      setStatus(`Native error: ${error.message}`, 'error');
    }
  });

  setStatus('Popup ready', 'success');
});
