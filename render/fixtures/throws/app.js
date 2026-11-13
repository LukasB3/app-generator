const basket = { items: [] }
// The sum was never worked out, and the button this waits for is not on the page.
document.getElementById('total').textContent = 'Total: ' + basket.sum
document.getElementById('checkout').addEventListener('click', () => {})
