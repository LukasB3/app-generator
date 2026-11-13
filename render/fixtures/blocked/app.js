// A published page may not fetch anything, its own files included.
fetch('quotes.json')
  .then((response) => response.json())
  .then((quotes) => (document.getElementById('quote').textContent = quotes[0]))
