

    (() => {
      'use strict';

      const STORAGE_KEYS = {
        sessions: 'ai_medical_scribe_sessions_v1',
        settings: 'ai_medical_scribe_settings_v1',
        customisation: 'ai_medical_scribe_customisation_v1'
      };

      const $ = (id) => document.getElementById(id);

      function uid(prefix) {
        return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
      }

      function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
      }

      function safeParse(json, fallback) {
        try {
          if (!json) return fallback;
          const parsed = JSON.parse(json);
          return parsed == null ? fallback : parsed;
        } catch (error) {
          return fallback;
        }
      }

      function readStorage(key, fallback) {
        try {
          return safeParse(window.localStorage.getItem(key), fallback);
        } catch (error) {
          return fallback;
        }
      }

      function writeStorage(key, value) {
        try {
          window.localStorage.setItem(key, JSON.stringify(value));
          return true;
        } catch (error) {
          return false;
        }
      }

      function escapeHtml(value) {
        return String(value)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function escapeAttribute(value) {
        return escapeHtml(value).replace(/\n/g, '&#10;');
      }

      function escapeRegExp(value) {
        return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }

      function normaliseWhitespace(text) {
        return String(text || '')
          .replace(/\s+/g, ' ')
          .replace(/\u00A0/g, ' ')
          .trim();
      }

      function dedupeStrings(items) {
        return Array.from(new Set((Array.isArray(items) ? items : []).map((item) => normaliseWhitespace(item)).filter(Boolean)));
      }

      function sanitizeFilenamePart(value) {
        return String(value || 'session')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 48) || 'session';
      }

      function formatClock(timestamp) {
        if (!timestamp) return '-';
        return new Intl.DateTimeFormat([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        }).format(new Date(timestamp));
      }

      function formatDateTime(timestamp) {
        if (!timestamp) return '-';
        return new Intl.DateTimeFormat([], {
          dateStyle: 'medium',
          timeStyle: 'short'
        }).format(new Date(timestamp));
      }

      function toLocalDateInputValue(timestamp) {
        if (!timestamp) return '';
        const date = new Date(timestamp);
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return y + '-' + m + '-' + d;
      }

      function formatDuration(ms) {
        const totalSeconds = Math.max(0, Math.floor((ms || 0) / 1000));
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
      }

      function deepClone(value) {
        return JSON.parse(JSON.stringify(value));
      }

      function hexToRgbTuple(hex) {
        const normalised = String(hex || '').replace('#', '').trim();
        const valid = /^([0-9a-f]{3}|[0-9a-f]{6})$/i.test(normalised) ? normalised : '2f7df6';
        const long = valid.length === 3 ? valid.split('').map((char) => char + char).join('') : valid;
        const num = parseInt(long, 16);
        return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
      }

      function titleCaseStatus(status) {
        const map = { idle: 'Idle', listening: 'Listening', paused: 'Paused', stopped: 'Stopped' };
        return map[status] || 'Idle';
      }

      function showToast(message, type = 'info', timeout = 3200) {
        const toast = document.createElement('div');
        toast.className = 'toast ' + type;
        toast.textContent = message;
        refs.toastContainer.appendChild(toast);
        window.setTimeout(() => {
          toast.style.opacity = '0';
          toast.style.transform = 'translateY(8px)';
          toast.style.transition = '0.18s ease';
          window.setTimeout(() => toast.remove(), 180);
        }, timeout);
      }

      function highlightText(text, term) {
        const source = String(text || '');
        const query = String(term || '').trim();
        if (!query) return escapeHtml(source).replace(/\n/g, '<br>');
        const regex = new RegExp('(' + escapeRegExp(query) + ')', 'ig');
        return source
          .split(regex)
          .map((part) => part.toLowerCase() === query.toLowerCase() ? '<mark>' + escapeHtml(part) + '</mark>' : escapeHtml(part))
          .join('')
          .replace(/\n/g, '<br>');
      }

      function insertTextAtCursor(textarea, text) {
        const start = textarea.selectionStart || 0;
        const end = textarea.selectionEnd || 0;
        const value = textarea.value || '';
        const prefixNeedsBreak = start > 0 && !/\s$/.test(value.slice(0, start)) ? '\n' : '';
        const suffixNeedsSpace = end < value.length && !/^\s/.test(value.slice(end)) ? '\n' : '';
        const insertion = prefixNeedsBreak + text + suffixNeedsSpace;
        textarea.value = value.slice(0, start) + insertion + value.slice(end);
        const cursor = start + insertion.length;
        textarea.focus();
        textarea.selectionStart = cursor;
        textarea.selectionEnd = cursor;
      }

      function debounce(fn, delay = 300) {
        let timer = null;
        return (...args) => {
          window.clearTimeout(timer);
          timer = window.setTimeout(() => fn(...args), delay);
        };
      }

      function applyAutoPunctuation(text, shouldSentenceCase = true) {
        let value = normaliseWhitespace(text);
        if (!value) return '';
        if (shouldSentenceCase) value = value.charAt(0).toUpperCase() + value.slice(1);
        if (!/[.!?…]$/.test(value) && (value.length > 18 || value.split(/\s+/).length > 4)) value += '.';
        return value;
      }

      function mergeTranscriptText(existing, incoming) {
        if (!existing) return incoming;
        if (!incoming) return existing;
        const left = existing.trimEnd();
        const needsSpace = !/[\s-]$/.test(left);
        return left + (needsSpace ? ' ' : '') + incoming.trimStart();
      }

      function scrollTranscriptToBottom(container) {
        if (!container) return;
        window.requestAnimationFrame(() => {
          container.scrollTop = container.scrollHeight;
        });
      }

      function downloadTextFile(filename, content) {
        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
      }

      function copyToClipboard(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
        return new Promise((resolve, reject) => {
          const temp = document.createElement('textarea');
          temp.value = text;
          temp.setAttribute('readonly', '');
          temp.style.position = 'absolute';
          temp.style.left = '-9999px';
          document.body.appendChild(temp);
          temp.select();
          const ok = document.execCommand('copy');
          temp.remove();
          ok ? resolve() : reject(new Error('Copy failed'));
        });
      }

      function createDefaultSettings() {
        return {
          locale: 'en-GB',
          autoPunctuation: true,
          interimResults: true,
          saveRawTranscript: true,
          autoSaveInterval: 5,
          theme: 'light',
          dataRetentionDays: 180,
          transcriptFontSize: 16,
          transcriptLineSpacing: 1.55
        };
      }

      function createDefaultCustomisation() {
        return {
          organisationName: 'Northbridge Clinic',
          brandingColor: '#2f7df6',
          defaultConsultationType: 'General consultation',
          macros: [
            { id: uid('macro'), label: 'Safety-netting', text: 'Safety-netting advice provided. Red flags discussed and patient aware of when to seek urgent review.' },
            { id: uid('macro'), label: 'Follow-up', text: 'Follow-up arranged with appropriate timeframe and patient advised regarding next steps.' }
          ],
          customTags: ['Urgent', 'Follow-up', 'Medication review']
        };
      }

      function createTranscriptEntry(overrides = {}) {
        const timestamp = typeof overrides.timestamp === 'number' ? overrides.timestamp : Date.now();
        const confidence = typeof overrides.confidence === 'number' ? clamp(overrides.confidence, 0, 1) : null;
        return {
          id: overrides.id || uid('entry'),
          text: overrides.text || '',
          timestamp,
          confidence,
          isImportantMarker: Boolean(overrides.isImportantMarker),
          rawText: overrides.rawText || null,
          lastUpdatedAt: typeof overrides.lastUpdatedAt === 'number' ? overrides.lastUpdatedAt : timestamp,
          sampleCount: typeof overrides.sampleCount === 'number' ? overrides.sampleCount : (confidence != null ? 1 : 0),
          flags: Object.assign({}, overrides.flags || {}, { isImportantMarker: Boolean(overrides.isImportantMarker) })
        };
      }

      function createSession(overrides = {}) {
        const now = Date.now();
        const status = overrides.status || 'stopped';
        return {
          id: overrides.id || uid('session'),
          patientName: overrides.patientName || '',
          clinicianName: overrides.clinicianName || '',
          consultationType: overrides.consultationType || '',
          createdAt: typeof overrides.createdAt === 'number' ? overrides.createdAt : now,
          updatedAt: typeof overrides.updatedAt === 'number' ? overrides.updatedAt : now,
          startedAt: typeof overrides.startedAt === 'number' ? overrides.startedAt : now,
          stoppedAt: typeof overrides.stoppedAt === 'number' ? overrides.stoppedAt : (status === 'stopped' ? now : null),
          lastStartedSegmentAt: typeof overrides.lastStartedSegmentAt === 'number' ? overrides.lastStartedSegmentAt : null,
          elapsedMs: typeof overrides.elapsedMs === 'number' ? overrides.elapsedMs : 0,
          transcriptEntries: Array.isArray(overrides.transcriptEntries) ? overrides.transcriptEntries.map((entry) => createTranscriptEntry(entry)) : [],
          manualNotes: overrides.manualNotes || '',
          tags: Array.isArray(overrides.tags) ? dedupeStrings(overrides.tags) : [],
          status,
          archived: Boolean(overrides.archived),
          archivedAt: typeof overrides.archivedAt === 'number' ? overrides.archivedAt : null,
          provider: overrides.provider || 'webkitSpeechRecognition'
        };
      }

      function normaliseSession(rawSession) {
        const session = createSession(rawSession || {});
        session.transcriptEntries = (Array.isArray(rawSession && rawSession.transcriptEntries) ? rawSession.transcriptEntries : []).map((entry) => createTranscriptEntry(entry));
        session.tags = dedupeStrings(rawSession && rawSession.tags);
        if (session.status === 'listening') {
          session.status = 'paused';
          session.lastStartedSegmentAt = null;
        }
        if (session.status === 'paused' || session.status === 'stopped' || session.status === 'idle') session.lastStartedSegmentAt = null;
        if (session.status === 'idle') session.stoppedAt = session.stoppedAt || session.updatedAt || session.createdAt;
        return session;
      }

      function getSessionElapsedMs(session) {
        if (!session) return 0;
        let elapsed = Math.max(0, session.elapsedMs || 0);
        if (session.status === 'listening' && session.lastStartedSegmentAt) elapsed += Math.max(0, Date.now() - session.lastStartedSegmentAt);
        return elapsed;
      }

      function buildTranscriptPlainText(session) {
        const entries = Array.isArray(session.transcriptEntries) ? session.transcriptEntries : [];
        return entries.map((entry) => {
          const offset = session.startedAt ? formatDuration(Math.max(0, entry.timestamp - session.startedAt)) : '00:00:00';
          const prefix = '[' + formatClock(entry.timestamp) + ' | +' + offset + '] ';
          return entry.isImportantMarker ? prefix + '*** IMPORTANT MOMENT ***' : prefix + entry.text;
        }).join('\n');
      }

      function buildSessionExportText(session) {
        const lines = [];
        lines.push('Organisation: ' + (state.customisation.organisationName || ''));
        lines.push('Patient: ' + (session.patientName || ''));
        lines.push('Clinician: ' + (session.clinicianName || ''));
        lines.push('Consultation Type: ' + (session.consultationType || ''));
        lines.push('Status: ' + titleCaseStatus(session.status));
        lines.push('Date: ' + formatDateTime(session.startedAt || session.createdAt));
        lines.push('Duration: ' + formatDuration(getSessionElapsedMs(session)));
        lines.push('Tags: ' + ((session.tags || []).join(', ') || '-'));
        lines.push('');
        lines.push('Transcript');
        lines.push('----------');
        lines.push(buildTranscriptPlainText(session) || 'No transcript recorded.');
        lines.push('');
        lines.push('Manual Notes');
        lines.push('------------');
        lines.push(session.manualNotes || 'No manual notes.');
        return lines.join('\n');
      }

      function loadSettings() {
        const saved = readStorage(STORAGE_KEYS.settings, {});
        const merged = Object.assign(createDefaultSettings(), saved || {});
        merged.autoSaveInterval = clamp(Number(merged.autoSaveInterval) || 5, 1, 30);
        merged.dataRetentionDays = Math.max(0, Number(merged.dataRetentionDays) || 0);
        merged.transcriptFontSize = clamp(Number(merged.transcriptFontSize) || 16, 14, 24);
        merged.transcriptLineSpacing = clamp(Number(merged.transcriptLineSpacing) || 1.55, 1.2, 2);
        merged.theme = merged.theme === 'dark' ? 'dark' : 'light';
        merged.locale = merged.locale || 'en-GB';
        merged.autoPunctuation = Boolean(merged.autoPunctuation);
        merged.interimResults = Boolean(merged.interimResults);
        merged.saveRawTranscript = Boolean(merged.saveRawTranscript);
        return merged;
      }

      function saveSettings() {
        if (!writeStorage(STORAGE_KEYS.settings, state.settings)) showToast('Unable to save settings locally.', 'error', 4200);
      }

      function loadCustomisation() {
        const saved = readStorage(STORAGE_KEYS.customisation, {});
        const base = createDefaultCustomisation();
        const merged = Object.assign({}, base, saved || {});
        merged.organisationName = normaliseWhitespace(merged.organisationName) || base.organisationName;
        merged.brandingColor = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(merged.brandingColor || '') ? merged.brandingColor : base.brandingColor;
        merged.defaultConsultationType = normaliseWhitespace(merged.defaultConsultationType) || base.defaultConsultationType;
        merged.macros = Array.isArray(saved && saved.macros) ? saved.macros.map((macro) => ({ id: macro.id || uid('macro'), label: normaliseWhitespace(macro.label) || 'Snippet', text: String(macro.text || '') })) : base.macros;
        merged.customTags = dedupeStrings(Array.isArray(saved && saved.customTags) ? saved.customTags : base.customTags);
        return merged;
      }

      function saveCustomisation() {
        if (!writeStorage(STORAGE_KEYS.customisation, state.customisation)) showToast('Unable to save customisation locally.', 'error', 4200);
      }

      function loadSessions() {
        const saved = readStorage(STORAGE_KEYS.sessions, []);
        const sessions = Array.isArray(saved) ? saved.map(normaliseSession) : [];
        sessions.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
        return sessions;
      }

      function persistSessions() {
        try {
          state.sessions.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
          if (!writeStorage(STORAGE_KEYS.sessions, state.sessions)) throw new Error('write failed');
          state.lastPersistedAt = Date.now();
          renderLastSavedLabel();
          if (state.currentTab === 'history') {
            renderHistoryList();
            if (!state.historyEditMode) renderHistoryDetail();
          }
        } catch (error) {
          showToast('Unable to save locally. Local storage may be full or unavailable.', 'error', 4200);
        }
      }

      function purgeOldSessions() {
        const retentionDays = Number(state.settings.dataRetentionDays);
        if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
        const cutoff = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
        const beforeCount = state.sessions.length;
        state.sessions = state.sessions.filter((session) => {
          const anchor = session.startedAt || session.createdAt || session.updatedAt || Date.now();
          return anchor >= cutoff;
        });
        return beforeCount - state.sessions.length;
      }

      const persistSessionsDebounced = debounce(() => { persistSessions(); }, 450);

      const state = {
        currentTab: 'consultation',
        settings: loadSettings(),
        customisation: loadCustomisation(),
        sessions: loadSessions(),
        activeSession: null,
        consultationDraftTags: [],
        interimText: '',
        transcriptSearch: '',
        historySelectedSessionId: null,
        historyEditMode: false,
        historyDetailSearch: '',
        timerIntervalId: null,
        autoSaveIntervalId: null,
        speechProvider: null,
        supportsSpeech: 'webkitSpeechRecognition' in window,
        lastPersistedAt: null
      };

      const refs = {
        toastContainer: $('toastContainer'),
        orgDisplay: $('orgDisplay'),
        consultationOrgName: $('consultationOrgName'),
        patientName: $('patientName'),
        clinicianName: $('clinicianName'),
        consultationType: $('consultationType'),
        manualNotes: $('manualNotes'),
        statusPill: $('statusPill'),
        sessionTimer: $('sessionTimer'),
        speechSupportMessage: $('speechSupportMessage'),
        transcriptEditHint: $('transcriptEditHint'),
        transcriptContainer: $('transcriptContainer'),
        interimContainer: $('interimContainer'),
        interimText: $('interimText'),
        transcriptSearch: $('transcriptSearch'),
        copyTranscriptBtn: $('copyTranscriptBtn'),
        exportTranscriptBtn: $('exportTranscriptBtn'),
        startBtn: $('startBtn'),
        stopBtn: $('stopBtn'),
        pauseBtn: $('pauseBtn'),
        resumeBtn: $('resumeBtn'),
        markImportantBtn: $('markImportantBtn'),
        saveSessionBtn: $('saveSessionBtn'),
        macroBar: $('macroBar'),
        tagSelector: $('tagSelector'),
        activeSessionStateText: $('activeSessionStateText'),
        lastSavedLabel: $('lastSavedLabel'),
        sessionSummaryLabel: $('sessionSummaryLabel'),
        sessionList: $('sessionList'),
        historyCount: $('historyCount'),
        historyPatientFilter: $('historyPatientFilter'),
        historyClinicianFilter: $('historyClinicianFilter'),
        historyDateFilter: $('historyDateFilter'),
        historyHideArchived: $('historyHideArchived'),
        historyDetail: $('historyDetail'),
        historyEditToggle: $('historyEditToggle'),
        historySaveBtn: $('historySaveBtn'),
        historyDetailHint: $('historyDetailHint'),
        settingLocale: $('settingLocale'),
        settingAutoPunctuation: $('settingAutoPunctuation'),
        settingInterimResults: $('settingInterimResults'),
        settingSaveRawTranscript: $('settingSaveRawTranscript'),
        settingAutoSaveInterval: $('settingAutoSaveInterval'),
        settingAutoSaveIntervalValue: $('settingAutoSaveIntervalValue'),
        settingTheme: $('settingTheme'),
        settingDataRetentionDays: $('settingDataRetentionDays'),
        settingTranscriptFontSize: $('settingTranscriptFontSize'),
        settingTranscriptFontSizeValue: $('settingTranscriptFontSizeValue'),
        settingLineSpacing: $('settingLineSpacing'),
        settingLineSpacingValue: $('settingLineSpacingValue'),
        customOrgName: $('customOrgName'),
        customBrandColor: $('customBrandColor'),
        customBrandColorValue: $('customBrandColorValue'),
        customDefaultConsultationType: $('customDefaultConsultationType'),
        brandPreviewTitle: $('brandPreviewTitle'),
        brandPreview: $('brandPreview'),
        newMacroLabel: $('newMacroLabel'),
        newMacroText: $('newMacroText'),
        addMacroBtn: $('addMacroBtn'),
        macroList: $('macroList'),
        newCustomTag: $('newCustomTag'),
        addCustomTagBtn: $('addCustomTagBtn'),
        customTagList: $('customTagList')
      };

      class WebkitSpeechProvider {
        constructor(callbacks) {
          this.callbacks = callbacks;
          this.recognition = null;
          this.shouldBeRunning = false;
          this.paused = false;
          this.restartTimer = null;
          this.pendingSessionId = null;
          this.activeSessionId = null;
        }

        get supported() { return 'webkitSpeechRecognition' in window; }

        ensureRecognition() {
          if (!this.supported) return null;
          if (this.recognition) return this.recognition;
          const recognition = new window.webkitSpeechRecognition();
          recognition.continuous = true;
          recognition.interimResults = Boolean(state.settings.interimResults);
          recognition.lang = state.settings.locale;
          recognition.maxAlternatives = 1;
          recognition.onstart = () => {
            this.activeSessionId = this.pendingSessionId || this.activeSessionId;
            this.callbacks.onProviderStarted(this.activeSessionId);
          };
          recognition.onresult = (event) => {
            let interim = '';
            const sessionId = this.activeSessionId;
            for (let index = event.resultIndex; index < event.results.length; index += 1) {
              const result = event.results[index];
              const alternative = result[0];
              if (result.isFinal) {
                this.callbacks.onFinalResult({ sessionId, text: (alternative.transcript || '').trim(), rawText: alternative.transcript || '', confidence: typeof alternative.confidence === 'number' ? alternative.confidence : null, timestamp: Date.now() });
              } else if (state.settings.interimResults) {
                interim += alternative.transcript || '';
              }
            }
            this.callbacks.onInterimResult({ sessionId, text: interim.trim() });
          };
          recognition.onerror = (event) => {
            const code = event && event.error ? event.error : 'unknown';
            if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(code)) this.shouldBeRunning = false;
            this.callbacks.onError({ sessionId: this.activeSessionId || this.pendingSessionId, code });
          };
          recognition.onend = () => {
            const endedSessionId = this.activeSessionId || this.pendingSessionId;
            this.callbacks.onInterimResult({ sessionId: endedSessionId, text: '' });
            const shouldRestart = this.shouldBeRunning && !this.paused;
            this.callbacks.onProviderEnded(endedSessionId);
            if (shouldRestart) {
              this.pendingSessionId = endedSessionId;
              window.clearTimeout(this.restartTimer);
              this.restartTimer = window.setTimeout(() => this.safeStart(), 280);
            } else {
              this.activeSessionId = null;
            }
          };
          this.recognition = recognition;
          return recognition;
        }

        applyConfig() {
          const recognition = this.ensureRecognition();
          if (!recognition) return;
          recognition.lang = state.settings.locale;
          recognition.interimResults = Boolean(state.settings.interimResults);
        }

        safeStart() {
          const recognition = this.ensureRecognition();
          if (!recognition) return;
          this.applyConfig();
          try {
            recognition.start();
          } catch (error) {
            const message = String(error && error.message ? error.message : error);
            if (!/already started|aborted/i.test(message)) {
              window.setTimeout(() => { try { recognition.start(); } catch (_) {} }, 300);
            }
          }
        }

        start(sessionId) {
          this.pendingSessionId = sessionId || this.pendingSessionId;
          this.shouldBeRunning = true;
          this.paused = false;
          this.safeStart();
        }

        pause() {
          this.shouldBeRunning = false;
          this.paused = true;
          window.clearTimeout(this.restartTimer);
          if (this.recognition) { try { this.recognition.stop(); } catch (_) {} }
        }

        stop() {
          this.shouldBeRunning = false;
          this.paused = false;
          window.clearTimeout(this.restartTimer);
          if (this.recognition) { try { this.recognition.stop(); } catch (_) {} }
        }
      }

      function findSession(sessionId) { return state.sessions.find((session) => session.id === sessionId) || null; }

      function getSelectedConsultationTags() {
        return Array.from(refs.tagSelector.querySelectorAll('.tag-chip.selected')).map((chip) => chip.dataset.tag);
      }

      function readConsultationForm() {
        return {
          patientName: refs.patientName.value.trim(),
          clinicianName: refs.clinicianName.value.trim(),
          consultationType: refs.consultationType.value.trim() || state.customisation.defaultConsultationType || 'General consultation',
          manualNotes: refs.manualNotes.value,
          tags: state.activeSession ? getSelectedConsultationTags() : state.consultationDraftTags.slice()
        };
      }

      function syncActiveSessionFromForm() {
        if (!state.activeSession) return;
        const values = readConsultationForm();
        state.activeSession.patientName = values.patientName;
        state.activeSession.clinicianName = values.clinicianName;
        state.activeSession.consultationType = values.consultationType;
        state.activeSession.manualNotes = values.manualNotes;
        state.activeSession.tags = dedupeStrings(values.tags);
        state.activeSession.updatedAt = Date.now();
        upsertSession(state.activeSession);
      }

      function upsertSession(session) {
        const index = state.sessions.findIndex((item) => item.id === session.id);
        if (index === -1) state.sessions.unshift(session);
        else state.sessions[index] = session;
        if (state.activeSession && state.activeSession.id === session.id) state.activeSession = session;
        state.sessions.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
      }

      function createSessionFromConsultation(status = 'stopped') {
        const now = Date.now();
        const formValues = readConsultationForm();
        const session = createSession({ patientName: formValues.patientName, clinicianName: formValues.clinicianName, consultationType: formValues.consultationType, manualNotes: formValues.manualNotes, tags: formValues.tags.slice(), status, startedAt: now, createdAt: now, updatedAt: now, elapsedMs: 0, lastStartedSegmentAt: null, stoppedAt: status === 'stopped' ? now : null });
        state.activeSession = session;
        state.consultationDraftTags = formValues.tags.slice();
        upsertSession(session);
        return session;
      }

      function populateConsultationForm(session) {
        const source = session || null;
        refs.patientName.value = source ? source.patientName || '' : '';
        refs.clinicianName.value = source ? source.clinicianName || '' : '';
        refs.consultationType.value = source ? (source.consultationType || state.customisation.defaultConsultationType || '') : (state.customisation.defaultConsultationType || '');
        refs.manualNotes.value = source ? (source.manualNotes || '') : '';
        state.consultationDraftTags = source ? (source.tags || []).slice() : [];
      }

      function resetConsultationDraft(keepIdentityFields = false) {
        if (!keepIdentityFields) { refs.patientName.value = ''; refs.clinicianName.value = ''; }
        refs.consultationType.value = state.customisation.defaultConsultationType || '';
        refs.manualNotes.value = '';
        refs.transcriptSearch.value = '';
        state.consultationDraftTags = [];
        state.activeSession = null;
        state.interimText = '';
        state.transcriptSearch = '';
      }

      function renderLastSavedLabel() {
        refs.lastSavedLabel.textContent = state.lastPersistedAt ? ('Last saved ' + formatDateTime(state.lastPersistedAt)) : 'Not yet saved';
      }

      function renderConsultationSummaryLabel() {
        const session = state.activeSession;
        if (!session) { refs.sessionSummaryLabel.textContent = 'No active session'; return; }
        const tagText = session.tags && session.tags.length ? (' • Tags: ' + session.tags.join(', ')) : '';
        refs.sessionSummaryLabel.textContent = formatDuration(getSessionElapsedMs(session)) + ' • ' + titleCaseStatus(session.status) + tagText;
      }

      function ensureTimerRunning() {
        if (state.timerIntervalId) return;
        state.timerIntervalId = window.setInterval(() => renderTimer(), 300);
      }

      function stopTimer() {
        window.clearInterval(state.timerIntervalId);
        state.timerIntervalId = null;
      }

      function renderTimer() { refs.sessionTimer.textContent = formatDuration(getSessionElapsedMs(state.activeSession)); }

      function updateStatusPill() {
        const status = state.activeSession ? state.activeSession.status : 'idle';
        refs.statusPill.className = 'status-pill ' + status;
        refs.statusPill.textContent = titleCaseStatus(status);
      }

      function refreshControlStates() {
        const status = state.activeSession ? state.activeSession.status : 'idle';
        refs.startBtn.disabled = !state.supportsSpeech || status === 'listening';
        refs.pauseBtn.disabled = status !== 'listening';
        refs.resumeBtn.disabled = !state.supportsSpeech || status !== 'paused';
        refs.stopBtn.disabled = !(status === 'listening' || status === 'paused');
        refs.markImportantBtn.disabled = !state.activeSession;
      }

      function renderSessionHint() {
        const session = state.activeSession;
        const hasSearch = Boolean((state.transcriptSearch || '').trim());
        if (!session) { refs.transcriptEditHint.textContent = 'Start listening to begin transcription, or save a note-only session at any time.'; return; }
        if (session.status === 'stopped') {
          refs.transcriptEditHint.textContent = hasSearch ? 'Clear the transcript search box to resume inline editing.' : 'Stopped sessions are editable. Click inside a segment to correct wording or punctuation.';
          return;
        }
        if (session.status === 'paused') { refs.transcriptEditHint.textContent = 'Recording is paused. Resume to continue, or stop to edit the transcript.'; return; }
        refs.transcriptEditHint.textContent = 'Final results are grouped into continuous blocks while listening. Stop the session to edit.';
      }

      function renderSpeechSupportBanner() {
        if (state.supportsSpeech) {
          refs.speechSupportMessage.classList.remove('visible');
          refs.speechSupportMessage.textContent = '';
          return;
        }
        refs.speechSupportMessage.classList.add('visible');
        refs.speechSupportMessage.textContent = 'Speech recognition is not supported in this browser. Open this file in Chrome to use live transcription. Manual notes, session saving, history, settings, and customisation still work.';
      }

      function renderActiveSessionStateText() {
        const session = state.activeSession;
        if (!session) { refs.activeSessionStateText.textContent = 'No active session. Manual notes can still be captured and saved.'; return; }
        refs.activeSessionStateText.textContent = 'Auto-save every ' + state.settings.autoSaveInterval + 's • ' + titleCaseStatus(session.status) + ' • Started ' + formatDateTime(session.startedAt);
      }

      function renderConsultationChrome() {
        updateStatusPill();
        renderTimer();
        renderSessionHint();
        renderActiveSessionStateText();
        renderLastSavedLabel();
        renderConsultationSummaryLabel();
        refreshControlStates();
      }

      function renderMacroBar() {
        const macros = state.customisation.macros || [];
        if (!macros.length) { refs.macroBar.innerHTML = '<span class="subtle-note">No reusable snippets configured yet.</span>'; return; }
        refs.macroBar.innerHTML = macros.map((macro) => '<button class="macro-chip" type="button" data-macro-id="' + escapeAttribute(macro.id) + '">' + escapeHtml(macro.label) + '</button>').join('');
      }

      function getAvailableTags(selectedTags = []) {
        const combined = new Set([...(state.customisation.customTags || []), ...(selectedTags || [])]);
        return Array.from(combined).filter(Boolean);
      }

      function renderConsultationTagSelector() {
        const selected = state.activeSession ? (state.activeSession.tags || []) : state.consultationDraftTags;
        const tags = getAvailableTags(selected);
        if (!tags.length) { refs.tagSelector.innerHTML = '<span class="subtle-note">No custom tags configured yet. Add them in Customisation.</span>'; return; }
        refs.tagSelector.innerHTML = tags.map((tag) => '<button type="button" class="tag-chip' + (selected.includes(tag) ? ' selected' : '') + '" data-tag="' + escapeAttribute(tag) + '">' + escapeHtml(tag) + '</button>').join('');
      }

      function renderInterim() {
        const show = Boolean(state.interimText && state.settings.interimResults && state.activeSession && state.activeSession.status === 'listening');
        refs.interimContainer.classList.toggle('hidden', !show);
        refs.interimText.textContent = show ? state.interimText : '';
      }

      function getTranscriptDisplayEntries(session, searchTerm) {
        const entries = Array.isArray(session && session.transcriptEntries) ? session.transcriptEntries : [];
        const query = String(searchTerm || '').trim().toLowerCase();
        if (!query) return entries;
        return entries.filter((entry) => entry.isImportantMarker || String(entry.text || '').toLowerCase().includes(query));
      }

      function handleTranscriptEntryUpdate(sessionId, entryId, newText, persistImmediately = false) {
        const session = findSession(sessionId);
        if (!session) return;
        const entry = session.transcriptEntries.find((item) => item.id === entryId);
        if (!entry) return;
        entry.text = newText;
        entry.lastUpdatedAt = Date.now();
        session.updatedAt = Date.now();
        upsertSession(session);
        if (persistImmediately) persistSessionsDebounced();
        if (state.activeSession && state.activeSession.id === session.id) renderConsultationChrome();
      }

      function renderTranscriptEntries(container, session, options = {}) {
        const searchTerm = String(options.searchTerm || '').trim();
        const editable = Boolean(options.editable);
        const emptyMessage = options.emptyMessage || 'No transcript recorded yet.';
        const onEntryChange = typeof options.onEntryChange === 'function' ? options.onEntryChange : null;
        const entries = getTranscriptDisplayEntries(session, searchTerm);
        container.innerHTML = '';
        if (!entries.length) {
          container.innerHTML = '<div class="empty-state small">' + escapeHtml(searchTerm ? 'No matching transcript segments.' : emptyMessage) + '</div>';
          return;
        }
        entries.forEach((entry) => {
          const article = document.createElement('article');
          article.className = 'transcript-entry' + (entry.isImportantMarker ? ' marker' : '');
          const header = document.createElement('div');
          header.className = 'transcript-entry-head';
          const meta = document.createElement('div');
          meta.className = 'entry-meta';
          meta.innerHTML = '<span class="timestamp-badge">' + escapeHtml(formatClock(entry.timestamp)) + '</span>' + '<span class="offset-badge">+' + escapeHtml(formatDuration(Math.max(0, (entry.timestamp || 0) - (session.startedAt || entry.timestamp || 0)))) + '</span>' + (entry.isImportantMarker ? '<span class="meta-badge">Important moment</span>' : (entry.confidence != null ? '<span class="confidence-pill">' + Math.round(entry.confidence * 100) + '% confidence</span>' : ''));
          header.appendChild(meta);
          const body = document.createElement('div');
          body.className = 'transcript-text';
          const allowEditing = editable && !searchTerm && !entry.isImportantMarker;
          if (allowEditing) {
            body.setAttribute('contenteditable', 'true');
            body.setAttribute('spellcheck', 'true');
            body.dataset.entryId = entry.id;
            body.textContent = entry.text || '';
            body.addEventListener('paste', (event) => {
              event.preventDefault();
              const text = (event.clipboardData || window.clipboardData).getData('text/plain');
              document.execCommand('insertText', false, text);
            });
            body.addEventListener('blur', () => {
              const updatedText = normaliseWhitespace(body.textContent);
              body.textContent = updatedText;
              if (onEntryChange) onEntryChange(entry.id, updatedText);
            });
          } else {
            body.innerHTML = entry.isImportantMarker ? '<strong>Important moment</strong>' : highlightText(entry.text || '', searchTerm);
          }
          article.appendChild(header);
          article.appendChild(body);
          container.appendChild(article);
        });
      }

      function renderConsultationTranscript() {
        const session = state.activeSession;
        if (!session) {
          refs.transcriptContainer.innerHTML = '<div class="empty-state">Start listening to populate the live transcript. Important markers and transcript edits appear here.</div>';
          renderInterim();
          return;
        }
        renderTranscriptEntries(refs.transcriptContainer, session, { searchTerm: state.transcriptSearch, editable: session.status === 'stopped', emptyMessage: 'Transcript entries will appear as timestamped blocks.', onEntryChange: (entryId, newText) => handleTranscriptEntryUpdate(session.id, entryId, newText, true) });
        renderInterim();
      }

      function renderConsultation() {
        renderSpeechSupportBanner();
        renderMacroBar();
        renderConsultationTagSelector();
        renderConsultationChrome();
        renderConsultationTranscript();
      }

      function getFilteredSessions() {
        const patientQuery = refs.historyPatientFilter.value.trim().toLowerCase();
        const clinicianQuery = refs.historyClinicianFilter.value.trim().toLowerCase();
        const dateQuery = refs.historyDateFilter.value;
        const hideArchived = refs.historyHideArchived.checked;
        return state.sessions
          .filter((session) => !hideArchived || !session.archived)
          .filter((session) => !patientQuery || (session.patientName || '').toLowerCase().includes(patientQuery))
          .filter((session) => !clinicianQuery || (session.clinicianName || '').toLowerCase().includes(clinicianQuery))
          .filter((session) => !dateQuery || toLocalDateInputValue(session.startedAt || session.createdAt) === dateQuery)
          .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
      }

      function renderHistoryList() {
        const sessions = getFilteredSessions();
        refs.historyCount.textContent = sessions.length === state.sessions.length ? String(sessions.length) : (String(sessions.length) + ' / ' + String(state.sessions.length));
        if (!sessions.length) {
          refs.sessionList.innerHTML = '<div class="empty-state">No sessions match the current history filters.</div>';
          return;
        }
        refs.sessionList.innerHTML = sessions.map((session) => {
          const selected = session.id === state.historySelectedSessionId;
          const statusClass = session.status || 'stopped';
          const tags = (session.tags || []).slice(0, 3).map((tag) => '<span class="plain-chip secondary">' + escapeHtml(tag) + '</span>').join('');
          return '<article class="session-card' + (selected ? ' selected' : '') + (session.archived ? ' archived' : '') + '" data-session-id="' + escapeAttribute(session.id) + '">' +
            '<div class="session-card-head"><div><h4 class="session-card-title">' + escapeHtml(session.patientName || 'Untitled patient') + '</h4><div class="session-card-subtitle">' + escapeHtml(session.clinicianName || 'No clinician name') + '</div></div><div class="inline-actions"><span class="status-pill ' + statusClass + '">' + escapeHtml(titleCaseStatus(statusClass)) + '</span>' + (session.archived ? '<span class="archived-badge">Archived</span>' : '') + '</div></div>' +
            '<div class="session-card-meta"><span class="meta-badge">' + escapeHtml(formatDateTime(session.startedAt || session.createdAt)) + '</span><span class="meta-badge">' + escapeHtml(formatDuration(getSessionElapsedMs(session))) + '</span><span class="meta-badge">' + escapeHtml(session.consultationType || 'Consultation') + '</span></div>' +
            (tags ? '<div class="tag-row">' + tags + '</div>' : '') +
            '<div class="session-card-actions"><button class="btn small" type="button" data-action="open" data-session-id="' + escapeAttribute(session.id) + '">Open</button><button class="btn small" type="button" data-action="duplicate" data-session-id="' + escapeAttribute(session.id) + '">Duplicate</button><button class="btn small warning" type="button" data-action="archive" data-session-id="' + escapeAttribute(session.id) + '">' + (session.archived ? 'Restore' : 'Archive') + '</button><button class="btn small danger" type="button" data-action="delete" data-session-id="' + escapeAttribute(session.id) + '">Delete</button></div></article>';
        }).join('');
      }

      function getSelectedHistorySession() { return state.sessions.find((session) => session.id === state.historySelectedSessionId) || null; }

      function renderHistoryTags(container, session, editable) {
        const selectedTags = session.tags || [];
        const tags = getAvailableTags(selectedTags);
        if (!tags.length) { container.innerHTML = '<span class="subtle-note">No tags configured.</span>'; return; }
        if (!editable) {
          if (!selectedTags.length) { container.innerHTML = '<span class="subtle-note">No tags assigned.</span>'; return; }
          container.innerHTML = selectedTags.map((tag) => '<span class="plain-chip">' + escapeHtml(tag) + '</span>').join('');
          return;
        }
        container.innerHTML = tags.map((tag) => '<button type="button" class="tag-chip' + (selectedTags.includes(tag) ? ' selected' : '') + '" data-history-tag="' + escapeAttribute(tag) + '">' + escapeHtml(tag) + '</button>').join('');
      }

      function syncConsultationViewForSession(session) {
        if (state.activeSession && state.activeSession.id === session.id) {
          populateConsultationForm(session);
          renderConsultation();
        }
      }

      function attachHistoryDetailListeners(session, detailRoot) {
        detailRoot.querySelectorAll('[data-history-field]').forEach((input) => {
          input.addEventListener('input', () => {
            session[input.dataset.historyField] = input.value;
            session.updatedAt = Date.now();
            upsertSession(session);
            syncConsultationViewForSession(session);
            if (state.currentTab === 'history') renderHistoryList();
            persistSessionsDebounced();
          });
        });
        const notesEditor = detailRoot.querySelector('#historyNotesEditor');
        if (notesEditor) {
          notesEditor.addEventListener('input', () => {
            session.manualNotes = notesEditor.value;
            session.updatedAt = Date.now();
            upsertSession(session);
            syncConsultationViewForSession(session);
            persistSessionsDebounced();
          });
        }
        const searchInput = detailRoot.querySelector('#historyDetailSearch');
        if (searchInput) {
          searchInput.addEventListener('input', () => {
            state.historyDetailSearch = searchInput.value;
            renderHistoryDetail();
          });
        }
        detailRoot.querySelectorAll('[data-history-tag]').forEach((button) => {
          button.addEventListener('click', () => {
            const tag = button.dataset.historyTag;
            const tags = new Set(session.tags || []);
            if (tags.has(tag)) tags.delete(tag); else tags.add(tag);
            session.tags = Array.from(tags);
            session.updatedAt = Date.now();
            upsertSession(session);
            syncConsultationViewForSession(session);
            persistSessionsDebounced();
            renderHistoryDetail();
            renderHistoryList();
          });
        });
      }

      function renderHistoryDetail() {
        const session = getSelectedHistorySession();
        refs.historyEditToggle.disabled = !session;
        refs.historySaveBtn.disabled = !session;
        refs.historyDetailHint.textContent = session ? 'Review transcript, notes, metadata, and tags for the selected session.' : 'Select a session to review transcript and notes.';
        refs.historyEditToggle.textContent = state.historyEditMode ? 'Read Mode' : 'Edit Mode';
        if (!session) {
          refs.historyDetail.innerHTML = '<div class="empty-state">Select a session from the list to open its transcript and notes.</div>';
          return;
        }
        const editable = state.historyEditMode;
        const detail = refs.historyDetail;
        detail.innerHTML = '<div class="detail-grid">' +
          '<div class="field"><span class="label">Patient</span>' + (editable ? '<input data-history-field="patientName" value="' + escapeAttribute(session.patientName || '') + '" />' : '<div class="static-value">' + escapeHtml(session.patientName || '-') + '</div>') + '</div>' +
          '<div class="field"><span class="label">Clinician</span>' + (editable ? '<input data-history-field="clinicianName" value="' + escapeAttribute(session.clinicianName || '') + '" />' : '<div class="static-value">' + escapeHtml(session.clinicianName || '-') + '</div>') + '</div>' +
          '<div class="field"><span class="label">Consultation Type</span>' + (editable ? '<input data-history-field="consultationType" value="' + escapeAttribute(session.consultationType || '') + '" />' : '<div class="static-value">' + escapeHtml(session.consultationType || '-') + '</div>') + '</div>' +
          '</div>' +
          '<div class="detail-block"><div class="detail-header-row"><div><h4 style="margin:0;">Metadata</h4><div class="subtle-note">Started ' + escapeHtml(formatDateTime(session.startedAt || session.createdAt)) + ' • Duration ' + escapeHtml(formatDuration(getSessionElapsedMs(session))) + ' • Updated ' + escapeHtml(formatDateTime(session.updatedAt)) + '</div></div><div class="inline-actions"><span class="status-pill ' + escapeAttribute(session.status) + '">' + escapeHtml(titleCaseStatus(session.status)) + '</span>' + (session.archived ? '<span class="archived-badge">Archived</span>' : '') + '</div></div><div class="tag-selector" id="historyTagList"></div></div>' +
          '<div class="detail-block"><div class="detail-header-row"><div><h4 style="margin:0;">Manual notes</h4><div class="subtle-note">Editable when history detail is in edit mode.</div></div></div>' + (editable ? '<textarea id="historyNotesEditor" class="manual-notes" style="min-height:140px;">' + escapeHtml(session.manualNotes || '') + '</textarea>' : '<div class="note-preview">' + escapeHtml(session.manualNotes || 'No manual notes.').replace(/\n/g, '<br>') + '</div>') + '</div>' +
          '<div class="detail-block"><div class="detail-header-row"><div><h4 style="margin:0;">Transcript</h4><div class="subtle-note">' + (editable && !state.historyDetailSearch ? 'Stopped transcripts can be corrected inline.' : 'Search to filter transcript segments.') + '</div></div><input id="historyDetailSearch" class="search-input" type="search" placeholder="Search within this transcript..." value="' + escapeAttribute(state.historyDetailSearch || '') + '" /></div><div class="transcript-container history-transcript" id="historyTranscriptContainer"></div></div>';
        renderHistoryTags(detail.querySelector('#historyTagList'), session, editable);
        renderTranscriptEntries(detail.querySelector('#historyTranscriptContainer'), session, { searchTerm: state.historyDetailSearch, editable: editable && session.status === 'stopped', emptyMessage: 'This session does not yet contain transcript segments.', onEntryChange: (entryId, newText) => {
          const entry = session.transcriptEntries.find((item) => item.id === entryId);
          if (!entry) return;
          entry.text = newText;
          entry.lastUpdatedAt = Date.now();
          session.updatedAt = Date.now();
          upsertSession(session);
          syncConsultationViewForSession(session);
          persistSessionsDebounced();
        } });
        attachHistoryDetailListeners(session, detail);
      }

      function renderHistory() {
        renderHistoryList();
        renderHistoryDetail();
      }

      function applyThemeAndBranding() {
        document.documentElement.dataset.theme = state.settings.theme;
        const color = state.customisation.brandingColor || '#2f7df6';
        const rgb = hexToRgbTuple(color);
        document.documentElement.style.setProperty('--accent', color);
        document.documentElement.style.setProperty('--accent-rgb', rgb.join(', '));
        document.documentElement.style.setProperty('--transcript-font-size', String(state.settings.transcriptFontSize) + 'px');
        document.documentElement.style.setProperty('--transcript-line-spacing', String(state.settings.transcriptLineSpacing));
        refs.orgDisplay.textContent = state.customisation.organisationName || 'Organisation';
        refs.consultationOrgName.textContent = state.customisation.organisationName || 'Organisation';
        refs.customBrandColorValue.textContent = color.toUpperCase();
        refs.brandPreviewTitle.textContent = state.customisation.organisationName || 'Organisation';
      }

      function renderSettingsForm() {
        refs.settingLocale.value = state.settings.locale;
        refs.settingAutoPunctuation.checked = Boolean(state.settings.autoPunctuation);
        refs.settingInterimResults.checked = Boolean(state.settings.interimResults);
        refs.settingSaveRawTranscript.checked = Boolean(state.settings.saveRawTranscript);
        refs.settingAutoSaveInterval.value = String(state.settings.autoSaveInterval);
        refs.settingAutoSaveIntervalValue.textContent = state.settings.autoSaveInterval + 's';
        refs.settingTheme.value = state.settings.theme;
        refs.settingDataRetentionDays.value = String(state.settings.dataRetentionDays);
        refs.settingTranscriptFontSize.value = String(state.settings.transcriptFontSize);
        refs.settingTranscriptFontSizeValue.textContent = state.settings.transcriptFontSize + 'px';
        refs.settingLineSpacing.value = String(state.settings.transcriptLineSpacing);
        refs.settingLineSpacingValue.textContent = Number(state.settings.transcriptLineSpacing).toFixed(2);
      }

      function renderMacroEditor() {
        const macros = state.customisation.macros || [];
        if (!macros.length) { refs.macroList.innerHTML = '<div class="empty-state small">No snippets yet. Add one above to make note capture faster.</div>'; return; }
        refs.macroList.innerHTML = macros.map((macro) => '<div class="list-editor-item" data-macro-id="' + escapeAttribute(macro.id) + '"><div class="field"><label>Label</label><input class="macro-item-label" value="' + escapeAttribute(macro.label) + '" /></div><div class="field"><label>Text</label><textarea class="macro-item-text" rows="4">' + escapeHtml(macro.text) + '</textarea></div><div class="inline-actions"><button class="btn small" type="button" data-action="save-macro" data-macro-id="' + escapeAttribute(macro.id) + '">Save</button><button class="btn small danger" type="button" data-action="delete-macro" data-macro-id="' + escapeAttribute(macro.id) + '">Delete</button></div></div>').join('');
      }

      function renderCustomTagEditor() {
        const tags = state.customisation.customTags || [];
        if (!tags.length) { refs.customTagList.innerHTML = '<div class="empty-state small">No custom tags yet. Add one above to assign reusable labels to sessions.</div>'; return; }
        refs.customTagList.innerHTML = tags.map((tag, index) => '<div class="list-editor-item" data-tag-index="' + index + '"><div class="field"><label>Tag</label><input class="custom-tag-value" value="' + escapeAttribute(tag) + '" /></div><div class="inline-actions"><button class="btn small" type="button" data-action="save-tag" data-tag-index="' + index + '">Save</button><button class="btn small danger" type="button" data-action="delete-tag" data-tag-index="' + index + '">Delete</button></div></div>').join('');
      }

      function renderCustomisationForm() {
        refs.customOrgName.value = state.customisation.organisationName || '';
        refs.customBrandColor.value = state.customisation.brandingColor || '#2f7df6';
        refs.customBrandColorValue.textContent = (state.customisation.brandingColor || '#2f7df6').toUpperCase();
        refs.customDefaultConsultationType.value = state.customisation.defaultConsultationType || '';
        applyThemeAndBranding();
        renderMacroEditor();
        renderCustomTagEditor();
        renderMacroBar();
        renderConsultationTagSelector();
      }

      function resetAutoSaveInterval() {
        window.clearInterval(state.autoSaveIntervalId);
        state.autoSaveIntervalId = window.setInterval(() => {
          if (!state.activeSession) return;
          syncActiveSessionFromForm();
          state.activeSession.updatedAt = Date.now();
          upsertSession(state.activeSession);
          persistSessions();
        }, Math.max(1, Number(state.settings.autoSaveInterval)) * 1000);
      }

      function applySettingsChange() {
        saveSettings();
        applyThemeAndBranding();
        renderSettingsForm();
        renderConsultationChrome();
        renderConsultationTranscript();
        renderHistoryDetail();
        resetAutoSaveInterval();
        if (!state.settings.interimResults) state.interimText = '';
        renderInterim();
        if (state.speechProvider) state.speechProvider.applyConfig();
      }

      function handleRetentionUpdate() {
        const removedCount = purgeOldSessions();
        if (removedCount > 0) {
          if (state.activeSession && !state.sessions.find((session) => session.id === state.activeSession.id)) {
            state.activeSession = null;
            resetConsultationDraft();
          }
          if (state.historySelectedSessionId && !state.sessions.find((session) => session.id === state.historySelectedSessionId)) state.historySelectedSessionId = null;
          persistSessions();
          renderConsultation();
          renderHistory();
          showToast('Removed ' + removedCount + ' session' + (removedCount === 1 ? '' : 's') + ' due to data retention settings.', 'warning', 4200);
        }
      }

      function transitionSessionStatus(session, nextStatus, options = {}) {
        if (!session) return;
        const now = Date.now();
        const shouldStartClock = Boolean(options.startClock);
        if (session.status === 'listening' && session.lastStartedSegmentAt && !(nextStatus === 'listening' && shouldStartClock)) session.elapsedMs += Math.max(0, now - session.lastStartedSegmentAt);
        if (nextStatus === 'listening') {
          session.status = 'listening';
          session.stoppedAt = null;
          session.lastStartedSegmentAt = shouldStartClock ? (session.lastStartedSegmentAt || now) : null;
        } else {
          session.status = nextStatus;
          session.lastStartedSegmentAt = null;
          if (nextStatus === 'stopped') session.stoppedAt = now;
        }
        session.updatedAt = now;
        upsertSession(session);
        if (state.activeSession && state.activeSession.id === session.id) {
          if (nextStatus === 'listening' && session.lastStartedSegmentAt) ensureTimerRunning();
          else stopTimer();
          renderConsultationChrome();
        }
        if (!options.skipPersist) persistSessionsDebounced();
      }

      function appendTranscriptFinalResult(result) {
        const session = findSession(result.sessionId);
        if (!session) return;
        const now = typeof result.timestamp === 'number' ? result.timestamp : Date.now();
        const rawText = normaliseWhitespace(result.rawText || result.text || '');
        let displayText = normaliseWhitespace(result.text || '');
        if (!displayText) return;
        if (state.settings.autoPunctuation) {
          const previousEntry = session.transcriptEntries.length ? session.transcriptEntries[session.transcriptEntries.length - 1] : null;
          const shouldSentenceCase = !previousEntry || previousEntry.isImportantMarker;
          displayText = applyAutoPunctuation(displayText, shouldSentenceCase);
        }
        const lastEntry = session.transcriptEntries.length ? session.transcriptEntries[session.transcriptEntries.length - 1] : null;
        const shouldMerge = Boolean(lastEntry) && !lastEntry.isImportantMarker && (now - (lastEntry.lastUpdatedAt || lastEntry.timestamp || now)) < 12000 && String(lastEntry.text || '').length < 340;
        if (shouldMerge) {
          lastEntry.text = mergeTranscriptText(lastEntry.text || '', displayText);
          if (result.confidence != null) {
            const count = Number(lastEntry.sampleCount || 0);
            const total = (Number(lastEntry.confidence) || 0) * count + result.confidence;
            lastEntry.sampleCount = count + 1;
            lastEntry.confidence = total / lastEntry.sampleCount;
          }
          lastEntry.rawText = state.settings.saveRawTranscript ? mergeTranscriptText(lastEntry.rawText || '', rawText) : null;
          lastEntry.lastUpdatedAt = now;
        } else {
          session.transcriptEntries.push(createTranscriptEntry({ text: displayText, timestamp: now, confidence: result.confidence, isImportantMarker: false, rawText: state.settings.saveRawTranscript ? rawText : null, lastUpdatedAt: now, sampleCount: result.confidence != null ? 1 : 0 }));
        }
        session.updatedAt = Date.now();
        upsertSession(session);
        if (state.activeSession && state.activeSession.id === session.id) {
          renderConsultationTranscript();
          renderConsultationChrome();
          scrollTranscriptToBottom(refs.transcriptContainer);
        }
        if (state.currentTab === 'history') {
          if (state.historySelectedSessionId === session.id) renderHistoryDetail();
          renderHistoryList();
        }
        persistSessionsDebounced();
      }

      function handleSpeechError(payload) {
        const code = payload && payload.code ? payload.code : 'unknown';
        const session = payload && payload.sessionId ? findSession(payload.sessionId) : state.activeSession;
        if (code === 'aborted' || code === 'no-speech') return;
        if (session && (code === 'not-allowed' || code === 'service-not-allowed')) transitionSessionStatus(session, 'stopped', { skipPersist: true });
        else if (session && (code === 'audio-capture' || code === 'network')) transitionSessionStatus(session, 'paused', { skipPersist: true });
        const messageMap = {
          'not-allowed': 'Microphone access was blocked. Allow microphone access in Chrome and try again.',
          'service-not-allowed': 'Speech recognition service access was blocked by the browser.',
          'audio-capture': 'No microphone input was found. Check the selected device and permissions.',
          'network': 'Speech recognition was interrupted. The session remains available.',
          'language-not-supported': 'The selected speech locale is not supported in this browser.'
        };
        showToast(messageMap[code] || ('Speech recognition error: ' + code + '.'), code === 'network' ? 'warning' : 'error', 4200);
        persistSessions();
      }

      function beginListening() {
        if (!state.supportsSpeech || !state.speechProvider) { showToast('Live speech recognition is unavailable in this browser. Open the file in Chrome.', 'warning', 4200); return; }
        if (state.activeSession && state.activeSession.status === 'paused') { resumeListening(); return; }
        state.interimText = '';
        refs.transcriptSearch.value = '';
        state.transcriptSearch = '';
        let session = state.activeSession;
        if (!session || session.status === 'stopped' || session.archived) session = createSessionFromConsultation('listening');
        else syncActiveSessionFromForm();
        transitionSessionStatus(session, 'listening', { startClock: false, skipPersist: true });
        renderConsultation();
        persistSessions();
        state.speechProvider.start(session.id);
      }

      function pauseListening() {
        if (!state.activeSession || state.activeSession.status !== 'listening') return;
        state.interimText = '';
        transitionSessionStatus(state.activeSession, 'paused', { skipPersist: true });
        renderInterim();
        if (state.speechProvider) state.speechProvider.pause();
        persistSessions();
      }

      function resumeListening() {
        if (!state.activeSession || state.activeSession.status !== 'paused') return;
        state.interimText = '';
        transitionSessionStatus(state.activeSession, 'listening', { startClock: false, skipPersist: true });
        renderInterim();
        renderConsultation();
        persistSessions();
        if (state.speechProvider) state.speechProvider.start(state.activeSession.id);
      }

      function stopListening() {
        if (!state.activeSession || !['listening', 'paused'].includes(state.activeSession.status)) return;
        state.interimText = '';
        transitionSessionStatus(state.activeSession, 'stopped', { skipPersist: true });
        renderInterim();
        renderConsultation();
        if (state.speechProvider) state.speechProvider.stop();
        persistSessions();
      }

      function markImportantMoment() {
        if (!state.activeSession) return;
        syncActiveSessionFromForm();
        const now = Date.now();
        state.activeSession.transcriptEntries.push(createTranscriptEntry({ text: '', timestamp: now, isImportantMarker: true, confidence: null, flags: { isImportantMarker: true } }));
        state.activeSession.updatedAt = now;
        upsertSession(state.activeSession);
        renderConsultationTranscript();
        renderConsultationChrome();
        scrollTranscriptToBottom(refs.transcriptContainer);
        if (state.currentTab === 'history' && state.historySelectedSessionId === state.activeSession.id) renderHistoryDetail();
        persistSessionsDebounced();
      }

      function saveSessionImmediately(showFeedback = true) {
        let session = state.activeSession;
        if (!session) session = createSessionFromConsultation('stopped');
        else {
          syncActiveSessionFromForm();
          if (session.status === 'idle') { session.status = 'stopped'; session.stoppedAt = Date.now(); }
          session.updatedAt = Date.now();
          upsertSession(session);
        }
        persistSessions();
        renderConsultation();
        if (showFeedback) showToast('Session saved locally.', 'success');
      }

      function copyCurrentTranscript() {
        if (!state.activeSession || !state.activeSession.transcriptEntries.length) { showToast('There is no transcript to copy yet.', 'warning'); return; }
        copyToClipboard(buildTranscriptPlainText(state.activeSession)).then(() => showToast('Transcript copied to the clipboard.', 'success')).catch(() => showToast('Copy failed in this browser context.', 'error'));
      }

      function exportCurrentTranscript() {
        if (!state.activeSession) { showToast('There is no active session to export.', 'warning'); return; }
        const filename = sanitizeFilenamePart(state.activeSession.patientName || 'session') + '_' + (toLocalDateInputValue(state.activeSession.startedAt || Date.now()) || 'session') + '.txt';
        downloadTextFile(filename, buildSessionExportText(state.activeSession));
        showToast('Plain-text export downloaded.', 'success');
      }

      function selectHistorySession(sessionId) {
        state.historySelectedSessionId = sessionId;
        state.historyDetailSearch = '';
        renderHistoryList();
        renderHistoryDetail();
      }

      function duplicateSession(sessionId) {
        const original = findSession(sessionId);
        if (!original) return;
        const now = Date.now();
        const duration = getSessionElapsedMs(original);
        const originalStart = original.startedAt || original.createdAt || now;
        const newStoppedAt = now;
        const newStartedAt = newStoppedAt - duration;
        const duplicatedEntries = (original.transcriptEntries || []).map((entry) => {
          const offset = Math.max(0, (entry.timestamp || originalStart) - originalStart);
          return createTranscriptEntry(Object.assign({}, deepClone(entry), { id: uid('entry'), timestamp: newStartedAt + offset, lastUpdatedAt: now }));
        });
        const duplicated = createSession(Object.assign({}, deepClone(original), { id: uid('session'), createdAt: now, updatedAt: now, startedAt: newStartedAt, stoppedAt: newStoppedAt, lastStartedSegmentAt: null, elapsedMs: duration, transcriptEntries: duplicatedEntries, archived: false, archivedAt: null, status: 'stopped' }));
        upsertSession(duplicated);
        state.historySelectedSessionId = duplicated.id;
        state.historyEditMode = false;
        persistSessions();
        renderHistory();
        showToast('Session duplicated.', 'success');
      }

      function toggleArchiveSession(sessionId) {
        const session = findSession(sessionId);
        if (!session) return;
        session.archived = !session.archived;
        session.archivedAt = session.archived ? Date.now() : null;
        session.updatedAt = Date.now();
        upsertSession(session);
        persistSessions();
        renderHistory();
        showToast(session.archived ? 'Session archived.' : 'Session restored.', 'success');
      }

      function deleteSession(sessionId) {
        const session = findSession(sessionId);
        if (!session) return;
        if (!window.confirm('Permanently delete ' + (session.patientName || 'this session') + '? This cannot be undone.')) return;
        if (state.activeSession && state.activeSession.id === sessionId) {
          if (state.speechProvider) state.speechProvider.stop();
          stopTimer();
          state.interimText = '';
          resetConsultationDraft();
        }
        state.sessions = state.sessions.filter((item) => item.id !== sessionId);
        if (state.historySelectedSessionId === sessionId) { state.historySelectedSessionId = null; state.historyEditMode = false; }
        persistSessions();
        renderConsultation();
        renderHistory();
        showToast('Session deleted permanently.', 'success');
      }

      function replaceTagAcrossSessions(oldTag, newTag) {
        state.sessions.forEach((session) => {
          session.tags = dedupeStrings((session.tags || []).map((tag) => tag === oldTag ? newTag : tag));
          session.updatedAt = Date.now();
        });
        state.consultationDraftTags = dedupeStrings(state.consultationDraftTags.map((tag) => tag === oldTag ? newTag : tag));
        if (state.activeSession) state.activeSession.tags = dedupeStrings((state.activeSession.tags || []).map((tag) => tag === oldTag ? newTag : tag));
      }

      function removeTagAcrossSessions(tagToRemove) {
        state.sessions.forEach((session) => { session.tags = (session.tags || []).filter((tag) => tag !== tagToRemove); session.updatedAt = Date.now(); });
        state.consultationDraftTags = state.consultationDraftTags.filter((tag) => tag !== tagToRemove);
        if (state.activeSession) state.activeSession.tags = (state.activeSession.tags || []).filter((tag) => tag !== tagToRemove);
      }

      function switchTab(tabName) {
        state.currentTab = tabName;
        document.querySelectorAll('.nav-tab').forEach((button) => button.classList.toggle('active', button.dataset.tab === tabName));
        document.querySelectorAll('.tab-section').forEach((section) => section.classList.toggle('active', section.id === 'section-' + tabName));
        if (tabName === 'consultation') renderConsultation();
        else if (tabName === 'history') renderHistory();
        else if (tabName === 'settings') renderSettingsForm();
        else if (tabName === 'customisation') renderCustomisationForm();
      }

      function attachEventListeners() {
        document.querySelectorAll('.nav-tab').forEach((button) => button.addEventListener('click', () => switchTab(button.dataset.tab)));
        const consultationInputHandler = debounce(() => {
          if (state.activeSession) {
            syncActiveSessionFromForm();
            renderConsultationChrome();
            if (state.currentTab === 'history' && state.historySelectedSessionId === state.activeSession.id) renderHistoryDetail();
            persistSessionsDebounced();
          }
        }, 180);
        [refs.patientName, refs.clinicianName, refs.consultationType, refs.manualNotes].forEach((input) => input.addEventListener('input', consultationInputHandler));
        refs.transcriptSearch.addEventListener('input', () => { state.transcriptSearch = refs.transcriptSearch.value; renderConsultationTranscript(); renderSessionHint(); });
        refs.startBtn.addEventListener('click', beginListening);
        refs.pauseBtn.addEventListener('click', pauseListening);
        refs.resumeBtn.addEventListener('click', resumeListening);
        refs.stopBtn.addEventListener('click', stopListening);
        refs.markImportantBtn.addEventListener('click', markImportantMoment);
        refs.saveSessionBtn.addEventListener('click', () => saveSessionImmediately(true));
        refs.copyTranscriptBtn.addEventListener('click', copyCurrentTranscript);
        refs.exportTranscriptBtn.addEventListener('click', exportCurrentTranscript);
        refs.macroBar.addEventListener('click', (event) => {
          const button = event.target.closest('[data-macro-id]');
          if (!button) return;
          const macro = (state.customisation.macros || []).find((item) => item.id === button.dataset.macroId);
          if (!macro) return;
          insertTextAtCursor(refs.manualNotes, macro.text);
          refs.manualNotes.dispatchEvent(new Event('input', { bubbles: true }));
          showToast('Snippet inserted into manual notes.', 'success', 1800);
        });
        refs.tagSelector.addEventListener('click', (event) => {
          const button = event.target.closest('.tag-chip');
          if (!button) return;
          const tag = button.dataset.tag;
          if (!tag) return;
          if (state.activeSession) {
            const tags = new Set(state.activeSession.tags || []);
            if (tags.has(tag)) tags.delete(tag); else tags.add(tag);
            state.activeSession.tags = Array.from(tags);
            state.activeSession.updatedAt = Date.now();
            upsertSession(state.activeSession);
            persistSessionsDebounced();
            if (state.currentTab === 'history' && state.historySelectedSessionId === state.activeSession.id) renderHistoryDetail();
          } else {
            const tags = new Set(state.consultationDraftTags || []);
            if (tags.has(tag)) tags.delete(tag); else tags.add(tag);
            state.consultationDraftTags = Array.from(tags);
          }
          renderConsultationTagSelector();
          renderConsultationSummaryLabel();
        });
        refs.sessionList.addEventListener('click', (event) => {
          const actionButton = event.target.closest('[data-action]');
          if (actionButton) {
            const sessionId = actionButton.dataset.sessionId;
            const action = actionButton.dataset.action;
            if (!sessionId || !action) return;
            if (action === 'open') selectHistorySession(sessionId);
            if (action === 'duplicate') duplicateSession(sessionId);
            if (action === 'archive') toggleArchiveSession(sessionId);
            if (action === 'delete') deleteSession(sessionId);
            return;
          }
          const card = event.target.closest('.session-card');
          if (card && card.dataset.sessionId) selectHistorySession(card.dataset.sessionId);
        });
        [refs.historyPatientFilter, refs.historyClinicianFilter].forEach((input) => input.addEventListener('input', () => renderHistory()));
        refs.historyDateFilter.addEventListener('change', () => renderHistory());
        refs.historyHideArchived.addEventListener('change', () => renderHistory());
        refs.historyEditToggle.addEventListener('click', () => { if (!getSelectedHistorySession()) return; state.historyEditMode = !state.historyEditMode; renderHistoryDetail(); });
        refs.historySaveBtn.addEventListener('click', () => { if (!getSelectedHistorySession()) return; persistSessions(); showToast('History changes saved.', 'success'); });
        refs.settingLocale.addEventListener('change', () => { state.settings.locale = refs.settingLocale.value; applySettingsChange(); });
        refs.settingAutoPunctuation.addEventListener('change', () => { state.settings.autoPunctuation = refs.settingAutoPunctuation.checked; applySettingsChange(); });
        refs.settingInterimResults.addEventListener('change', () => { state.settings.interimResults = refs.settingInterimResults.checked; applySettingsChange(); });
        refs.settingSaveRawTranscript.addEventListener('change', () => { state.settings.saveRawTranscript = refs.settingSaveRawTranscript.checked; applySettingsChange(); });
        refs.settingAutoSaveInterval.addEventListener('input', () => { state.settings.autoSaveInterval = clamp(Number(refs.settingAutoSaveInterval.value) || 5, 1, 30); applySettingsChange(); });
        refs.settingTheme.addEventListener('change', () => { state.settings.theme = refs.settingTheme.value === 'dark' ? 'dark' : 'light'; applySettingsChange(); });
        refs.settingDataRetentionDays.addEventListener('input', () => { state.settings.dataRetentionDays = Math.max(0, Number(refs.settingDataRetentionDays.value) || 0); saveSettings(); renderSettingsForm(); handleRetentionUpdate(); });
        refs.settingTranscriptFontSize.addEventListener('input', () => { state.settings.transcriptFontSize = clamp(Number(refs.settingTranscriptFontSize.value) || 16, 14, 24); applySettingsChange(); });
        refs.settingLineSpacing.addEventListener('input', () => { state.settings.transcriptLineSpacing = clamp(Number(refs.settingLineSpacing.value) || 1.55, 1.2, 2); applySettingsChange(); });
        refs.customOrgName.addEventListener('input', () => { state.customisation.organisationName = normaliseWhitespace(refs.customOrgName.value) || 'Organisation'; saveCustomisation(); applyThemeAndBranding(); renderConsultation(); });
        refs.customBrandColor.addEventListener('input', () => { state.customisation.brandingColor = refs.customBrandColor.value; saveCustomisation(); applyThemeAndBranding(); renderConsultation(); });
        refs.customDefaultConsultationType.addEventListener('input', () => {
          const previousDefault = state.customisation.defaultConsultationType;
          state.customisation.defaultConsultationType = normaliseWhitespace(refs.customDefaultConsultationType.value) || 'General consultation';
          if (!state.activeSession && (!refs.consultationType.value || refs.consultationType.value === previousDefault)) refs.consultationType.value = state.customisation.defaultConsultationType;
          saveCustomisation();
        });
        refs.addMacroBtn.addEventListener('click', () => {
          const label = normaliseWhitespace(refs.newMacroLabel.value);
          const text = String(refs.newMacroText.value || '').trim();
          if (!label || !text) { showToast('Add both a snippet label and snippet text.', 'warning'); return; }
          state.customisation.macros.unshift({ id: uid('macro'), label, text });
          refs.newMacroLabel.value = '';
          refs.newMacroText.value = '';
          saveCustomisation();
          renderCustomisationForm();
          showToast('Snippet added.', 'success');
        });
        refs.macroList.addEventListener('click', (event) => {
          const button = event.target.closest('[data-action]');
          if (!button) return;
          const action = button.dataset.action;
          const macroId = button.dataset.macroId;
          const item = button.closest('[data-macro-id]');
          const macroIndex = state.customisation.macros.findIndex((macro) => macro.id === macroId);
          if (macroIndex === -1) return;
          if (action === 'save-macro' && item) {
            const label = normaliseWhitespace(item.querySelector('.macro-item-label').value);
            const text = String(item.querySelector('.macro-item-text').value || '').trim();
            if (!label || !text) { showToast('Snippet label and text cannot be empty.', 'warning'); return; }
            state.customisation.macros[macroIndex].label = label;
            state.customisation.macros[macroIndex].text = text;
            saveCustomisation();
            renderCustomisationForm();
            showToast('Snippet updated.', 'success');
          }
          if (action === 'delete-macro') {
            state.customisation.macros.splice(macroIndex, 1);
            saveCustomisation();
            renderCustomisationForm();
            showToast('Snippet deleted.', 'success');
          }
        });
        refs.addCustomTagBtn.addEventListener('click', () => {
          const tag = normaliseWhitespace(refs.newCustomTag.value);
          if (!tag) { showToast('Enter a tag name first.', 'warning'); return; }
          if ((state.customisation.customTags || []).includes(tag)) { showToast('That tag already exists.', 'warning'); return; }
          state.customisation.customTags.unshift(tag);
          refs.newCustomTag.value = '';
          saveCustomisation();
          renderCustomisationForm();
          renderHistoryDetail();
          showToast('Tag added.', 'success');
        });
        refs.customTagList.addEventListener('click', (event) => {
          const button = event.target.closest('[data-action]');
          if (!button) return;
          const action = button.dataset.action;
          const index = Number(button.dataset.tagIndex);
          if (!Number.isInteger(index) || index < 0 || index >= state.customisation.customTags.length) return;
          if (action === 'save-tag') {
            const item = button.closest('[data-tag-index]');
            const input = item ? item.querySelector('.custom-tag-value') : null;
            const newTag = normaliseWhitespace(input ? input.value : '');
            const oldTag = state.customisation.customTags[index];
            if (!newTag) { showToast('Tag name cannot be empty.', 'warning'); return; }
            if (newTag !== oldTag && state.customisation.customTags.includes(newTag)) { showToast('That tag already exists.', 'warning'); return; }
            state.customisation.customTags[index] = newTag;
            if (newTag !== oldTag) { replaceTagAcrossSessions(oldTag, newTag); persistSessionsDebounced(); }
            saveCustomisation();
            renderCustomisationForm();
            renderConsultation();
            renderHistory();
            showToast('Tag updated.', 'success');
          }
          if (action === 'delete-tag') {
            const tag = state.customisation.customTags[index];
            state.customisation.customTags.splice(index, 1);
            removeTagAcrossSessions(tag);
            saveCustomisation();
            persistSessionsDebounced();
            renderCustomisationForm();
            renderConsultation();
            renderHistory();
            showToast('Tag deleted.', 'success');
          }
        });
        window.addEventListener('beforeunload', () => { if (state.activeSession) { syncActiveSessionFromForm(); persistSessions(); } });
        document.addEventListener('visibilitychange', () => { if (document.hidden && state.activeSession) { syncActiveSessionFromForm(); persistSessions(); } });
      }

      function initialiseSpeechProvider() {
        if (!state.supportsSpeech) return;
        state.speechProvider = new WebkitSpeechProvider({
          onProviderStarted: (sessionId) => {
            const session = findSession(sessionId);
            if (!session) return;
            transitionSessionStatus(session, 'listening', { startClock: true, skipPersist: true });
            if (state.activeSession && state.activeSession.id === session.id) renderConsultation();
            persistSessionsDebounced();
          },
          onFinalResult: (result) => appendTranscriptFinalResult(result),
          onInterimResult: (payload) => {
            if (state.activeSession && payload.sessionId === state.activeSession.id) {
              state.interimText = payload.text || '';
              renderInterim();
            }
          },
          onError: handleSpeechError,
          onProviderEnded: (sessionId) => {
            if (state.activeSession && state.activeSession.id === sessionId) renderConsultationChrome();
          }
        });
      }

      function initialiseStateFromStorage() {
        const restoredPaused = state.sessions.find((session) => !session.archived && session.status === 'paused');
        if (restoredPaused) {
          state.activeSession = restoredPaused;
          populateConsultationForm(restoredPaused);
          state.consultationDraftTags = (restoredPaused.tags || []).slice();
          showToast('A paused session was restored from local storage.', 'info', 2600);
        } else {
          resetConsultationDraft();
        }
      }

      function init() {
        applyThemeAndBranding();
        initialiseSpeechProvider();
        const removedCount = purgeOldSessions();
        if (removedCount > 0) persistSessions();
        initialiseStateFromStorage();
        renderSettingsForm();
        renderCustomisationForm();
        renderConsultation();
        renderHistory();
        resetAutoSaveInterval();
        attachEventListeners();
        if (state.activeSession && state.activeSession.status === 'listening' && state.activeSession.lastStartedSegmentAt) ensureTimerRunning();
        if (removedCount > 0) showToast('Removed ' + removedCount + ' old session' + (removedCount === 1 ? '' : 's') + ' based on retention settings.', 'warning', 4200);
      }

      init();
    })();
