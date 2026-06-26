const API_BASE = 'https://api.mueblesavenida.com';
const COLLECTION = 'notas';
const STORAGE_KEY = 'notas.directus.session';
const SAVE_DEBOUNCE_MS = 650;
const SEARCH_DEBOUNCE_MS = 350;
const MAX_TITLE_LENGTH = 80;
const RETRY_DELAY_MS = 5000;
const MAX_PAGE_SIZE = 200;
const EDITOR_TAB = '\t';

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
  currentNote: null,
  selectedId: null,
  searchQuery: '',
  draft: '',
  lastSavedDraft: '',
  loadingNotes: false,
  authLoading: false,
  creatingNote: false,
  savingByNote: new Map(),
  saveTimers: new Map(),
  deletedNoteIds: new Set(),
  searchTimer: null,
  notesLoadToken: 0,
  selectionToken: 0,
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
  state.notesLoadToken += 1;
  state.deletedNoteIds.clear();
  state.currentNote = null;
  localStorage.removeItem(STORAGE_KEY);
  if (state.refreshTimer) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
  }
  if (state.searchTimer) {
    clearTimeout(state.searchTimer);
    state.searchTimer = null;
  }
}

function setStatus(message, tone = 'neutral') {
  els.saveStatus.textContent = message;
  els.saveStatus.dataset.tone = tone;
}

function setLoginError(message = '') {
  els.loginError.textContent = message;
}

function setAuthLoading(active) {
  state.authLoading = active;
  els.loginView.classList.toggle('is-loading', active);
  els.loginForm.classList.toggle('is-loading', active);
  els.loginForm.setAttribute('aria-busy', String(active));
  els.loginForm.querySelectorAll('input, button[type="submit"]').forEach((element) => {
    element.disabled = active;
  });
}

function showLogin() {
  els.loginView.classList.remove('is-loading');
  els.loginForm.classList.remove('is-loading');
  els.loginForm.setAttribute('aria-busy', 'false');
  els.appView.classList.remove('revealed');
  els.loginView.classList.remove('hidden');
  els.appView.classList.add('hidden');
}

function showApp() {
  els.loginView.classList.add('hidden');
  els.appView.classList.remove('hidden');
  els.appView.classList.add('revealed');
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

function selectedNote() {
  if (state.currentNote?.id === state.selectedId) {
    return state.currentNote;
  }
  return state.notes.find((note) => note.id === state.selectedId) || null;
}

function noteTitleFromBody(value = '') {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) || 'Sin contenido';
}

function storedNoteTitleFromBody(value = '') {
  return noteTitleFromBody(value).slice(0, MAX_TITLE_LENGTH);
}

function normalizeNote(note) {
  if (!note) return null;
  const content = note.nota ?? '';
  return {
    ...note,
    nota: content,
    titulo: (typeof note.titulo === 'string' && note.titulo.trim()) || noteTitleFromBody(content)
  };
}

function displayNoteTitle(note) {
  if (!note) return 'Sin contenido';
  if (note.id === state.selectedId) {
    return noteTitleFromBody(state.draft);
  }
  return note.titulo || noteTitleFromBody(note.nota);
}

function buildNotesQuery({ page = 1, search = '' } = {}) {
  const query = new URLSearchParams({
    fields: 'id,titulo,date_updated',
    sort: '-date_updated,-date_created',
    limit: String(MAX_PAGE_SIZE),
    page: String(page)
  });

  const normalizedSearch = search.trim();
  if (normalizedSearch) {
    query.set('filter[_or][0][titulo][_icontains]', normalizedSearch);
    query.set('filter[_or][1][nota][_icontains]', normalizedSearch);
  }

  return query;
}

async function fetchNotesPage({ page = 1, search = '' } = {}) {
  const response = await apiRequest(`/items/${COLLECTION}?${buildNotesQuery({ page, search }).toString()}`);
  return Array.isArray(response?.data) ? response.data.map(normalizeNote) : [];
}

async function fetchAllNotes({ search = '' } = {}) {
  let page = 1;
  const items = [];

  while (true) {
    const pageItems = await fetchNotesPage({ page, search });
    items.push(...pageItems);
    if (pageItems.length < MAX_PAGE_SIZE) break;
    page += 1;
  }

  return items;
}

async function fetchNoteById(noteId) {
  const query = new URLSearchParams({
    fields: 'id,titulo,nota,date_created,date_updated'
  });
  const response = await apiRequest(`/items/${COLLECTION}/${noteId}?${query.toString()}`);
  return normalizeNote(response?.data || response);
}

async function loadNotesList({ selectFirst = false } = {}) {
  const loadToken = ++state.notesLoadToken;
  state.loadingNotes = true;
  render();
  const search = state.searchQuery.trim();
  const searching = Boolean(search);

  try {
    const notes = search ? await fetchNotesPage({ page: 1, search }) : await fetchAllNotes();
    if (!state.accessToken || !state.refreshToken) return;
    if (loadToken !== state.notesLoadToken) return;

    state.notes = notes;

    if (selectFirst && !searching && !state.selectedId && state.notes.length) {
      if (loadToken !== state.notesLoadToken) return;
      await selectNote(state.notes[0].id, { focus: false, skipStatus: true });
      if (loadToken !== state.notesLoadToken) return;
    }

    if (loadToken !== state.notesLoadToken) return;

    if (!state.notes.length && !state.selectedId) {
      state.currentNote = null;
      state.draft = '';
      state.lastSavedDraft = '';
      setStatus(searching ? 'Sin coincidencias' : 'Sin notas', 'neutral');
    } else if (!state.notes.length && searching) {
      setStatus('Sin coincidencias', 'neutral');
    } else if (searching) {
      setStatus(`${state.notes.length} resultado${state.notes.length === 1 ? '' : 's'}`, 'neutral');
    } else {
      setStatus('Sin cambios', 'neutral');
    }

    render();
  } finally {
    if (loadToken === state.notesLoadToken) {
      state.loadingNotes = false;
      render();
    }
  }
}

function updateNotesAfterDelete(noteId) {
  state.notes = state.notes.filter((item) => item.id !== noteId);
  if (state.currentNote?.id === noteId) {
    state.currentNote = null;
  }
}

function sortedNoteSummaries() {
  return [...state.notes].sort((a, b) => {
    const diff = effectiveDate(b) - effectiveDate(a);
    if (diff !== 0) return diff;
    return Number(b.id) - Number(a.id);
  });
}

function renderNotesList() {
  const items = state.notes;
  const scrollTop = els.noteList.scrollTop;
  const loading = state.loadingNotes;
  const loadingLabel = state.searchQuery.trim() ? 'Buscando...' : 'Cargando notas...';
  els.notesCount.textContent = `${items.length} nota${items.length === 1 ? '' : 's'}`;
  els.notesCount.classList.toggle('is-loading', loading);
  els.noteList.classList.toggle('is-loading', loading);
  els.noteList.setAttribute('aria-busy', String(loading));
  els.noteList.dataset.loadingLabel = loading ? loadingLabel : '';

  if (loading && !items.length) {
    els.noteList.innerHTML = '';
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 5; index += 1) {
      const skeleton = document.createElement('div');
      skeleton.className = 'note-item note-item-skeleton';
      skeleton.setAttribute('aria-hidden', 'true');

      const title = document.createElement('div');
      title.className = 'note-title note-skeleton-line note-skeleton-line--title';

      const metaRow = document.createElement('div');
      metaRow.className = 'note-meta-row';

      const date = document.createElement('span');
      date.className = 'note-date note-skeleton-line note-skeleton-line--date';

      metaRow.appendChild(date);
      skeleton.append(title, metaRow);
      fragment.appendChild(skeleton);
    }

    els.noteList.appendChild(fragment);
    return;
  }

  if (loading && items.length) {
    return;
  }

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
    button.setAttribute('aria-pressed', note.id === state.selectedId ? 'true' : 'false');
    if (note.id === state.selectedId) {
      button.setAttribute('aria-current', 'true');
    }

    const title = document.createElement('div');
    title.className = 'note-title';
    title.textContent = displayNoteTitle(note);

    const metaRow = document.createElement('div');
    metaRow.className = 'note-meta-row';

    const date = document.createElement('span');
    date.className = 'note-date';
    date.textContent = formatListDate(note.date_updated || note.date_created);

    metaRow.appendChild(date);
    button.append(title, metaRow);
    fragment.appendChild(button);
  }

  els.noteList.appendChild(fragment);
  els.noteList.scrollTop = scrollTop;
}

function syncSelectedNotePreview() {
  const note = selectedNote();
  if (!note) return;

  const title = displayNoteTitle(note);
  els.noteTitle.textContent = title;
  els.noteMeta.textContent = `Modificada ${formatDate(note.date_updated || note.date_created)}`;

  const activeTitle = els.noteList.querySelector('.note-item.active .note-title');
  if (activeTitle) {
    activeTitle.textContent = title;
  }
}

function renderEditor() {
  const note = selectedNote();
  const hasNote = Boolean(note);
  if (hasNote) {
    syncSelectedNotePreview();
  } else {
    els.noteTitle.textContent = 'Selecciona una nota';
    els.noteMeta.textContent = 'Crea una nueva nota desde la barra lateral.';
  }

  els.emptyState.classList.toggle('hidden', hasNote);
  els.editorWrap.classList.toggle('hidden', !hasNote);
  els.deleteNote.disabled = !hasNote;

  if (hasNote && els.editor.value !== state.draft) {
    els.editor.value = state.draft;
  }
}

function renderAuthState() {
  if (state.accessToken && state.refreshToken && !state.authLoading) {
    showApp();
  } else {
    showLogin();
  }
}

function render() {
  renderNotesList();
  renderEditor();
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

async function createNote() {
  if (state.creatingNote) return;
  state.creatingNote = true;
  setStatus('Creando nota...', 'neutral');

  try {
    const response = await apiRequest(`/items/${COLLECTION}`, {
      method: 'POST',
      body: JSON.stringify({ nota: '', titulo: storedNoteTitleFromBody('Sin contenido') })
    });

    const note = normalizeNote(response.data);
    upsertNote(note);
    await selectNote(note.id, { focus: true, preserveDraft: false, skipStatus: true });
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
  const current = state.currentNote?.id === noteId ? state.currentNote : note;
  if (!current) return;

  const nextTitle = storedNoteTitleFromBody(content);

  if (current.nota === content && current.titulo === nextTitle && current.date_updated) {
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
    const response = await apiRequest(`/items/${COLLECTION}/${noteId}`, {
      method: 'PATCH',
      body: JSON.stringify({ nota: content, titulo: nextTitle })
    });

    if (state.savingByNote.get(noteId) !== currentGeneration) {
      return;
    }

    if (state.deletedNoteIds.has(noteId)) {
      return;
    }

    const saved = normalizeNote(response.data);
    upsertNote(saved);

    if (state.selectedId === noteId) {
      state.lastSavedDraft = content;
      renderEditor();
    }
    if (state.searchQuery.trim()) {
      await loadNotesList();
    } else {
      renderNotesList();
    }
    if (state.selectedId === noteId) {
      setStatus('Guardado', 'success');
    }
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
  if (!saved) return;
  const existingIndex = state.notes.findIndex((note) => note.id === saved.id);
  if (existingIndex === -1) {
    state.notes.push(saved);
  } else {
    state.notes.splice(existingIndex, 1, saved);
  }
  state.notes = [...state.notes].sort((a, b) => {
    const diff = effectiveDate(b) - effectiveDate(a);
    if (diff !== 0) return diff;
    return Number(b.id) - Number(a.id);
  });

  if (state.currentNote?.id === saved.id) {
    state.currentNote = saved;
  }
}

async function selectNote(id, options = {}) {
  const { focus = true, skipStatus = false } = options;
  if (!state.notes.some((item) => item.id === id) && state.currentNote?.id !== id) return;

  const current = selectedNote();
  if (current && current.id !== id && current.id && state.draft !== state.lastSavedDraft) {
    immediateSave(current.id, state.draft);
  }

  const token = ++state.selectionToken;
  if (!skipStatus) {
    setStatus('Cargando nota...', 'neutral');
  }

  const note = state.currentNote?.id === id ? state.currentNote : await fetchNoteById(id);
  if (!state.accessToken || !state.refreshToken) return;
  if (token !== state.selectionToken) return;

  state.selectedId = id;
  state.currentNote = note;
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

  const label = displayNoteTitle(note);
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

    updateNotesAfterDelete(noteId);
    const remaining = sortedNoteSummaries();

    if (remaining.length) {
      const next = remaining[0];
      state.selectedId = null;
      state.draft = '';
      state.lastSavedDraft = '';
      await selectNote(next.id, { focus: false, skipStatus: true });
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
  syncSelectedNotePreview();
  setStatus('Cambios pendientes', 'neutral');
  queueSave(state.selectedId, state.draft);
}

function replaceEditorSelection(value, selectionStart, selectionEnd) {
  els.editor.setRangeText(value, selectionStart, selectionEnd, 'end');
  handleEditorInput();
}

function indentEditorSelection() {
  const { value, selectionStart, selectionEnd } = els.editor;
  const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;

  if (selectionStart === selectionEnd) {
    replaceEditorSelection(EDITOR_TAB, selectionStart, selectionEnd);
    return;
  }

  const selectedText = value.slice(lineStart, selectionEnd);
  const indentedText = selectedText.replace(/^/gm, EDITOR_TAB);
  replaceEditorSelection(indentedText, lineStart, selectionEnd);
  els.editor.setSelectionRange(selectionStart + EDITOR_TAB.length, lineStart + indentedText.length);
}

function outdentEditorSelection() {
  const { value, selectionStart, selectionEnd } = els.editor;
  const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
  const selectedText = value.slice(lineStart, selectionEnd);
  let removedBeforeSelection = 0;
  let removedTotal = 0;

  const outdentedText = selectedText.replace(/^\t|^ {1,4}/gm, (match, offset) => {
    if (lineStart + offset < selectionStart) {
      removedBeforeSelection += match.length;
    }
    removedTotal += match.length;
    return '';
  });

  if (!removedTotal) return;

  replaceEditorSelection(outdentedText, lineStart, selectionEnd);
  els.editor.setSelectionRange(
    Math.max(lineStart, selectionStart - removedBeforeSelection),
    Math.max(lineStart, selectionEnd - removedTotal)
  );
}

function handleEditorKeydown(event) {
  if (event.key !== 'Tab') return;
  event.preventDefault();

  if (event.shiftKey) {
    outdentEditorSelection();
  } else {
    indentEditorSelection();
  }
}

function scheduleSearchReload() {
  if (state.searchTimer) {
    clearTimeout(state.searchTimer);
  }

  state.searchTimer = setTimeout(() => {
    state.searchTimer = null;
    loadNotesList().catch((error) => {
      console.error(error);
      setStatus('No se pudo buscar', 'error');
    });
  }, SEARCH_DEBOUNCE_MS);
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  setLoginError('');
  setAuthLoading(true);
  const email = els.email.value.trim();
  const password = els.password.value;

  if (!email || !password) {
    setAuthLoading(false);
    setLoginError('Rellena el email y la contraseña.');
    return;
  }

  try {
    await login(email, password);
  } catch (error) {
    console.error(error);
    clearSession();
    setAuthLoading(false);
    renderAuthState();
    setLoginError(error.message);
    return;
  }

  try {
    await loadNotesList({ selectFirst: true });
  } catch (error) {
    console.error(error);
    setStatus('No se pudo cargar el listado', 'error');
  } finally {
    setAuthLoading(false);
    renderAuthState();
  }
}

function wireEvents() {
  els.loginForm.addEventListener('submit', handleLoginSubmit);
  els.noteList.addEventListener('click', (event) => {
    const item = event.target.closest('.note-item');
    if (!item) return;
    selectNote(Number(item.dataset.id));
  });
  els.search.addEventListener('input', () => {
    state.searchQuery = els.search.value;
    scheduleSearchReload();
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
    state.authLoading = false;
    state.notes = [];
    state.currentNote = null;
    state.selectedId = null;
    state.draft = '';
    state.lastSavedDraft = '';
    els.editor.value = '';
    els.appView.classList.remove('revealed');
    renderAuthState();
    render();
  });
  els.editor.addEventListener('input', handleEditorInput);
  els.editor.addEventListener('keydown', handleEditorKeydown);
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

  setAuthLoading(true);
  state.accessToken = stored.accessToken;
  state.refreshToken = stored.refreshToken;
  state.tokenExpiresAt = stored.tokenExpiresAt || 0;
  renderAuthState();

  try {
    await refreshSession();
  } catch (error) {
    console.error(error);
    clearSession();
    setAuthLoading(false);
    renderAuthState();
    setLoginError('La sesión anterior ya no es válida. Vuelve a entrar.');
    showLogin();
    return;
  }

  try {
    await loadNotesList({ selectFirst: true });
  } catch (error) {
    console.error(error);
    setStatus('No se pudo cargar el listado', 'error');
  } finally {
    setAuthLoading(false);
    renderAuthState();
  }
}

bootstrap().catch((error) => {
  console.error(error);
  setLoginError(error.message);
  showLogin();
});
