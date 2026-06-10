const API_BASE = 'https://api.mueblesavenida.com';
const COLLECTION = 'notas';
const STORAGE_KEY = 'notas.directus.session';
const SAVE_DEBOUNCE_MS = 650;
const RETRY_DELAY_MS = 5000;
const MAX_PAGE_SIZE = 200;

const els = {
  loginView: document.getElementById('login-view'),
  loginForm: document.getElementById('login-form'),
  email: document.getElementById('email'),
  password: document.getElementById('password'),
  loginError: document.getElementById('login-error'),
  appView: document.getElementById('app-view'),
  noteList: document.getElementById('note-list'),
  notesCount: document.getElementById('notes-count'),
  search: document.getElementById('search'),
  newNote: document.getElementById('new-note'),
  emptyNewNote: document.getElementById('empty-new-note'),
  logout: document.getElementById('logout'),
  noteTitle: document.getElementById('note-title'),
  noteMeta: document.getElementById('note-meta'),
  saveStatus: document.getElementById('save-status'),
  deleteNote: document.getElementById('delete-note'),
  emptyState: document.getElementById('empty-state'),
  editorWrap: document.getElementById('editor-wrap'),
  editor: document.getElementById('editor')
};

const state = {
  accessToken: null,
  refreshToken: null,
  tokenExpiresAt: 0,
  notes: [],
  selectedId: null,
  searchQuery: '',
  draft: '',
  lastSavedDraft: '',
  loadingNotes: false,
  creatingNote: false,
  savingByNote: new Map(),
  saveTimers: new Map(),
  deletedNoteIds: new Set(),
  refreshTimer: null
};

const noteListDateFormatter = new Intl.DateTimeFormat('es-ES', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric'
});

const editorDateFormatter = new Intl.DateTimeFormat('es-ES', {
  dateStyle: 'medium',
  timeStyle: 'short'
});

function saveSession() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      accessToken: state.accessToken,
      refreshToken: state.refreshToken,
      tokenExpiresAt: state.tokenExpiresAt
    })
  );
}

function loadSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.refreshToken) return null;
    return parsed;
  } catch {
    return null;
  }
}

function clearSession() {
  state.accessToken = null;
  state.refreshToken = null;
  state.tokenExpiresAt = 0;
  state.deletedNoteIds.clear();
  localStorage.removeItem(STORAGE_KEY);
  if (state.refreshTimer) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
  }
}

function setStatus(message, tone = 'neutral') {
  els.saveStatus.textContent = message;
  els.saveStatus.dataset.tone = tone;
}

function setLoginError(message = '') {
  els.loginError.textContent = message;
}

function showLogin() {
  els.loginView.classList.remove('hidden');
  els.appView.classList.add('hidden');
}

function showApp() {
  els.loginView.classList.add('hidden');
  els.appView.classList.remove('hidden');
}

function tokenPayload(token) {
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

function updateTokenExpiry(accessToken, expiresMs) {
  const payload = tokenPayload(accessToken);
  if (payload?.exp) {
    state.tokenExpiresAt = payload.exp * 1000;
    return;
  }
  state.tokenExpiresAt = Date.now() + Number(expiresMs || 0);
}

function scheduleRefresh() {
  if (state.refreshTimer) clearTimeout(state.refreshTimer);
  if (!state.refreshToken || !state.tokenExpiresAt) return;

  const delay = Math.max(10_000, state.tokenExpiresAt - Date.now() - 60_000);
  state.refreshTimer = setTimeout(() => {
    refreshSession().catch(() => {
      clearSession();
      renderAuthState();
      setLoginError('La sesión expiró. Vuelve a entrar.');
    });
  }, delay);
}

function normalizeText(value = '') {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function effectiveDate(note) {
  const raw = note.date_updated || note.date_created;
  const time = raw ? new Date(raw).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

function formatDate(value) {
  if (!value) return 'Sin fecha';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Sin fecha';
  return editorDateFormatter.format(date);
}

function formatListDate(value) {
  if (!value) return 'Sin fecha';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Sin fecha';
  return noteListDateFormatter.format(date);
}

function getNoteBody(note) {
  if (!note) return '';
  if (note.id === state.selectedId) return state.draft;
  return note.nota || '';
}

function matchesSearch(note, query) {
  if (!query) return true;
  return normalizeText(getNoteBody(note)).includes(query);
}

function sortedNotes() {
  return [...state.notes].sort((a, b) => {
    const diff = effectiveDate(b) - effectiveDate(a);
    if (diff !== 0) return diff;
    return Number(b.id) - Number(a.id);
  });
}

function filteredNotes() {
  const query = normalizeText(state.searchQuery.trim());
  return sortedNotes().filter((note) => matchesSearch(note, query));
}

function selectedNote() {
  return state.notes.find((note) => note.id === state.selectedId) || null;
}

function renderNotesList() {
  const items = filteredNotes();
  const scrollTop = els.noteList.scrollTop;
  els.notesCount.textContent = `${state.notes.length} nota${state.notes.length === 1 ? '' : 's'}`;
  els.noteList.innerHTML = '';

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.style.padding = '12px 4px';
    empty.textContent = state.searchQuery.trim()
      ? 'No hay coincidencias para esa búsqueda.'
      : 'Todavía no hay notas.';
    els.noteList.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const note of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `note-item${note.id === state.selectedId ? ' active' : ''}`;
    button.dataset.id = String(note.id);

    const body = getNoteBody(note).trim();
    const firstLine = getFirstLine(body);
    const secondLine = body.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0 && line !== firstLine) || 'Escribe algo para empezar.';
    const compactDate = formatListDate(note.date_updated || note.date_created);

    button.innerHTML = `
      <div class="note-title">${escapeHtml(firstLine || 'Sin contenido')}</div>
      <div class="note-snippet">${escapeHtml(secondLine)} <span class="note-date">${escapeHtml(compactDate)}</span></div>
    `;

    button.addEventListener('click', () => selectNote(Number(note.id)));
    fragment.appendChild(button);
  }

  els.noteList.appendChild(fragment);
  els.noteList.scrollTop = scrollTop;
}

function renderEditor() {
  const note = selectedNote();
  const hasNote = Boolean(note);
  els.noteTitle.textContent = hasNote ? getFirstLine(state.draft || note.nota) : 'Selecciona una nota';
  els.noteMeta.textContent = hasNote
    ? `Modificada ${formatDate(note.date_updated || note.date_created)}`
    : 'Crea una nueva nota desde la barra lateral.';

  els.emptyState.classList.toggle('hidden', hasNote);
  els.editorWrap.classList.toggle('hidden', !hasNote);
  els.deleteNote.disabled = !hasNote;

  if (hasNote && els.editor.value !== state.draft) {
    els.editor.value = state.draft;
  }
}

function renderAuthState() {
  if (state.accessToken && state.refreshToken) {
    showApp();
  } else {
    showLogin();
  }
}

function render() {
  renderNotesList();
  renderEditor();
}

function escapeHtml(value = '') {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function getFirstLine(value = '') {
  const firstLine = String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return firstLine || 'Sin contenido';
}

async function apiRequest(path, options = {}, retry = true) {
  if (!state.accessToken && state.refreshToken) {
    await refreshSession();
  }

  const headers = new Headers(options.headers || {});
  if (state.accessToken) headers.set('Authorization', `Bearer ${state.accessToken}`);
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers
  });

  if (response.status === 401 && retry && state.refreshToken) {
    await refreshSession();
    return apiRequest(path, options, false);
  }

  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();

  if (!response.ok) {
    const message =
      payload?.errors?.[0]?.message ||
      payload?.message ||
      (typeof payload === 'string' ? payload : 'Error de API');
    throw new Error(message);
  }

  return payload;
}

async function login(email, password) {
  const response = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, mode: 'json' })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.errors?.[0]?.message || 'No se pudo iniciar sesión');
  }

  state.accessToken = data.data.access_token;
  state.refreshToken = data.data.refresh_token;
  updateTokenExpiry(state.accessToken, data.data.expires);
  saveSession();
  scheduleRefresh();
}

async function refreshSession() {
  if (!state.refreshToken) throw new Error('Sin refresh token');

  const response = await fetch(`${API_BASE}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: state.refreshToken })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.errors?.[0]?.message || 'No se pudo renovar la sesión');
  }

  state.accessToken = data.data.access_token;
  state.refreshToken = data.data.refresh_token || state.refreshToken;
  updateTokenExpiry(state.accessToken, data.data.expires);
  saveSession();
  scheduleRefresh();
}

function removePendingSave(noteId) {
  if (state.saveTimers.has(noteId)) {
    clearTimeout(state.saveTimers.get(noteId));
    state.saveTimers.delete(noteId);
  }
  state.savingByNote.delete(noteId);
}

async function loadNotes() {
  state.loadingNotes = true;
  setStatus('Cargando notas...', 'neutral');

  const pageSize = MAX_PAGE_SIZE;
  let page = 1;
  const all = [];

  while (true) {
    const query = new URLSearchParams({
      fields: 'id,nota,date_created,date_updated',
      sort: '-date_updated,-date_created',
      limit: String(pageSize),
      page: String(page)
    });

    const response = await apiRequest(`/items/${COLLECTION}?${query.toString()}`);
    const items = Array.isArray(response?.data) ? response.data : [];
    all.push(...items);

    if (items.length < pageSize) break;
    page += 1;
  }

  state.notes = all;
  state.loadingNotes = false;

  if (!state.selectedId && state.notes.length) {
    selectNote(state.notes[0].id, { focus: false });
  }

  if (!state.notes.length) {
    state.selectedId = null;
    state.draft = '';
    state.lastSavedDraft = '';
    setStatus('Sin notas', 'neutral');
  } else {
    setStatus('Sin cambios', 'neutral');
  }

  render();
}

async function createNote() {
  if (state.creatingNote) return;
  state.creatingNote = true;
  setStatus('Creando nota...', 'neutral');

  try {
    const response = await apiRequest(`/items/${COLLECTION}`, {
      method: 'POST',
      body: JSON.stringify({ nota: '' })
    });

    const note = response.data;
    state.notes = [note, ...state.notes];
    selectNote(note.id, { focus: true, preserveDraft: false });
    setStatus('Sin cambios', 'neutral');
  } catch (error) {
    setStatus('No se pudo crear la nota', 'error');
    alert(error.message);
  } finally {
    state.creatingNote = false;
    render();
  }
}

function queueSave(noteId, content) {
  if (!noteId) return;

  if (state.saveTimers.has(noteId)) {
    clearTimeout(state.saveTimers.get(noteId));
  }

  const timer = setTimeout(() => {
    state.saveTimers.delete(noteId);
    persistNote(noteId, content).catch((error) => {
      console.error(error);
    });
  }, SAVE_DEBOUNCE_MS);

  state.saveTimers.set(noteId, timer);
}

function immediateSave(noteId, content) {
  if (!noteId) return;
  removePendingSave(noteId);
  persistNote(noteId, content).catch((error) => {
    console.error(error);
  });
}

async function persistNote(noteId, content) {
  const note = state.notes.find((item) => item.id === noteId);
  if (!note) return;

  if (note.nota === content && note.date_updated) {
    if (state.selectedId === noteId) {
      state.lastSavedDraft = content;
      setStatus('Sin cambios', 'neutral');
    }
    return;
  }

  const currentGeneration = (state.savingByNote.get(noteId) || 0) + 1;
  state.savingByNote.set(noteId, currentGeneration);
  if (state.selectedId === noteId) {
    setStatus('Guardando...', 'neutral');
  }

  try {
    const response = note.date_created && note.id
      ? await apiRequest(`/items/${COLLECTION}/${noteId}`, {
          method: 'PATCH',
          body: JSON.stringify({ nota: content })
        })
      : await apiRequest(`/items/${COLLECTION}`, {
          method: 'POST',
          body: JSON.stringify({ nota: content })
        });

    if (state.savingByNote.get(noteId) !== currentGeneration) {
      return;
    }

    if (state.deletedNoteIds.has(noteId)) {
      return;
    }

    const saved = response.data;
    upsertNote(saved);

    if (state.selectedId === noteId) {
      state.lastSavedDraft = content;
      setStatus('Guardado', 'success');
      renderEditor();
    }
    renderNotesList();
  } catch (error) {
    if (state.savingByNote.get(noteId) !== currentGeneration) {
      return;
    }

    if (state.selectedId === noteId) {
      setStatus('Error al guardar', 'error');
    }

    console.error(error);
    const retryContent = content;
    if (noteId === state.selectedId && els.editor.value === retryContent) {
      if (state.saveTimers.has(noteId)) {
        clearTimeout(state.saveTimers.get(noteId));
      }
      const retryTimer = setTimeout(() => {
        state.saveTimers.delete(noteId);
        persistNote(noteId, retryContent).catch((retryError) => console.error(retryError));
      }, RETRY_DELAY_MS);
      state.saveTimers.set(noteId, retryTimer);
    }
  }
}

function upsertNote(saved) {
  const existingIndex = state.notes.findIndex((note) => note.id === saved.id);
  if (existingIndex === -1) {
    state.notes.push(saved);
  } else {
    state.notes.splice(existingIndex, 1, saved);
  }
  state.notes = sortedNotes();
}

function selectNote(id, options = {}) {
  const note = state.notes.find((item) => item.id === id);
  if (!note) return;

  const { focus = true } = options;
  const current = selectedNote();
  if (current && current.id !== id && current.id && state.draft !== state.lastSavedDraft) {
    immediateSave(current.id, state.draft);
  }

  state.selectedId = id;
  state.draft = note.nota || '';
  state.lastSavedDraft = state.draft;
  els.editor.value = state.draft;
  setStatus('Sin cambios', 'neutral');
  render();

  if (focus) {
    requestAnimationFrame(() => els.editor.focus());
  }
}

async function deleteSelectedNote() {
  const note = selectedNote();
  if (!note) return;

  const label = getFirstLine(state.draft || note.nota);
  const confirmed = confirm(`¿Borrar la nota "${label}"? Esta acción no se puede deshacer.`);
  if (!confirmed) return;

  const noteId = note.id;
  setStatus('Borrando...', 'neutral');
  state.deletedNoteIds.add(noteId);
  removePendingSave(noteId);

  try {
    await apiRequest(`/items/${COLLECTION}/${noteId}`, {
      method: 'DELETE'
    });

    const remaining = state.notes.filter((item) => item.id !== noteId);
    state.notes = remaining;

    if (remaining.length) {
      const next = sortedNotes()[0];
      state.selectedId = null;
      state.draft = '';
      state.lastSavedDraft = '';
      selectNote(next.id, { focus: false });
      setStatus('Nota borrada', 'success');
    } else {
      state.selectedId = null;
      state.draft = '';
      state.lastSavedDraft = '';
      els.editor.value = '';
      setStatus('Nota borrada', 'success');
      render();
    }
  } catch (error) {
    console.error(error);
    state.deletedNoteIds.delete(noteId);
    setStatus('No se pudo borrar', 'error');
    alert(error.message);
  }
}

function handleEditorInput() {
  if (!state.selectedId) return;
  state.draft = els.editor.value;
  renderNotesList();
  setStatus('Cambios pendientes', 'neutral');
  queueSave(state.selectedId, state.draft);
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  setLoginError('');
  const email = els.email.value.trim();
  const password = els.password.value;

  if (!email || !password) {
    setLoginError('Rellena el email y la contraseña.');
    return;
  }

  els.loginForm.querySelector('button[type="submit"]').disabled = true;
  try {
    await login(email, password);
    renderAuthState();
    await loadNotes();
  } catch (error) {
    setLoginError(error.message);
    clearSession();
  } finally {
    els.loginForm.querySelector('button[type="submit"]').disabled = false;
  }
}

function wireEvents() {
  els.loginForm.addEventListener('submit', handleLoginSubmit);
  els.search.addEventListener('input', () => {
    state.searchQuery = els.search.value;
    renderNotesList();
  });
  els.newNote.addEventListener('click', () => {
    if (state.selectedId && state.draft !== state.lastSavedDraft) {
      immediateSave(state.selectedId, state.draft);
    }
    createNote();
  });
  els.emptyNewNote.addEventListener('click', createNote);
  els.deleteNote.addEventListener('click', deleteSelectedNote);
  els.logout.addEventListener('click', () => {
    clearSession();
    state.notes = [];
    state.selectedId = null;
    state.draft = '';
    state.lastSavedDraft = '';
    els.editor.value = '';
    renderAuthState();
    render();
  });
  els.editor.addEventListener('input', handleEditorInput);
}

async function bootstrap() {
  wireEvents();
  renderAuthState();
  render();

  const stored = loadSession();
  if (!stored) {
    showLogin();
    return;
  }

  state.accessToken = stored.accessToken;
  state.refreshToken = stored.refreshToken;
  state.tokenExpiresAt = stored.tokenExpiresAt || 0;
  renderAuthState();

  try {
    await refreshSession();
    await loadNotes();
  } catch (error) {
    console.error(error);
    clearSession();
    renderAuthState();
    setLoginError('La sesión anterior ya no es válida. Vuelve a entrar.');
    showLogin();
  }
}

bootstrap().catch((error) => {
  console.error(error);
  setLoginError(error.message);
  showLogin();
});
