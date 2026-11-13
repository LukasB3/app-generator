const count = document.getElementById('count')
document.getElementById('add').addEventListener('click', () => (count.textContent = String(Number(count.textContent) + 1)))
