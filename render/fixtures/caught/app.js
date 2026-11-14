// The app catches its own mistake and shows it: no error reaches the console,
// and the page looks alive. Only what it says gives it away.
const rate = document.getElementById('rate')
try {
  document.getElementById('chart').textContent = '1.08'
  rate.textContent = '1 EUR = 1.08 USD'
} catch (error) {
  rate.textContent = `Could not load rates: ${error.message}. Try again later.`
}
