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

async function loadConfig() {
  try {
    const config = await fetchJson('/api/config');
    document.getElementById('demo-banner').style.display = config.demoMode ? 'block' : 'none';
  } catch (err) {
    console.error('Failed to load config:', err);
  }
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

function renderPricingTier(tier) {
  return `
    <div class="pricing-tier ${tier.featured ? 'featured' : ''}">
      ${tier.featured ? '<div class="tier-flag">Target Plan</div>' : ''}
      <div class="tier-name">${escapeHtml(tier.name)}</div>
      <div class="tier-price">${escapeHtml(tier.priceFormatted)}</div>
      <div class="tier-tagline">${escapeHtml(tier.tagline)}</div>
      <ul class="tier-features">
        ${tier.features.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}
      </ul>
    </div>
  `;
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
      <div style="grid-column:1/-1"><dt>Description</dt><dd>${escapeHtml(info.description)}</dd></div>
      <div style="grid-column:1/-1"><dt>Pain Point Solved</dt><dd>${escapeHtml(info.painPoint)}</dd></div>
    `;

    const pricingEl = document.getElementById('pricing-tiers');
    if (pricingEl && Array.isArray(info.pricingTiers)) {
      pricingEl.innerHTML = info.pricingTiers.map(renderPricingTier).join('');
    }
  } catch (err) {
    console.error('Failed to load business info:', err);
  }
}

// Per-customer UI state (expanded/filter/editing) — kept outside the re-rendered
// markup so it survives the periodic refresh.
const customerUiState = {};
function getUiState(id) {
  if (!customerUiState[id]) {
    customerUiState[id] = { expanded: false, filter: 'all', editing: false };
  }
  return customerUiState[id];
}

function renderLeadRow(lead) {
  return `
    <tr>
      <td>${escapeHtml(new Date(lead.receivedAt).toLocaleString())}</td>
      <td><span class="badge ${lead.classification}">${lead.classification}</span></td>
      <td>${lead.confidence}%</td>
      <td>${escapeHtml(lead.companyName)}</td>
      <td>${escapeHtml(lead.problem)}</td>
      <td>${escapeHtml(lead.budget)}</td>
    </tr>
  `;
}

function renderCustomerCard(customer) {
  const webhookAbsolute = `${window.location.origin}${customer.webhookUrl}`;
  const state = getUiState(customer.id);

  const editSection = state.editing ? `
    <form class="edit-form" data-id="${customer.id}">
      <label>Name</label>
      <input type="text" name="name" value="${escapeHtml(customer.name)}" required />
      <label>What they do</label>
      <textarea name="description" rows="2" required>${escapeHtml(customer.description)}</textarea>
      <label>ICP Company Size</label>
      <input type="text" name="icpSize" value="${escapeHtml(customer.icpSize)}" />
      <label>ICP Annual Budget</label>
      <input type="text" name="icpBudget" value="${escapeHtml(customer.icpBudget)}" />
      <label>Qualifying Questions (one per line)</label>
      <textarea name="qualifyingQuestions" rows="3">${escapeHtml((customer.qualifyingQuestions || []).join('\n'))}</textarea>
      <div class="edit-actions">
        <button type="submit">Save</button>
        <button type="button" class="cancel-edit" data-id="${customer.id}">Cancel</button>
      </div>
      <div class="form-status" data-role="edit-status"></div>
    </form>
  ` : '';

  let leadsSection = '';
  if (state.expanded) {
    const leads = customer.leads || [];
    const filtered = state.filter === 'all' ? leads : leads.filter((l) => l.classification === state.filter);
    const exportHref = `/api/customer/${customer.id}/leads/export${state.filter !== 'all' ? `?classification=${state.filter}` : ''}`;
    leadsSection = `
      <div class="leads-panel">
        <div class="lead-filters">
          ${['all', 'hot', 'warm', 'cold'].map((f) => `<button type="button" class="filter-chip ${state.filter === f ? 'active' : ''}" data-id="${customer.id}" data-filter="${f}">${f}</button>`).join('')}
          <a class="export-link" href="${exportHref}" download>⬇ Export CSV</a>
        </div>
        ${filtered.length ? `
          <table class="leads-table">
            <thead><tr><th>Received</th><th>Class</th><th>Conf.</th><th>Company</th><th>Problem</th><th>Budget</th></tr></thead>
            <tbody>${filtered.map(renderLeadRow).join('')}</tbody>
          </table>
        ` : '<div class="empty-state">No leads in this category yet.</div>'}
      </div>
    `;
  }

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
      <div class="customer-actions">
        <button type="button" class="toggle-leads" data-id="${customer.id}">${state.expanded ? 'Hide Leads' : 'View Leads'}</button>
        <button type="button" class="toggle-edit" data-id="${customer.id}">${state.editing ? 'Cancel Edit' : 'Edit'}</button>
        <button type="button" class="delete-customer" data-id="${customer.id}">Delete</button>
      </div>
      ${editSection}
      ${leadsSection}
    </div>
  `;
}

function isEditingAnyCustomer() {
  return Object.values(customerUiState).some((s) => s.editing);
}

async function loadCustomers({ force = false } = {}) {
  if (!force && isEditingAnyCustomer()) {
    // Don't clobber an in-progress edit form on the periodic auto-refresh.
    return;
  }
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

// Event delegation for all per-customer-card interactions, since cards are
// re-rendered wholesale on every refresh.
document.getElementById('customer-list').addEventListener('click', async (e) => {
  const toggleLeads = e.target.closest('.toggle-leads');
  if (toggleLeads) {
    const state = getUiState(toggleLeads.dataset.id);
    state.expanded = !state.expanded;
    loadCustomers({ force: true });
    return;
  }

  const filterChip = e.target.closest('.filter-chip');
  if (filterChip) {
    const state = getUiState(filterChip.dataset.id);
    state.filter = filterChip.dataset.filter;
    loadCustomers({ force: true });
    return;
  }

  const toggleEdit = e.target.closest('.toggle-edit');
  if (toggleEdit) {
    const state = getUiState(toggleEdit.dataset.id);
    state.editing = !state.editing;
    loadCustomers({ force: true });
    return;
  }

  const cancelEdit = e.target.closest('.cancel-edit');
  if (cancelEdit) {
    getUiState(cancelEdit.dataset.id).editing = false;
    loadCustomers({ force: true });
    return;
  }

  const deleteBtn = e.target.closest('.delete-customer');
  if (deleteBtn) {
    const id = deleteBtn.dataset.id;
    if (!confirm('Delete this customer and all of their lead history? This cannot be undone.')) {
      return;
    }
    try {
      const res = await fetch(`/api/customer/${id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) {
        throw new Error(`Delete failed (${res.status})`);
      }
      delete customerUiState[id];
      refreshAll({ force: true });
    } catch (err) {
      alert(err.message);
    }
  }
});

document.getElementById('customer-list').addEventListener('submit', async (e) => {
  const form = e.target.closest('.edit-form');
  if (!form) return;
  e.preventDefault();

  const id = form.dataset.id;
  const statusEl = form.querySelector('[data-role="edit-status"]');
  const payload = {
    name: form.name.value.trim(),
    description: form.description.value.trim(),
    icpSize: form.icpSize.value.trim(),
    icpBudget: form.icpBudget.value.trim(),
    qualifyingQuestions: form.qualifyingQuestions.value,
  };

  try {
    await fetchJson(`/api/customer/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    getUiState(id).editing = false;
    refreshAll({ force: true });
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.className = 'form-status error';
  }
});

function refreshAll(options = {}) {
  loadStats();
  loadCustomers(options);
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
    refreshAll({ force: true });
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
loadConfig();
setInterval(refreshAll, 15000);
