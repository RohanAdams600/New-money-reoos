function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request to ${url} failed (${res.status})`);
  }
  return data;
}

async function loadStats() {
  try {
    const stats = await fetchJson('/api/stats');
    document.getElementById('metric-customers').textContent = stats.activeCustomers;
    document.getElementById('metric-total-leads').textContent = stats.totalLeads;
    document.getElementById('metric-hot').textContent = stats.hot;
    document.getElementById('metric-warm').textContent = stats.warm;
    document.getElementById('metric-cold').textContent = stats.cold;
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

async function loadBusinessInfo() {
  try {
    const info = await fetchJson('/api/business-info');
    const dl = document.getElementById('business-info');
    dl.innerHTML = `
      <div><dt>Company</dt><dd>${escapeHtml(info.name)}</dd></div>
      <div><dt>Website</dt><dd>${escapeHtml(info.website)}</dd></div>
      <div><dt>Contact</dt><dd>${escapeHtml(info.email)}</dd></div>
      <div><dt>Target Customer</dt><dd>${escapeHtml(info.targetCustomer)}</dd></div>
      <div><dt>Price</dt><dd>${escapeHtml(info.priceFormatted)}</dd></div>
      <div style="grid-column:1/-1"><dt>Description</dt><dd>${escapeHtml(info.description)}</dd></div>
      <div style="grid-column:1/-1"><dt>Pain Point Solved</dt><dd>${escapeHtml(info.painPoint)}</dd></div>
    `;
  } catch (err) {
    console.error('Failed to load business info:', err);
  }
}

function renderCustomerCard(customer) {
  const webhookAbsolute = `${window.location.origin}${customer.webhookUrl}`;
  return `
    <div class="customer-item">
      <div class="customer-header">
        <h3>${escapeHtml(customer.name)}</h3>
        <span class="webhook">${escapeHtml(webhookAbsolute)}</span>
      </div>
      <div>${escapeHtml(customer.description)}</div>
      <div class="lead-breakdown">
        <span class="badge hot">${customer.stats.hot} hot</span>
        <span class="badge warm">${customer.stats.warm} warm</span>
        <span class="badge cold">${customer.stats.cold} cold</span>
        <span>${customer.stats.total} total leads</span>
      </div>
    </div>
  `;
}

async function loadCustomers() {
  try {
    const customers = await fetchJson('/api/customers');
    const list = document.getElementById('customer-list');
    list.innerHTML = customers.length
      ? customers.map(renderCustomerCard).join('')
      : '<div class="empty-state">No customers yet — add one above to get a webhook URL.</div>';

    const select = document.getElementById('test-customer');
    const previousValue = select.value;
    select.innerHTML = customers.length
      ? customers.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('')
      : '<option value="">Add a customer first</option>';
    if (customers.some((c) => c.id === previousValue)) {
      select.value = previousValue;
    }
  } catch (err) {
    console.error('Failed to load customers:', err);
  }
}

function refreshAll() {
  loadStats();
  loadCustomers();
}

document.getElementById('customer-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = document.getElementById('customer-form-status');
  status.textContent = '';
  status.className = 'form-status';

  const payload = {
    name: document.getElementById('cust-name').value.trim(),
    description: document.getElementById('cust-description').value.trim(),
    icpSize: document.getElementById('cust-size').value.trim(),
    icpBudget: document.getElementById('cust-budget').value.trim(),
    qualifyingQuestions: document.getElementById('cust-questions').value,
  };

  try {
    const customer = await fetchJson('/api/customer/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    status.textContent = `Customer created. Webhook: ${window.location.origin}${customer.webhookUrl}`;
    status.className = 'form-status success';
    e.target.reset();
    refreshAll();
  } catch (err) {
    status.textContent = err.message;
    status.className = 'form-status error';
  }
});

document.getElementById('test-submit').addEventListener('click', async (e) => {
  e.preventDefault();
  const status = document.getElementById('test-form-status');
  const resultBox = document.getElementById('test-result');
  status.textContent = '';
  status.className = 'form-status';
  resultBox.classList.remove('visible');

  const customerId = document.getElementById('test-customer').value;
  const message = document.getElementById('test-message').value.trim();

  if (!customerId) {
    status.textContent = 'Add and select a customer first.';
    status.className = 'form-status error';
    return;
  }
  if (!message) {
    status.textContent = 'Paste a test lead message first.';
    status.className = 'form-status error';
    return;
  }

  const button = e.target;
  button.disabled = true;
  status.textContent = 'Classifying...';

  try {
    const result = await fetchJson(`/api/customer/${customerId}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });

    status.textContent = '';
    document.getElementById('test-badge').textContent = result.classification;
    document.getElementById('test-badge').className = `badge ${result.classification}`;
    document.getElementById('test-confidence').textContent = ` ${result.confidence}% confidence`;
    document.getElementById('test-company').textContent = result.company_name || '—';
    document.getElementById('test-problem').textContent = result.problem || '—';
    document.getElementById('test-budget').textContent = result.budget || '—';
    document.getElementById('test-response').textContent = result.response_text || '';
    resultBox.classList.add('visible');
  } catch (err) {
    status.textContent = err.message;
    status.className = 'form-status error';
  } finally {
    button.disabled = false;
  }
});

refreshAll();
loadBusinessInfo();
setInterval(refreshAll, 15000);
