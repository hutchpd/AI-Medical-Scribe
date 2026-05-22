

    (() => {
      'use strict';

      const STORAGE_KEYS = {
        sessions: 'ai_medical_scribe_sessions_v1',
        settings: 'ai_medical_scribe_settings_v1',
        customisation: 'ai_medical_scribe_customisation_v1'
      };

      const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
      const ALLOWED_DOCUMENT_TAGS = new Set(['A', 'B', 'BLOCKQUOTE', 'BR', 'DIV', 'EM', 'H1', 'H2', 'H3', 'H4', 'HR', 'I', 'LI', 'OL', 'P', 'SPAN', 'STRONG', 'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'U', 'UL']);
      const STRIP_CONTENT_TAGS = new Set(['BASE', 'EMBED', 'FORM', 'FRAME', 'FRAMESET', 'HEAD', 'IFRAME', 'INPUT', 'LINK', 'META', 'NOSCRIPT', 'OBJECT', 'SCRIPT', 'STYLE', 'TEMPLATE']);

      const FHIR_BUNDLE_IDENTIFIER_SYSTEM = 'urn:findonsoftware:ai-medical-scribe:bundle';
      const FHIR_DOCUMENT_LANGUAGE = 'en-GB';
      const SESSION_STORAGE_ENVELOPE_VERSION = 2;
      const SESSION_STORAGE_SALT_BYTES = 16;
      const SESSION_STORAGE_IV_BYTES = 12;
      const SESSION_STORAGE_PBKDF2_ITERATIONS = 250000;
      const FHIR_COMPOSITION_TYPE = {
        coding: [
          {
            system: 'http://loinc.org',
            code: '11488-4',
            display: 'Consult note'
          }
        ],
        text: 'Consult note'
      };
      const STRUCTURED_DATA_FIELDS = [
        { key: 'problems', label: 'Problems', placeholder: 'One problem per line' },
        { key: 'medications', label: 'Medications', placeholder: 'One medication per line' },
        { key: 'allergies', label: 'Allergies', placeholder: 'One allergy per line' },
        { key: 'investigations', label: 'Investigations', placeholder: 'One investigation per line' },
        { key: 'followUpActions', label: 'Follow-up actions', placeholder: 'One follow-up action per line' },
        { key: 'diagnoses', label: 'Diagnoses', placeholder: 'One diagnosis per line' },
        { key: 'safetyNetting', label: 'Safety netting', placeholder: 'One safety-netting item per line' },
        { key: 'adminTasks', label: 'Admin tasks', placeholder: 'One admin task per line' }
      ];
      const AUDIT_MANUAL_NOTES_DEBOUNCE_MS = 1400;
      const AUDIT_TRANSCRIPT_EDIT_DEBOUNCE_MS = 700;

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

      function arrayBufferToBase64(buffer) {
        const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
        let binary = '';
        const chunkSize = 0x8000;
        for (let index = 0; index < bytes.length; index += chunkSize) {
          binary += String.fromCharCode.apply(null, Array.from(bytes.slice(index, index + chunkSize)));
        }
        return window.btoa(binary);
      }

      function base64ToUint8Array(value) {
        const source = String(value || '');
        if (!source) return new Uint8Array(0);
        const binary = window.atob(source);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        return bytes;
      }

      function isWebCryptoAvailable() {
        return Boolean(globalThis.crypto && globalThis.crypto.subtle);
      }

      function getRandomBytes(length) {
        const bytes = new Uint8Array(length);
        globalThis.crypto.getRandomValues(bytes);
        return bytes;
      }

      function isCryptoKeyLike(value) {
        return Boolean(value && typeof value === 'object' && typeof value.type === 'string' && value.algorithm);
      }

      function isEncryptedSessionEnvelope(value) {
        return Boolean(
          value &&
          typeof value === 'object' &&
          value.encrypted === true &&
          Number(value.version) >= SESSION_STORAGE_ENVELOPE_VERSION &&
          typeof value.mode === 'string' &&
          typeof value.iv === 'string' &&
          typeof value.cipherText === 'string'
        );
      }

      function createDefaultSummaryPrompt() {
        return 'The following is a transcript from a consultation. Summarise it into bullet point doctors notes with the sub headings Subjective, Examination, Assessment and Plan. If a heading has no supporting information, write "- Not stated" under that heading. Keep the wording concise and clinical.';
      }

      function createDefaultDocumentTemplates() {
        return [
          {
            id: 'patient-letter',
            name: 'Patient letter',
            instructions: 'Create a patient-friendly follow-up letter in semantic HTML. Include a clear heading, a short summary of the consultation, key findings, treatment or recommendations, any medicines discussed, follow-up steps, and safety-netting advice. Use plain English and a warm but professional tone.'
          },
          {
            id: 'letter-to-specialist',
            name: 'Letter to Specialist',
            instructions: 'Create a referral or update letter to a specialist in semantic HTML. Include patient identifiers if available from the transcript, reason for referral, relevant history, examination findings, investigations, current treatment, specific questions or requests of the specialist, and urgency if apparent. Use concise clinical language.'
          },
          {
            id: 'workers-comp',
            name: 'Workers comp',
            instructions: 'Create a workers compensation clinical document in semantic HTML. Include presenting injury or condition, mechanism or workplace context if mentioned, functional impact, current capacity for work, treatment plan, restrictions, review timeframe, and any follow-up actions. Keep the language factual and suitable for occupational documentation.'
          },
          {
            id: 'patient-sms',
            name: 'Patient SMS',
            instructions: 'Create a short patient SMS in semantic HTML using one or two brief paragraphs only. Summarise the key instruction, follow-up arrangement, and any urgent safety-netting point from the consultation. Keep it concise, plain-language, and suitable for a text message.'
          },
          {
            id: 'asthma-action-plan',
            name: 'Asthma Action plan',
            instructions: 'Create an asthma action plan in semantic HTML. Use clear sections or a simple table for baseline management, warning signs, escalation steps, medication guidance mentioned in the transcript, and when to seek urgent care. Use patient-friendly wording while preserving clinical accuracy.'
          },
          {
            id: 'medical-certificate',
            name: 'Medical certificate',
            instructions: 'Create a draft medical certificate in semantic HTML. Include practitioner heading, the medical condition or reason if appropriate from the transcript, relevant dates if mentioned, period affected, any restrictions or fitness advice, and a brief statement appropriate for a certificate draft. Keep it formal and concise.'
          },
          {
            id: 'letter-to-referring-clinician',
            name: 'Letter to referring clinician',
            instructions: 'Create a response letter to the referring clinician in semantic HTML. Include reason for consultation, relevant subjective history, examination findings, assessment, plan, investigations or treatment changes, and follow-up recommendations. Use professional correspondence style and structured clinical language.'
          },
          {
            id: 'access-request',
            name: 'Access Request',
            instructions: 'Create an access request style document in semantic HTML. Include the reason for requested access, relevant functional limitations or medical context from the consultation, how the condition affects participation or services, recommended supports or accommodations, and any review timeframe. Keep the tone formal and evidence-oriented.'
          }
        ];
      }

      function createSessionDocument(overrides = {}) {
        const now = Date.now();
        return {
          id: overrides.id || uid('document'),
          templateId: overrides.templateId || '',
          templateName: overrides.templateName || 'Document',
          title: overrides.title || overrides.templateName || 'Document',
          content: String(overrides.content || ''),
          createdAt: typeof overrides.createdAt === 'number' ? overrides.createdAt : now,
          updatedAt: typeof overrides.updatedAt === 'number' ? overrides.updatedAt : now
        };
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

      function sanitizeAuditMetadata(value, depth = 0) {
        if (depth > 3) return undefined;
        if (value == null) return undefined;
        if (typeof value === 'string') {
          const text = normaliseWhitespace(value);
          return text ? text.slice(0, 220) : undefined;
        }
        if (typeof value === 'number' || typeof value === 'boolean') return value;
        if (Array.isArray(value)) {
          const items = value
            .map((item) => sanitizeAuditMetadata(item, depth + 1))
            .filter((item) => item !== undefined)
            .slice(0, 24);
          return items.length ? items : undefined;
        }
        if (typeof value === 'object') {
          const redactedKeyPattern = /(token|secret|password|passphrase|authorization|auth|credential|headerValue|bearer)/i;
          const output = {};
          Object.entries(value).forEach(([key, item]) => {
            if (redactedKeyPattern.test(String(key || ''))) return;
            const sanitized = sanitizeAuditMetadata(item, depth + 1);
            if (sanitized !== undefined) output[key] = sanitized;
          });
          return Object.keys(output).length ? output : undefined;
        }
        return undefined;
      }

      function normalizeAuditEvent(rawEvent = {}) {
        const timestamp = typeof rawEvent.timestamp === 'number' ? rawEvent.timestamp : Date.now();
        const type = normaliseWhitespace(rawEvent.type || 'event').toLowerCase().replace(/\s+/g, '-');
        const detail = normaliseWhitespace(rawEvent.detail || 'Event recorded.');
        const actor = rawEvent.actor === 'system' ? 'system' : 'user';
        return {
          id: rawEvent.id || uid('audit'),
          timestamp,
          type,
          actor,
          detail: detail || 'Event recorded.',
          metadata: sanitizeAuditMetadata(rawEvent.metadata)
        };
      }

      function normalizeAuditEvents(events) {
        const seen = new Set();
        return (Array.isArray(events) ? events : [])
          .map((eventItem) => normalizeAuditEvent(eventItem))
          .filter((eventItem) => {
            if (seen.has(eventItem.id)) return false;
            seen.add(eventItem.id);
            return true;
          })
          .sort((left, right) => {
            if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
            return String(left.id).localeCompare(String(right.id));
          });
      }

      function appendAuditEvent(session, type, detail, metadata, actor = 'system') {
        if (!session || !type) return null;
        const nextEvent = normalizeAuditEvent({
          type,
          detail,
          metadata,
          actor,
          timestamp: Date.now()
        });
        session.auditEvents = normalizeAuditEvents([].concat(session.auditEvents || [], nextEvent));
        session.updatedAt = Math.max(session.updatedAt || 0, nextEvent.timestamp);
        return nextEvent;
      }

      function getSessionAuditEvents(session, order = 'desc') {
        const events = normalizeAuditEvents(session && session.auditEvents);
        return order === 'asc' ? events : events.slice().reverse();
      }

      function clearSessionAuditDebounceState(sessionId) {
        const sessionKey = String(sessionId || '');
        if (!sessionKey) return;
        const manualNotesTimer = state.auditDebounce.manualNotesTimers[sessionKey];
        if (manualNotesTimer) {
          window.clearTimeout(manualNotesTimer);
          delete state.auditDebounce.manualNotesTimers[sessionKey];
        }
        Object.keys(state.auditDebounce.transcriptEditTimers).forEach((key) => {
          if (!key.startsWith(sessionKey + ':')) return;
          window.clearTimeout(state.auditDebounce.transcriptEditTimers[key]);
          delete state.auditDebounce.transcriptEditTimers[key];
        });
        delete state.auditDebounce.manualNotesSignatures[sessionKey];
      }

      function queueManualNotesAuditEvent(sessionId, source = 'consultation') {
        const sessionKey = String(sessionId || '');
        if (!sessionKey) return;
        const existingTimer = state.auditDebounce.manualNotesTimers[sessionKey];
        if (existingTimer) window.clearTimeout(existingTimer);
        state.auditDebounce.manualNotesTimers[sessionKey] = window.setTimeout(() => {
          delete state.auditDebounce.manualNotesTimers[sessionKey];
          const session = findSession(sessionKey);
          if (!session) return;
          const signature = normaliseWhitespace(session.manualNotes || '');
          if (state.auditDebounce.manualNotesSignatures[sessionKey] === signature) return;
          state.auditDebounce.manualNotesSignatures[sessionKey] = signature;
          appendAuditEvent(
            session,
            'manual-notes-updated',
            'Manual notes updated.',
            { source, characterCount: String(session.manualNotes || '').length },
            'user'
          );
          upsertSession(session);
          persistSessionsDebounced();
          if (state.currentTab === 'history' && state.historySelectedSessionId === session.id) renderHistoryDetail();
        }, AUDIT_MANUAL_NOTES_DEBOUNCE_MS);
      }

      function queueTranscriptEditAuditEvent(sessionId, entryId, source = 'consultation') {
        const sessionKey = String(sessionId || '');
        const entryKey = String(entryId || '');
        if (!sessionKey || !entryKey) return;
        const timerKey = sessionKey + ':' + entryKey;
        const existingTimer = state.auditDebounce.transcriptEditTimers[timerKey];
        if (existingTimer) window.clearTimeout(existingTimer);
        state.auditDebounce.transcriptEditTimers[timerKey] = window.setTimeout(() => {
          delete state.auditDebounce.transcriptEditTimers[timerKey];
          const session = findSession(sessionKey);
          if (!session) return;
          const entry = (session.transcriptEntries || []).find((item) => item.id === entryKey);
          if (!entry) return;
          appendAuditEvent(
            session,
            'transcript-entry-edited',
            'Transcript entry edited.',
            {
              source,
              entryId: entry.id,
              isImportantMarker: Boolean(entry.isImportantMarker),
              characterCount: String(entry.text || '').length
            },
            'user'
          );
          upsertSession(session);
          persistSessionsDebounced();
          if (state.currentTab === 'history' && state.historySelectedSessionId === session.id) renderHistoryDetail();
        }, AUDIT_TRANSCRIPT_EDIT_DEBOUNCE_MS);
      }

      function getAuditTypeLabel(type) {
        return String(type || '')
          .replace(/[-_]+/g, ' ')
          .replace(/\b\w/g, (match) => match.toUpperCase()) || 'Event';
      }

      function formatAuditMetadataInline(metadata) {
        const value = sanitizeAuditMetadata(metadata);
        if (!value) return '';
        const entries = Object.entries(value);
        if (!entries.length) return '';
        return entries.map(([key, item]) => key + ': ' + (typeof item === 'string' ? item : JSON.stringify(item))).join(' | ');
      }

      function buildAuditTimelineHtml(session) {
        const events = getSessionAuditEvents(session, 'desc');
        if (!events.length) return '<div class="empty-state small">No audit events recorded for this session yet.</div>';
        return '<div class="audit-timeline">' + events.map((eventItem) =>
          '<article class="audit-event">' +
            '<div class="audit-event-head">' +
              '<div class="audit-event-meta"><span class="meta-badge">' + escapeHtml(formatDateTime(eventItem.timestamp)) + '</span><span class="review-badge provenance">' + escapeHtml(eventItem.actor) + '</span><span class="review-badge">' + escapeHtml(getAuditTypeLabel(eventItem.type)) + '</span></div>' +
            '</div>' +
            '<div class="audit-event-detail">' + escapeHtml(eventItem.detail) + '</div>' +
            (eventItem.metadata ? '<div class="audit-event-extra">' + escapeHtml(formatAuditMetadataInline(eventItem.metadata)) + '</div>' : '') +
          '</article>'
        ).join('') + '</div>';
      }

      function buildAuditLogText(session) {
        const events = getSessionAuditEvents(session, 'asc');
        const header = [
          'Session audit log',
          'Session ID: ' + (session && session.id || ''),
          'Patient: ' + (session && session.patientName || '-'),
          'Clinician: ' + (session && session.clinicianName || '-'),
          ''
        ];
        const lines = events.map((eventItem) => {
          const line = '[' + formatDateTime(eventItem.timestamp) + '] ' + eventItem.actor.toUpperCase() + ' ' + eventItem.type + ' - ' + eventItem.detail;
          const metadataLine = eventItem.metadata ? '  metadata: ' + formatAuditMetadataInline(eventItem.metadata) : '';
          return metadataLine ? line + '\n' + metadataLine : line;
        });
        return header.concat(lines).join('\n');
      }

      function exportSessionAuditLog(session, format = 'json') {
        if (!session) return;
        const dateSegment = String(toIsoInstant(session.startedAt || session.createdAt || Date.now())).slice(0, 10);
        const baseFilename = sanitizeFilenamePart((session.patientName || 'session') + '_' + dateSegment + '_audit_log');
        if (format === 'text') {
          downloadTextFile(baseFilename + '.txt', buildAuditLogText(session), 'text/plain;charset=utf-8');
          return;
        }
        const payload = {
          sessionId: session.id,
          patientName: session.patientName || '',
          clinicianName: session.clinicianName || '',
          createdAt: session.createdAt || null,
          startedAt: session.startedAt || null,
          updatedAt: session.updatedAt || null,
          events: getSessionAuditEvents(session, 'asc')
        };
        downloadTextFile(baseFilename + '.json', JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
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

      function shouldMergeTranscriptEntry(lastEntry, nextTimestamp) {
        if (!lastEntry || lastEntry.isImportantMarker) return false;

        const previousText = String(lastEntry.text || '').trim();
        const previousTimestamp = lastEntry.lastUpdatedAt || lastEntry.timestamp || nextTimestamp;
        const gapMs = Math.max(0, nextTimestamp - previousTimestamp);
        const wordCount = previousText ? previousText.split(/\s+/).length : 0;

        if (gapMs >= 3200) return false;
        if (String(previousText).length >= 280) return false;
        if (/[.!?…]$/.test(previousText) && gapMs >= 1200) return false;
        if (wordCount >= 18 && gapMs >= 1800) return false;

        return true;
      }

      function scrollTranscriptToBottom(container) {
        if (!container) return;
        window.requestAnimationFrame(() => {
          container.scrollTop = container.scrollHeight;
        });
      }

      function downloadTextFile(filename, content, mimeType = 'text/plain;charset=utf-8') {
        const blob = new Blob([content], { type: mimeType });
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

      function toIsoInstant(timestamp) {
        const value = Number(timestamp);
        return new Date(Number.isFinite(value) && value > 0 ? value : Date.now()).toISOString();
      }

      function base64EncodeUtf8(text) {
        const source = String(text || '');
        const bytes = new TextEncoder().encode(source);
        let binary = '';
        const chunkSize = 0x8000;
        for (let index = 0; index < bytes.length; index += chunkSize) {
          const chunk = bytes.subarray(index, index + chunkSize);
          binary += String.fromCharCode.apply(null, chunk);
        }
        return window.btoa(binary);
      }

      // These helpers protect session payloads before they are written to localStorage.
      // Keys are kept in memory only, and plaintext writes are blocked when secure mode is enabled.
      async function deriveKeyFromPassphrase(passphrase, salt) {
        if (!isWebCryptoAvailable()) throw new Error('Web Crypto API is unavailable in this browser.');
        const normalizedPassphrase = String(passphrase || '');
        if (!normalizedPassphrase) throw new Error('Enter a passphrase to unlock secure storage.');
        const saltBytes = salt instanceof Uint8Array ? salt : base64ToUint8Array(salt);
        const keyMaterial = await globalThis.crypto.subtle.importKey(
          'raw',
          new TextEncoder().encode(normalizedPassphrase),
          'PBKDF2',
          false,
          ['deriveKey']
        );
        return globalThis.crypto.subtle.deriveKey(
          {
            name: 'PBKDF2',
            salt: saltBytes,
            iterations: SESSION_STORAGE_PBKDF2_ITERATIONS,
            hash: 'SHA-256'
          },
          keyMaterial,
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt']
        );
      }

      async function generateInMemorySessionKey() {
        if (!isWebCryptoAvailable()) throw new Error('Web Crypto API is unavailable in this browser.');
        return globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      }

      async function encryptJsonValue(value, secretOrKey, mode) {
        if (!isWebCryptoAvailable()) throw new Error('Web Crypto API is unavailable in this browser.');
        const selectedMode = mode === 'session' ? 'session' : 'passphrase';
        const salt = getRandomBytes(SESSION_STORAGE_SALT_BYTES);
        const iv = getRandomBytes(SESSION_STORAGE_IV_BYTES);
        const key = selectedMode === 'session'
          ? secretOrKey
          : await deriveKeyFromPassphrase(secretOrKey, salt);

        if (!isCryptoKeyLike(key)) throw new Error('Secure storage is locked.');

        const plainText = JSON.stringify(value);
        const cipherBuffer = await globalThis.crypto.subtle.encrypt(
          { name: 'AES-GCM', iv },
          key,
          new TextEncoder().encode(plainText)
        );

        return {
          version: SESSION_STORAGE_ENVELOPE_VERSION,
          encrypted: true,
          mode: selectedMode,
          salt: arrayBufferToBase64(salt),
          iv: arrayBufferToBase64(iv),
          cipherText: arrayBufferToBase64(cipherBuffer),
          updatedAt: Date.now()
        };
      }

      async function decryptJsonValue(envelope, secretOrKey) {
        if (!isEncryptedSessionEnvelope(envelope)) throw new Error('Encrypted session storage is invalid.');
        if (!isWebCryptoAvailable()) throw new Error('Web Crypto API is unavailable in this browser.');

        const iv = base64ToUint8Array(envelope.iv);
        const cipherBytes = base64ToUint8Array(envelope.cipherText);
        const key = envelope.mode === 'session'
          ? secretOrKey
          : await deriveKeyFromPassphrase(secretOrKey, base64ToUint8Array(envelope.salt));

        if (!isCryptoKeyLike(key)) throw new Error('Secure storage is locked.');

        try {
          const plainBuffer = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipherBytes);
          return safeParse(new TextDecoder().decode(plainBuffer), null);
        } catch (error) {
          if (envelope.mode === 'passphrase') throw new Error('The passphrase did not unlock this encrypted session history.');
          throw new Error('The in-memory session key is unavailable for this encrypted session history.');
        }
      }

      function escapeXmlText(text) {
        return String(text || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&apos;');
      }

      function toFhirXhtmlDivFromPlainText(text, title) {
        const source = String(text || '').replace(/\r/g, '').trim();
        const lines = source ? source.split('\n').map((line) => line.trim()).filter(Boolean) : [];
        const content = [];

        if (title) content.push('<p><b>' + escapeXmlText(title) + '</b></p>');

        if (!lines.length) {
          content.push('<p>Not stated</p>');
          return '<div xmlns="http://www.w3.org/1999/xhtml">' + content.join('') + '</div>';
        }

        const listLike = lines.length > 1 && lines.every((line) => /^[-*•]\s+/.test(line));
        if (listLike) {
          content.push('<ul>' + lines.map((line) => '<li>' + escapeXmlText(line.replace(/^[-*•]\s+/, '')) + '</li>').join('') + '</ul>');
          return '<div xmlns="http://www.w3.org/1999/xhtml">' + content.join('') + '</div>';
        }

        lines.forEach((line) => {
          if (/^[-*•]\s+/.test(line)) content.push('<ul><li>' + escapeXmlText(line.replace(/^[-*•]\s+/, '')) + '</li></ul>');
          else content.push('<p>' + escapeXmlText(line) + '</p>');
        });
        return '<div xmlns="http://www.w3.org/1999/xhtml">' + content.join('') + '</div>';
      }

      function buildSoapSectionsFromSession(session) {
        const headings = ['Subjective', 'Examination', 'Assessment', 'Plan'];
        const parsed = normaliseWhitespace(session && session.summary) ? parseStructuredSummary(session.summary) : null;
        return headings.map((heading) => ({
          title: heading,
          items: normalizeFhirSectionItems(parsed && parsed[heading] && parsed[heading].length ? parsed[heading].slice() : [])
        }));
      }

      function normalizeFhirSectionItems(items) {
        const normalizedItems = dedupeStrings(Array.isArray(items) ? items : [])
          .map((item) => String(item || '').replace(/^[-*•]\s*/, '').trim())
          .filter((item) => item && item.toLowerCase() !== 'not stated');
        return normalizedItems.length ? normalizedItems : ['Not stated'];
      }

      function buildFhirNarrativeDivFromItems(items, title) {
        const normalizedItems = normalizeFhirSectionItems(items);
        return toFhirXhtmlDivFromPlainText(normalizedItems.map((item) => '- ' + item).join('\n'), title);
      }

      function getFhirCompositionSectionCode(title) {
        const codeMap = {
          Subjective: { system: 'http://loinc.org', code: '61150-9', display: 'Subjective narrative' },
          Examination: { system: 'http://loinc.org', code: '29545-1', display: 'Physical findings' },
          Assessment: { system: 'http://loinc.org', code: '51848-0', display: 'Assessment note' },
          Plan: { system: 'http://loinc.org', code: '18776-5', display: 'Plan of care note' },
          Transcript: { system: 'http://loinc.org', code: '11506-3', display: 'Progress note' },
          'Manual Notes': { system: 'http://loinc.org', code: '34109-9', display: 'Note' },
          'Generated Documents': { system: 'http://loinc.org', code: '55112-7', display: 'Document summary' }
        };
        const coding = codeMap[String(title || '').trim()];
        return coding ? { coding: [coding], text: title } : { text: title || 'Section' };
      }

      function stripHtmlToPlainText(markup) {
        const template = document.createElement('template');
        template.innerHTML = String(markup || '');
        return normaliseWhitespace(template.content.textContent || '');
      }

      function simplifyFhirObject(value) {
        if (Array.isArray(value)) {
          const items = value.map((item) => simplifyFhirObject(item)).filter((item) => item !== undefined);
          return items.length ? items : undefined;
        }
        if (value && typeof value === 'object') {
          const output = {};
          Object.keys(value).forEach((key) => {
            const nextValue = simplifyFhirObject(value[key]);
            if (nextValue !== undefined) output[key] = nextValue;
          });
          return Object.keys(output).length ? output : undefined;
        }
        return value === undefined ? undefined : value;
      }

      function buildStructuredExtractionSource(session) {
        return [String(session && session.summary || ''), String(session && session.manualNotes || '')]
          .map((text) => text.replace(/\r/g, ''))
          .filter((text) => normaliseWhitespace(text))
          .join('\n');
      }

      function createEmptyStructuredData() {
        return STRUCTURED_DATA_FIELDS.reduce((accumulator, field) => {
          accumulator[field.key] = [];
          return accumulator;
        }, {});
      }

      function cleanStructuredItemText(value) {
        return String(value || '')
          .replace(/^[-*•\d.()\s]+/, '')
          .replace(/^\s*(subjective|examination|assessment|plan)\s*:\s*/i, '')
          .replace(/\s+/g, ' ')
          .trim()
          .replace(/[.;:,\s]+$/, '')
          .trim();
      }

      function isMeaningfulStructuredItem(value) {
        const item = cleanStructuredItemText(value).toLowerCase();
        if (!item) return false;
        if (['not stated', 'none', 'nil', 'n/a', 'na', 'unknown'].includes(item)) return false;
        if (item.length < 3 && item !== 'nkda') return false;
        return true;
      }

      function normalizeStructuredDataItems(items) {
        return dedupeStrings((Array.isArray(items) ? items : [])
          .map((item) => cleanStructuredItemText(item))
          .filter((item) => isMeaningfulStructuredItem(item)));
      }

      function normalizeStructuredData(value) {
        const source = value && typeof value === 'object' ? value : {};
        return STRUCTURED_DATA_FIELDS.reduce((accumulator, field) => {
          accumulator[field.key] = normalizeStructuredDataItems(source[field.key]);
          return accumulator;
        }, createEmptyStructuredData());
      }

      function hasStructuredDataContent(value) {
        return STRUCTURED_DATA_FIELDS.some((field) => Array.isArray(value && value[field.key]) && value[field.key].length);
      }

      function splitStructuredEditorValue(value) {
        return normalizeStructuredDataItems(String(value || '')
          .replace(/\r/g, '')
          .split('\n')
          .flatMap((line) => line.split(/\s*[;,]\s*/)));
      }

      function splitTextIntoExtractionCandidates(sourceText) {
        const source = String(sourceText || '').replace(/\r/g, '\n');
        if (!normaliseWhitespace(source)) return [];
        const lineCandidates = source.split('\n').map((line) => line.trim()).filter(Boolean);
        const sentenceCandidates = source
          .replace(/\n+/g, ' ')
          .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
          .map((sentence) => sentence.trim())
          .filter(Boolean);
        return dedupeStrings(lineCandidates.concat(sentenceCandidates))
          .map((item) => cleanStructuredItemText(item))
          .filter((item) => isMeaningfulStructuredItem(item) && item.length <= 180);
      }

      function extractLabelValue(line, labels) {
        const source = String(line || '').trim();
        if (!source || !Array.isArray(labels) || !labels.length) return null;
        const pattern = new RegExp('^(?:' + labels.map((label) => escapeRegExp(label)).join('|') + ')\\s*[:\\-]\\s*(.+)$', 'i');
        const match = source.match(pattern);
        return match ? match[1] : null;
      }

      function splitLabeledStructuredItems(value) {
        return normalizeStructuredDataItems(String(value || '')
          .split(/\s*(?:;|,|\band\b)\s*/i)
          .map((item) => item.trim()));
      }

      function extractStructuredBucketFromText(sourceText, options = {}) {
        const candidates = splitTextIntoExtractionCandidates(sourceText);
        if (!candidates.length) return [];
        const labels = Array.isArray(options.labels) ? options.labels : [];
        const keywords = Array.isArray(options.keywords) ? options.keywords : [];
        const exactPhrases = Array.isArray(options.exactPhrases) ? options.exactPhrases : [];
        const items = [];

        candidates.forEach((candidate) => {
          const labeledValue = extractLabelValue(candidate, labels);
          if (labeledValue) {
            items.push.apply(items, splitLabeledStructuredItems(labeledValue));
            return;
          }
          const matchesKeyword = keywords.some((keyword) => new RegExp('\\b' + escapeRegExp(keyword) + '\\b', 'i').test(candidate));
          const matchesPhrase = exactPhrases.some((phrase) => candidate.toLowerCase().includes(String(phrase).toLowerCase()));
          if (matchesKeyword || matchesPhrase) items.push(candidate);
        });

        return normalizeStructuredDataItems(items);
      }

      function extractProblemsFromText(sourceText) {
        return extractStructuredBucketFromText(sourceText, {
          labels: ['problem', 'problems', 'condition', 'conditions', 'issue', 'issues', 'pmh', 'past medical history'],
          keywords: ['problem', 'condition', 'history of', 'consistent with']
        });
      }

      function extractDiagnosesFromText(sourceText) {
        return extractStructuredBucketFromText(sourceText, {
          labels: ['diagnosis', 'diagnoses', 'dx', 'impression', 'assessment'],
          keywords: ['diagnosis', 'diagnosed', 'impression', 'likely', 'consistent with']
        });
      }

      function extractMedicationsFromText(sourceText) {
        return extractStructuredBucketFromText(sourceText, {
          labels: ['medication', 'medications', 'medicine', 'medicines', 'rx'],
          keywords: ['mg', 'mcg', 'ml', 'tablet', 'capsule', 'inhaler', 'insulin', 'prescribed', 'continue', 'cease', 'start']
        });
      }

      function extractAllergiesFromText(sourceText) {
        return extractStructuredBucketFromText(sourceText, {
          labels: ['allergy', 'allergies'],
          keywords: ['allergic', 'allergy', 'nkda', 'adverse reaction']
        });
      }

      function extractInvestigationsFromText(sourceText) {
        return extractStructuredBucketFromText(sourceText, {
          labels: ['investigation', 'investigations', 'tests', 'test ordered', 'imaging'],
          keywords: ['test', 'investigation', 'scan', 'x-ray', 'xray', 'ultrasound', 'mri', 'ct', 'blood', 'pathology', 'ecg', 'ekg', 'swab', 'culture']
        });
      }

      function extractFollowUpActionsFromText(sourceText) {
        return extractStructuredBucketFromText(sourceText, {
          labels: ['follow-up', 'follow up', 'review', 'next steps'],
          keywords: ['follow-up', 'follow up', 'review', 'return', 'monitor', 'recheck', 'recall', 'book', 'appointment']
        });
      }

      function extractSafetyNettingFromText(sourceText) {
        return extractStructuredBucketFromText(sourceText, {
          labels: ['safety netting', 'safety-netting', 'red flags'],
          keywords: ['safety net', 'safety-net', 'red flag', 'seek urgent', 'urgent review', 'present to ed', 'emergency department', 'call ambulance']
        });
      }

      function extractAdminTasksFromText(sourceText) {
        return extractStructuredBucketFromText(sourceText, {
          labels: ['admin', 'administration', 'paperwork', 'tasks'],
          keywords: ['certificate', 'form', 'paperwork', 'referral', 'letter', 'workers comp', 'workcover', 'booking', 'booked']
        });
      }

      function extractStructuredDataFromSession(session) {
        const summaryText = String(session && session.summary || '');
        const manualNotesText = String(session && session.manualNotes || '');
        const transcriptText = buildTranscriptPlainText(session);
        const parsedSummary = normaliseWhitespace(summaryText) ? parseStructuredSummary(summaryText) : null;
        const subjectiveText = parsedSummary ? (parsedSummary.Subjective || []).join('\n') : '';
        const assessmentText = parsedSummary ? (parsedSummary.Assessment || []).join('\n') : '';
        const planText = parsedSummary ? (parsedSummary.Plan || []).join('\n') : '';
        const combinedNotesText = [manualNotesText, transcriptText].filter((text) => normaliseWhitespace(text)).join('\n');

        return normalizeStructuredData({
          problems: normalizeStructuredDataItems([].concat(
            parsedSummary ? parsedSummary.Assessment || [] : [],
            extractProblemsFromText(combinedNotesText)
          )),
          medications: normalizeStructuredDataItems([].concat(
            extractMedicationsFromText(planText),
            extractMedicationsFromText(combinedNotesText)
          )),
          allergies: normalizeStructuredDataItems([].concat(
            extractAllergiesFromText(subjectiveText),
            extractAllergiesFromText(combinedNotesText)
          )),
          investigations: normalizeStructuredDataItems([].concat(
            extractInvestigationsFromText(planText),
            extractInvestigationsFromText(combinedNotesText)
          )),
          followUpActions: normalizeStructuredDataItems([].concat(
            extractFollowUpActionsFromText(planText),
            extractFollowUpActionsFromText(combinedNotesText)
          )),
          diagnoses: normalizeStructuredDataItems([].concat(
            extractDiagnosesFromText(assessmentText),
            extractDiagnosesFromText(combinedNotesText)
          )),
          safetyNetting: normalizeStructuredDataItems([].concat(
            extractSafetyNettingFromText(planText),
            extractSafetyNettingFromText(combinedNotesText)
          )),
          adminTasks: normalizeStructuredDataItems([].concat(
            extractAdminTasksFromText(planText),
            extractAdminTasksFromText(combinedNotesText)
          ))
        });
      }

      function getEffectiveStructuredData(session) {
        const stored = normalizeStructuredData(session && session.structuredData);
        if (session && session.structuredDataStatus === 'idle' && !hasStructuredDataContent(stored)) {
          return extractStructuredDataFromSession(session);
        }
        return stored;
      }

      function extractFhirStructuredItems(session) {
        const structuredData = getEffectiveStructuredData(session);
        return {
          problems: normalizeStructuredDataItems([].concat(structuredData.problems, structuredData.diagnoses)),
          medications: normalizeStructuredDataItems(structuredData.medications),
          followUpActions: normalizeStructuredDataItems(structuredData.followUpActions),
          investigations: normalizeStructuredDataItems(structuredData.investigations),
          allergies: normalizeStructuredDataItems(structuredData.allergies),
          diagnoses: normalizeStructuredDataItems(structuredData.diagnoses),
          safetyNetting: normalizeStructuredDataItems(structuredData.safetyNetting),
          adminTasks: normalizeStructuredDataItems(structuredData.adminTasks)
        };
      }

      function buildFhirPatient(context) {
        if (!context.patientName) return null;
        return {
          fullUrl: context.patientFullUrl,
          resource: {
            resourceType: 'Patient',
            id: context.patientResourceId,
            name: [{ text: context.patientName }]
          }
        };
      }

      function buildFhirPractitioner(context) {
        if (!context.clinicianName) return null;
        return {
          fullUrl: context.practitionerFullUrl,
          resource: {
            resourceType: 'Practitioner',
            id: context.practitionerResourceId,
            name: [{ text: context.clinicianName }]
          }
        };
      }

      function buildFhirOrganization(context) {
        return {
          fullUrl: context.organizationFullUrl,
          resource: {
            resourceType: 'Organization',
            id: context.organizationResourceId,
            name: context.organisationName
          }
        };
      }

      function buildFhirEncounter(context) {
        return {
          fullUrl: context.encounterFullUrl,
          resource: simplifyFhirObject({
            resourceType: 'Encounter',
            id: context.encounterResourceId,
            status: context.encounterStatus,
            class: {
              system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
              code: 'AMB',
              display: 'ambulatory'
            },
            type: context.consultationType ? [{ text: context.consultationType }] : undefined,
            subject: context.subjectReference ? { reference: context.subjectReference } : undefined,
            participant: context.clinicianName ? [{ individual: { reference: context.practitionerFullUrl } }] : undefined,
            period: simplifyFhirObject({
              start: context.encounterStart,
              end: context.encounterEnd
            })
          })
        };
      }

      function buildFhirTranscriptDocumentReference(context) {
        return {
          fullUrl: context.transcriptDocFullUrl,
          resource: simplifyFhirObject({
            resourceType: 'DocumentReference',
            id: context.transcriptDocResourceId,
            status: 'current',
            docStatus: context.docStatus,
            type: { text: 'Consultation transcript' },
            subject: context.subjectReference ? { reference: context.subjectReference } : undefined,
            author: [{ reference: context.authorReference }],
            date: context.compositionDate,
            content: [{
              attachment: {
                contentType: 'text/plain; charset=utf-8',
                language: FHIR_DOCUMENT_LANGUAGE,
                title: 'Consultation transcript',
                data: base64EncodeUtf8(context.transcriptText),
                creation: context.compositionDate
              }
            }],
            context: {
              encounter: [{ reference: context.encounterFullUrl }]
            }
          })
        };
      }

      function buildFhirManualNotesDocumentReference(context) {
        return {
          fullUrl: context.manualNotesDocFullUrl,
          resource: simplifyFhirObject({
            resourceType: 'DocumentReference',
            id: context.manualNotesDocResourceId,
            status: 'current',
            docStatus: context.docStatus,
            type: { text: 'Manual notes' },
            subject: context.subjectReference ? { reference: context.subjectReference } : undefined,
            author: [{ reference: context.authorReference }],
            date: context.compositionDate,
            content: [{
              attachment: {
                contentType: 'text/plain; charset=utf-8',
                language: FHIR_DOCUMENT_LANGUAGE,
                title: 'Manual notes',
                data: base64EncodeUtf8(context.manualNotesText),
                creation: context.compositionDate
              }
            }],
            context: {
              encounter: [{ reference: context.encounterFullUrl }]
            }
          })
        };
      }

      function buildFhirGeneratedDocumentReferences(context) {
        return context.generatedDocuments.map((documentItem) => {
          const documentDate = toIsoInstant(documentItem.updatedAt || documentItem.createdAt || Date.now());
          const resourceId = 'docref-generated-' + documentItem.id;
          const fullUrl = 'urn:uuid:' + resourceId;
          return {
            fullUrl,
            documentItem,
            resource: simplifyFhirObject({
              resourceType: 'DocumentReference',
              id: resourceId,
              status: 'current',
              docStatus: context.docStatus,
              type: { text: documentItem.templateName || 'Generated document' },
              subject: context.subjectReference ? { reference: context.subjectReference } : undefined,
              author: [{ reference: context.authorReference }],
              date: documentDate,
              content: [{
                attachment: {
                  contentType: 'text/html; charset=utf-8',
                  language: FHIR_DOCUMENT_LANGUAGE,
                  title: documentItem.title || documentItem.templateName || 'Generated document',
                  data: base64EncodeUtf8(String(documentItem.content || '')),
                  creation: documentDate
                }
              }],
              context: {
                encounter: [{ reference: context.encounterFullUrl }]
              }
            })
          };
        });
      }

      function buildFhirConditionResources(context) {
        return context.structured.problems.map((problem, index) => {
          const resourceId = 'condition-' + context.sessionId + '-' + String(index + 1);
          return {
            fullUrl: 'urn:uuid:' + resourceId,
            resource: simplifyFhirObject({
              resourceType: 'Condition',
              id: resourceId,
              clinicalStatus: {
                coding: [{
                  system: 'http://terminology.hl7.org/CodeSystem/condition-clinical',
                  code: 'active',
                  display: 'Active'
                }]
              },
              verificationStatus: {
                coding: [{
                  system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status',
                  code: 'provisional',
                  display: 'Provisional'
                }]
              },
              code: { text: problem },
              subject: context.subjectReference ? { reference: context.subjectReference } : undefined,
              encounter: { reference: context.encounterFullUrl },
              recordedDate: context.compositionDate
            })
          };
        });
      }

      function buildFhirMedicationResources(context) {
        return context.structured.medications.map((medication, index) => {
          const resourceId = 'medicationstatement-' + context.sessionId + '-' + String(index + 1);
          return {
            fullUrl: 'urn:uuid:' + resourceId,
            resource: simplifyFhirObject({
              resourceType: 'MedicationStatement',
              id: resourceId,
              status: 'active',
              medicationCodeableConcept: { text: medication },
              subject: context.subjectReference ? { reference: context.subjectReference } : undefined,
              context: { reference: context.encounterFullUrl },
              effectiveDateTime: context.compositionDate,
              note: [{ text: 'Heuristically extracted from summary or manual notes.' }]
            })
          };
        });
      }

      function buildFhirServiceRequestResources(context) {
        const requests = [];
        context.structured.followUpActions.forEach((action, index) => {
          const resourceId = 'servicerequest-followup-' + context.sessionId + '-' + String(index + 1);
          requests.push({
            fullUrl: 'urn:uuid:' + resourceId,
            resource: simplifyFhirObject({
              resourceType: 'ServiceRequest',
              id: resourceId,
              status: 'active',
              intent: 'plan',
              code: { text: action },
              subject: context.subjectReference ? { reference: context.subjectReference } : undefined,
              encounter: { reference: context.encounterFullUrl },
              authoredOn: context.compositionDate,
              note: [{ text: 'Heuristically extracted follow-up action.' }]
            })
          });
        });
        context.structured.investigations.forEach((item, index) => {
          const resourceId = 'servicerequest-investigation-' + context.sessionId + '-' + String(index + 1);
          requests.push({
            fullUrl: 'urn:uuid:' + resourceId,
            resource: simplifyFhirObject({
              resourceType: 'ServiceRequest',
              id: resourceId,
              status: 'active',
              intent: 'order',
              code: { text: item },
              subject: context.subjectReference ? { reference: context.subjectReference } : undefined,
              encounter: { reference: context.encounterFullUrl },
              authoredOn: context.compositionDate,
              note: [{ text: 'Heuristically extracted investigation or test.' }]
            })
          });
        });
        return requests;
      }

      function buildFhirComposition(context) {
        const soapSections = context.soapSections.map((section) => ({
          title: section.title,
          code: getFhirCompositionSectionCode(section.title),
          text: {
            status: 'generated',
            div: buildFhirNarrativeDivFromItems(section.items, section.title)
          }
        }));

        const manualNotesSection = {
          title: 'Manual Notes',
          code: getFhirCompositionSectionCode('Manual Notes'),
          text: {
            status: 'generated',
            div: toFhirXhtmlDivFromPlainText(context.manualNotesText || 'No manual notes.', 'Manual Notes')
          },
          entry: [{ reference: context.manualNotesDocFullUrl }]
        };

        const transcriptSection = {
          title: 'Transcript',
          code: getFhirCompositionSectionCode('Transcript'),
          text: {
            status: 'generated',
            div: toFhirXhtmlDivFromPlainText(context.transcriptText || 'No transcript recorded.', 'Transcript')
          },
          entry: [{ reference: context.transcriptDocFullUrl }]
        };

        const generatedDocumentsSection = {
          title: 'Generated Documents',
          code: getFhirCompositionSectionCode('Generated Documents'),
          text: {
            status: 'generated',
            div: context.generatedDocumentReferences.length
              ? toFhirXhtmlDivFromPlainText(context.generatedDocumentReferences.map((item) => '- ' + (item.documentItem.title || item.documentItem.templateName || 'Generated document')).join('\n'), 'Generated Documents')
              : toFhirXhtmlDivFromPlainText('No generated documents.', 'Generated Documents')
          },
          entry: context.generatedDocumentReferences.length ? context.generatedDocumentReferences.map((item) => ({ reference: item.fullUrl })) : undefined
        };

        const structuredSections = [];
        if (context.conditionResources.length) {
          structuredSections.push({
            title: 'Problems',
            code: { coding: [{ system: 'http://loinc.org', code: '11450-4', display: 'Problem list' }], text: 'Problems' },
            text: {
              status: 'generated',
              div: buildFhirNarrativeDivFromItems(context.structured.problems, 'Problems')
            },
            entry: context.conditionResources.map((entry) => ({ reference: entry.fullUrl }))
          });
        }
        if (context.medicationResources.length) {
          structuredSections.push({
            title: 'Medications',
            code: { coding: [{ system: 'http://loinc.org', code: '10160-0', display: 'History of medication use' }], text: 'Medications' },
            text: {
              status: 'generated',
              div: buildFhirNarrativeDivFromItems(context.structured.medications, 'Medications')
            },
            entry: context.medicationResources.map((entry) => ({ reference: entry.fullUrl }))
          });
        }
        if (context.serviceRequestResources.length) {
          structuredSections.push({
            title: 'Actions and Investigations',
            code: { coding: [{ system: 'http://loinc.org', code: '18776-5', display: 'Plan of care note' }], text: 'Actions and Investigations' },
            text: {
              status: 'generated',
              div: buildFhirNarrativeDivFromItems(context.structured.followUpActions.concat(context.structured.investigations), 'Actions and Investigations')
            },
            entry: context.serviceRequestResources.map((entry) => ({ reference: entry.fullUrl }))
          });
        }

        return {
          fullUrl: context.compositionFullUrl,
          resource: simplifyFhirObject({
            resourceType: 'Composition',
            id: context.compositionResourceId,
            status: context.compositionStatus,
            type: deepClone(FHIR_COMPOSITION_TYPE),
            subject: context.subjectReference ? { reference: context.subjectReference } : undefined,
            encounter: { reference: context.encounterFullUrl },
            date: context.compositionDate,
            author: [{ reference: context.authorReference }],
            title: context.consultationType + ' for ' + (context.patientName || 'Unnamed patient'),
            custodian: { reference: context.organizationFullUrl },
            section: soapSections.concat([manualNotesSection, transcriptSection, generatedDocumentsSection], structuredSections)
          })
        };
      }

      function buildFhirBundleEntries(context) {
        const baseEntries = [
          buildFhirComposition(context),
          buildFhirPatient(context),
          buildFhirPractitioner(context),
          buildFhirOrganization(context),
          buildFhirEncounter(context),
          buildFhirTranscriptDocumentReference(context),
          buildFhirManualNotesDocumentReference(context)
        ].filter(Boolean);

        return baseEntries
          .concat(context.generatedDocumentReferences, context.conditionResources, context.medicationResources, context.serviceRequestResources)
          .map((entry) => ({ fullUrl: entry.fullUrl, resource: simplifyFhirObject(entry.resource) }))
          .filter((entry) => entry.resource);
      }

      function ensureFhirRequiredFields(bundle) {
        if (!bundle || bundle.resourceType !== 'Bundle') throw new Error('FHIR export did not produce a Bundle resource.');
        if (bundle.type !== 'document') throw new Error('FHIR Bundle type must be document.');
        if (!bundle.entry || !bundle.entry.length) throw new Error('FHIR Bundle must contain at least one entry.');
        const compositionEntry = bundle.entry[0];
        if (!compositionEntry || !compositionEntry.resource || compositionEntry.resource.resourceType !== 'Composition') {
          throw new Error('FHIR document Bundles must start with a Composition resource.');
        }
      }

      function ensureFhirReferencesExist(bundle) {
        const entryReferences = new Set((bundle.entry || []).map((entry) => entry && entry.fullUrl).filter(Boolean));
        const missingReferences = new Set();

        const collectReferences = (value) => {
          if (!value) return;
          if (Array.isArray(value)) {
            value.forEach(collectReferences);
            return;
          }
          if (typeof value !== 'object') return;
          if (typeof value.reference === 'string' && /^urn:uuid:/i.test(value.reference) && !entryReferences.has(value.reference)) {
            missingReferences.add(value.reference);
          }
          Object.keys(value).forEach((key) => collectReferences(value[key]));
        };

        bundle.entry.forEach((entry) => collectReferences(entry.resource));
        if (missingReferences.size) throw new Error('FHIR export contains unresolved references: ' + Array.from(missingReferences).join(', '));
      }

      function createFhirExportContext(session) {
        if (!session) throw new Error('Session is required for FHIR export.');
        const sessionId = String(session.id || uid('session'));
        const patientName = normaliseWhitespace(session.patientName || '');
        const clinicianName = normaliseWhitespace(session.clinicianName || '');
        const organisationName = normaliseWhitespace(state.customisation.organisationName || '') || 'Unknown organisation';
        const consultationType = normaliseWhitespace(session.consultationType || '') || 'Consultation';
        const transcriptText = buildTranscriptPlainText(session) || 'No transcript recorded.';
        const manualNotesText = String(session.manualNotes || '').trim() || 'No manual notes.';
        const compositionDate = toIsoInstant(session.updatedAt || session.stoppedAt || Date.now());
        const encounterStart = toIsoInstant(session.startedAt || session.createdAt || Date.now());
        const encounterEnd = session.stoppedAt ? toIsoInstant(session.stoppedAt) : undefined;
        const encounterStatusMap = {
          listening: 'in-progress',
          paused: 'in-progress',
          stopped: 'finished',
          idle: 'planned'
        };
        const docStatus = session.status === 'stopped' ? 'final' : 'preliminary';
        const compositionStatus = session.status === 'stopped' ? 'final' : 'preliminary';
        const patientResourceId = 'patient-' + sessionId;
        const practitionerResourceId = 'practitioner-' + sessionId;
        const organizationResourceId = 'organization-' + sessionId;
        const encounterResourceId = 'encounter-' + sessionId;
        const compositionResourceId = 'composition-' + sessionId;
        const transcriptDocResourceId = 'docref-transcript-' + sessionId;
        const manualNotesDocResourceId = 'docref-manual-notes-' + sessionId;
        const patientFullUrl = 'urn:uuid:' + patientResourceId;
        const practitionerFullUrl = 'urn:uuid:' + practitionerResourceId;
        const organizationFullUrl = 'urn:uuid:' + organizationResourceId;
        const encounterFullUrl = 'urn:uuid:' + encounterResourceId;
        const compositionFullUrl = 'urn:uuid:' + compositionResourceId;
        const transcriptDocFullUrl = 'urn:uuid:' + transcriptDocResourceId;
        const manualNotesDocFullUrl = 'urn:uuid:' + manualNotesDocResourceId;
        const subjectReference = patientName ? patientFullUrl : undefined;
        const authorReference = clinicianName ? practitionerFullUrl : organizationFullUrl;
        const structured = extractFhirStructuredItems(session);

        const context = {
          sessionId,
          patientName,
          clinicianName,
          organisationName,
          consultationType,
          transcriptText,
          manualNotesText,
          compositionDate,
          encounterStart,
          encounterEnd,
          encounterStatus: encounterStatusMap[session.status] || 'planned',
          docStatus,
          compositionStatus,
          patientResourceId,
          practitionerResourceId,
          organizationResourceId,
          encounterResourceId,
          compositionResourceId,
          transcriptDocResourceId,
          manualNotesDocResourceId,
          patientFullUrl,
          practitionerFullUrl,
          organizationFullUrl,
          encounterFullUrl,
          compositionFullUrl,
          transcriptDocFullUrl,
          manualNotesDocFullUrl,
          subjectReference,
          authorReference,
          generatedDocuments: Array.isArray(session.documents) ? session.documents.slice() : [],
          soapSections: buildSoapSectionsFromSession(session),
          structured
        };

        context.generatedDocumentReferences = buildFhirGeneratedDocumentReferences(context);
        context.conditionResources = buildFhirConditionResources(context);
        context.medicationResources = buildFhirMedicationResources(context);
        context.serviceRequestResources = buildFhirServiceRequestResources(context);
        return context;
      }

      function buildSessionFhirBundle(session) {
        const context = createFhirExportContext(session);
        const bundle = simplifyFhirObject({
          resourceType: 'Bundle',
          id: 'bundle-' + context.sessionId,
          identifier: {
            system: FHIR_BUNDLE_IDENTIFIER_SYSTEM,
            value: context.sessionId
          },
          type: 'document',
          timestamp: context.compositionDate,
          entry: buildFhirBundleEntries(context)
        });

        ensureFhirRequiredFields(bundle);
        ensureFhirReferencesExist(bundle);
        return bundle;
      }

      function downloadSessionFhir(session) {
        const bundle = buildSessionFhirBundle(session);
        const sessionLabel = sanitizeFilenamePart(session.patientName || session.consultationType || 'session');
        const isoLikeDate = String(toIsoInstant(session.startedAt || session.createdAt || Date.now())).slice(0, 10) || 'session';
        const filename = sessionLabel + '_' + isoLikeDate + '_fhir.json';
        downloadTextFile(filename, JSON.stringify(bundle, null, 2), 'application/fhir+json;charset=utf-8');
        appendAuditEvent(session, 'fhir-downloaded', 'FHIR document downloaded.', { entryCount: Array.isArray(bundle.entry) ? bundle.entry.length : 0 }, 'user');
        upsertSession(session);
        persistSessionsDebounced();
      }

      function createDefaultSettings() {
        return {
          locale: 'en-GB',
          autoPunctuation: true,
          interimResults: true,
          saveRawTranscript: true,
          secureStorageEnabled: true,
          secureStorageMode: 'passphrase',
          secureStorageUnlocked: false,
          autoLockMinutes: 15,
          purgeOnBrowserClose: false,
          ephemeralConsultationMode: true,
          fhirEndpointUrl: '',
          fhirAuthType: 'none',
          fhirBearerToken: '',
          fhirCustomHeaderName: '',
          fhirCustomHeaderValue: '',
          fhirSendMode: 'bundle-json',
          autoSaveInterval: 5,
          theme: 'light',
          dataRetentionDays: 180,
          transcriptFontSize: 16,
          transcriptLineSpacing: 1.55,
          summaryPrompt: createDefaultSummaryPrompt(),
          splashDismissedAt: null
        };
      }

      function createDefaultCustomisation() {
        return {
          organisationName: 'Findon Software',
          brandingColor: '#2f7df6',
          defaultConsultationType: 'General consultation',
          defaultPractitionerName: '',
          macros: [
            { id: uid('macro'), label: 'Safety-netting', text: 'Safety-netting advice provided. Red flags discussed and patient aware of when to seek urgent review.' },
            { id: uid('macro'), label: 'Follow-up', text: 'Follow-up arranged with appropriate timeframe and patient advised regarding next steps.' }
          ],
          customTags: ['Urgent', 'Follow-up', 'Medication review'],
          documentTemplates: createDefaultDocumentTemplates()
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
        const summaryStatus = ['idle', 'generating', 'ready', 'error'].includes(overrides.summaryStatus) ? overrides.summaryStatus : 'idle';
        const structuredDataStatus = ['idle', 'generating', 'ready', 'error'].includes(overrides.structuredDataStatus) ? overrides.structuredDataStatus : 'idle';
        const manualNotesValue = String(overrides.manualNotes || '');
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
          manualNotes: manualNotesValue,
          manualNotesUpdatedAt: typeof overrides.manualNotesUpdatedAt === 'number' ? overrides.manualNotesUpdatedAt : (normaliseWhitespace(manualNotesValue) ? now : null),
          tags: Array.isArray(overrides.tags) ? dedupeStrings(overrides.tags) : [],
          status,
          archived: Boolean(overrides.archived),
          archivedAt: typeof overrides.archivedAt === 'number' ? overrides.archivedAt : null,
          provider: overrides.provider || 'webkitSpeechRecognition',
          summary: String(overrides.summary || ''),
          summaryStatus,
          summaryUpdatedAt: typeof overrides.summaryUpdatedAt === 'number' ? overrides.summaryUpdatedAt : null,
          summaryError: String(overrides.summaryError || ''),
          summaryPrompt: String(overrides.summaryPrompt || ''),
          summarySignature: String(overrides.summarySignature || ''),
          structuredData: normalizeStructuredData(overrides.structuredData),
          structuredDataUpdatedAt: typeof overrides.structuredDataUpdatedAt === 'number' ? overrides.structuredDataUpdatedAt : null,
          structuredDataStatus,
          structuredDataError: String(overrides.structuredDataError || ''),
          auditEvents: normalizeAuditEvents(overrides.auditEvents),
          lastFhirSentAt: typeof overrides.lastFhirSentAt === 'number' ? overrides.lastFhirSentAt : null,
          lastFhirSentStatus: String(overrides.lastFhirSentStatus || ''),
          lastFhirSentEndpoint: String(overrides.lastFhirSentEndpoint || ''),
          ephemeral: Boolean(overrides.ephemeral),
          documents: Array.isArray(overrides.documents) ? overrides.documents.map((documentItem) => createSessionDocument(documentItem)) : []
        };
      }

      function normaliseSession(rawSession) {
        const session = createSession(rawSession || {});
        session.transcriptEntries = (Array.isArray(rawSession && rawSession.transcriptEntries) ? rawSession.transcriptEntries : []).map((entry) => createTranscriptEntry(entry));
        session.documents = (Array.isArray(rawSession && rawSession.documents) ? rawSession.documents : []).map((documentItem) => createSessionDocument(documentItem));
        session.tags = dedupeStrings(rawSession && rawSession.tags);
        session.ephemeral = Boolean(rawSession && rawSession.ephemeral);
        session.structuredData = normalizeStructuredData(rawSession && rawSession.structuredData);
        session.auditEvents = normalizeAuditEvents(rawSession && rawSession.auditEvents);
        session.manualNotesUpdatedAt = typeof rawSession?.manualNotesUpdatedAt === 'number'
          ? rawSession.manualNotesUpdatedAt
          : (normaliseWhitespace(session.manualNotes) ? (session.updatedAt || session.createdAt) : null);
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
        if (normaliseWhitespace(session.summary)) {
          lines.push('');
          lines.push('AI Summary');
          lines.push('----------');
          lines.push(session.summary);
        }
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
        if (saved && typeof saved === 'object' && (saved.fhirBearerToken || saved.fhirCustomHeaderValue)) {
          const sanitizedSaved = Object.assign({}, saved);
          delete sanitizedSaved.fhirBearerToken;
          delete sanitizedSaved.fhirCustomHeaderValue;
          writeStorage(STORAGE_KEYS.settings, sanitizedSaved);
        }
        const merged = Object.assign(createDefaultSettings(), saved || {});
        merged.autoSaveInterval = clamp(Number(merged.autoSaveInterval) || 5, 1, 30);
        merged.secureStorageEnabled = Boolean(merged.secureStorageEnabled);
        merged.secureStorageMode = merged.secureStorageMode === 'session' ? 'session' : 'passphrase';
        merged.secureStorageUnlocked = false;
        merged.autoLockMinutes = clamp(Number(merged.autoLockMinutes) || 15, 0, 240);
        merged.purgeOnBrowserClose = Boolean(merged.purgeOnBrowserClose);
        merged.ephemeralConsultationMode = Boolean(merged.ephemeralConsultationMode);
        merged.fhirEndpointUrl = String(merged.fhirEndpointUrl || '').trim();
        merged.fhirAuthType = ['none', 'bearer', 'custom-header'].includes(merged.fhirAuthType) ? merged.fhirAuthType : 'none';
        merged.fhirBearerToken = '';
        merged.fhirCustomHeaderName = String(merged.fhirCustomHeaderName || '').trim();
        merged.fhirCustomHeaderValue = '';
        merged.fhirSendMode = merged.fhirSendMode === 'composition-only' ? 'composition-only' : 'bundle-json';
        merged.dataRetentionDays = Math.max(0, Number(merged.dataRetentionDays) || 0);
        merged.transcriptFontSize = clamp(Number(merged.transcriptFontSize) || 16, 14, 24);
        merged.transcriptLineSpacing = clamp(Number(merged.transcriptLineSpacing) || 1.55, 1.2, 2);
        merged.theme = merged.theme === 'dark' ? 'dark' : 'light';
        merged.locale = merged.locale || 'en-GB';
        merged.autoPunctuation = Boolean(merged.autoPunctuation);
        merged.interimResults = Boolean(merged.interimResults);
        merged.saveRawTranscript = Boolean(merged.saveRawTranscript);
        merged.summaryPrompt = String(merged.summaryPrompt || '').trim() || createDefaultSummaryPrompt();
        merged.splashDismissedAt = typeof merged.splashDismissedAt === 'number' ? merged.splashDismissedAt : null;
        return merged;
      }

      function getPersistableSettings() {
        const settings = Object.assign({}, state.settings || {});
        delete settings.secureStorageUnlocked;
        delete settings.fhirBearerToken;
        delete settings.fhirCustomHeaderValue;
        return settings;
      }

      function getSafeDocumentHref(value) {
        const rawValue = String(value || '').trim();
        if (!rawValue) return '';
        if (/[\u0000-\u001f\u007f]/.test(rawValue)) return '';
        try {
          const resolved = new URL(rawValue, window.location.href);
          if (!/^(https?:|mailto:|tel:)$/i.test(resolved.protocol)) return '';
          return resolved.protocol === 'http:' || resolved.protocol === 'https:' ? resolved.href : rawValue;
        } catch (error) {
          return '';
        }
      }

      function getSanitizedTableSpanAttribute(value) {
        const numericValue = Number(value);
        if (!Number.isInteger(numericValue)) return '';
        return String(clamp(numericValue, 1, 12));
      }

      function isValidHttpHeaderName(value) {
        return /^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(String(value || '').trim());
      }

      function getFhirCredentialStorageMessage() {
        const authType = state.settings.fhirAuthType;
        if (authType === 'none') return 'FHIR authentication is disabled.';
        const hasSecret = authType === 'bearer'
          ? Boolean(state.settings.fhirBearerToken)
          : Boolean(state.settings.fhirCustomHeaderValue);
        return hasSecret
          ? 'FHIR authentication secrets stay in memory only for this tab and are cleared on refresh.'
          : 'FHIR authentication secrets are not persisted. Enter them again after refresh when needed.';
      }

      function isEmbeddedInFrame() {
        try {
          return window.self !== window.top;
        } catch (error) {
          return true;
        }
      }

      function getFhirConfigurationError() {
        if (!hasConfiguredFhirEndpoint()) return 'Configure a valid FHIR endpoint URL in Settings before sending.';
        if (isEmbeddedInFrame()) return 'FHIR send is disabled while the app is embedded in another page.';
        if (state.settings.fhirAuthType === 'bearer' && !normaliseWhitespace(state.settings.fhirBearerToken)) {
          return 'Enter a bearer token for this tab before sending to the configured FHIR endpoint.';
        }
        if (state.settings.fhirAuthType === 'custom-header') {
          if (!isValidHttpHeaderName(state.settings.fhirCustomHeaderName)) return 'Enter a valid custom header name before sending to the configured FHIR endpoint.';
          if (!normaliseWhitespace(state.settings.fhirCustomHeaderValue)) return 'Enter a custom header value for this tab before sending to the configured FHIR endpoint.';
        }
        return '';
      }

      function describeSpeechRecognitionError(code) {
        const normalizedCode = String(code || 'unknown');
        if (normalizedCode === 'aborted') return 'Speech recognition stopped before a result was returned.';
        if (normalizedCode === 'audio-capture') return 'No working microphone was detected. Check the active recording device for this browser.';
        if (normalizedCode === 'network') return 'Speech recognition lost connectivity. Stop and restart the session after the browser connection recovers.';
        if (normalizedCode === 'no-speech') return 'No speech was detected. Check the microphone and try speaking again.';
        if (normalizedCode === 'not-allowed') return 'Microphone access was blocked for this page. Allow microphone access in the browser and try again.';
        if (normalizedCode === 'service-not-allowed') return 'The browser denied access to its speech recognition service for this page.';
        return 'Speech recognition failed with code: ' + normalizedCode + '.';
      }

      function isValidHttpUrl(value) {
        try {
          const url = new URL(String(value || '').trim());
          return /^https?:$/i.test(url.protocol);
        } catch (error) {
          return false;
        }
      }

      function hasConfiguredFhirEndpoint() {
        return isValidHttpUrl(state.settings.fhirEndpointUrl);
      }

      function maskSecretForDisplay(value) {
        const length = String(value || '').length;
        if (!length) return 'Not set';
        return 'In memory (' + String(length) + ' character' + (length === 1 ? '' : 's') + ')';
      }

      function getFhirEndpointStatusMessage() {
        if (!state.integrationStatus.message) return getFhirConfigurationError();
        return state.integrationStatus.message;
      }

      function buildFhirRequestHeaders() {
        const headers = {
          'Content-Type': 'application/fhir+json',
          Accept: 'application/fhir+json, application/json;q=0.9, */*;q=0.8'
        };
        if (state.settings.fhirAuthType === 'bearer' && state.settings.fhirBearerToken) {
          headers.Authorization = 'Bearer ' + state.settings.fhirBearerToken;
        }
        if (state.settings.fhirAuthType === 'custom-header' && isValidHttpHeaderName(state.settings.fhirCustomHeaderName)) {
          headers[state.settings.fhirCustomHeaderName] = state.settings.fhirCustomHeaderValue || '';
        }
        return headers;
      }

      function updateSessionFhirSendAudit(session, status, endpointUrl) {
        if (!session) return;
        session.lastFhirSentAt = Date.now();
        session.lastFhirSentStatus = String(status || '');
        session.lastFhirSentEndpoint = String(endpointUrl || '');
        session.updatedAt = Date.now();
        upsertSession(session);
      }

      function getFhirSendPayload(session) {
        const bundle = buildSessionFhirBundle(session);
        return {
          payload: state.settings.fhirSendMode === 'composition-only'
            ? deepClone(bundle.entry[0] && bundle.entry[0].resource ? bundle.entry[0].resource : bundle)
            : bundle,
          bundle
        };
      }

      async function fetchWithTimeout(url, options, timeoutMs = 12000) {
        const controller = new AbortController();
        const timerId = window.setTimeout(() => controller.abort(), timeoutMs);
        try {
          return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
        } finally {
          window.clearTimeout(timerId);
        }
      }

      async function sendSessionFhir(session) {
        if (!session) throw new Error('Select or open a session before sending FHIR.');
        const configurationError = getFhirConfigurationError();
        if (configurationError) throw new Error(configurationError);

        const endpointUrl = state.settings.fhirEndpointUrl.trim();
        const request = getFhirSendPayload(session);
        const headers = buildFhirRequestHeaders();

        try {
          const response = await fetchWithTimeout(endpointUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(request.payload, null, 2)
          });

          if (!response.ok) {
            updateSessionFhirSendAudit(session, 'failed (' + response.status + ')', endpointUrl);
            appendAuditEvent(session, 'fhir-sent', 'FHIR send failed.', { endpointUrl, status: response.status }, 'user');
            await persistSessions();
            throw new Error('Endpoint returned ' + response.status + ' ' + (response.statusText || 'response') + '.');
          }

          updateSessionFhirSendAudit(session, 'sent', endpointUrl);
          appendAuditEvent(session, 'fhir-sent', 'FHIR sent to configured endpoint.', { endpointUrl, status: response.status, mode: state.settings.fhirSendMode }, 'user');
          await persistSessions();
          renderConsultation();
          renderHistory();
          return { ok: true, status: response.status, mode: state.settings.fhirSendMode };
        } catch (error) {
          const message = error && error.name === 'AbortError'
            ? 'Request timed out while sending to the configured FHIR endpoint.'
            : normaliseWhitespace(error && error.message ? error.message : String(error || 'Unable to send FHIR.'));
          updateSessionFhirSendAudit(session, 'failed', endpointUrl);
          appendAuditEvent(session, 'fhir-sent', 'FHIR send failed.', { endpointUrl, status: 'failed' }, 'user');
          await persistSessions();
          renderConsultation();
          renderHistory();
          throw new Error(message);
        }
      }

      async function testFhirEndpointConnection() {
        const endpointUrl = String(state.settings.fhirEndpointUrl || '').trim();
        const configurationError = getFhirConfigurationError();
        if (configurationError && configurationError !== 'Enter a bearer token for this tab before sending to the configured FHIR endpoint.' && configurationError !== 'Enter a custom header value for this tab before sending to the configured FHIR endpoint.') {
          state.integrationStatus = {
            type: 'warning',
            message: configurationError
          };
          renderSettingsForm();
          return;
        }
        if (!isValidHttpUrl(endpointUrl)) {
          state.integrationStatus = {
            type: 'warning',
            message: 'Enter a valid http or https endpoint URL before testing.'
          };
          renderSettingsForm();
          return;
        }

        state.integrationStatus = {
          type: 'info',
          message: 'Testing endpoint reachability from this browser. Some FHIR servers may block cross-origin checks.'
        };
        renderSettingsForm();

        try {
          const response = await fetchWithTimeout(endpointUrl, {
            method: 'OPTIONS',
            headers: buildFhirRequestHeaders()
          }, 8000);
          state.integrationStatus = {
            type: response.ok ? 'success' : 'warning',
            message: response.ok
              ? 'Endpoint responded to browser testing. This does not guarantee a later POST will be accepted.'
              : 'Endpoint responded with ' + response.status + '. Browser reachability exists, but server acceptance may differ.'
          };
        } catch (error) {
          state.integrationStatus = {
            type: 'warning',
            message: 'Browser testing could not confirm the endpoint. URL format is valid, but the server may block OPTIONS, CORS, or cross-origin browser requests.'
          };
        }

        renderSettingsForm();
      }

      function saveSettings() {
        if (!writeStorage(STORAGE_KEYS.settings, getPersistableSettings())) showToast('Unable to save settings locally.', 'error', 4200);
      }

      function loadCustomisation() {
        const saved = readStorage(STORAGE_KEYS.customisation, {});
        const base = createDefaultCustomisation();
        const merged = Object.assign({}, base, saved || {});
        merged.organisationName = normaliseWhitespace(merged.organisationName) || base.organisationName;
        merged.brandingColor = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(merged.brandingColor || '') ? merged.brandingColor : base.brandingColor;
        merged.defaultConsultationType = normaliseWhitespace(merged.defaultConsultationType) || base.defaultConsultationType;
        merged.defaultPractitionerName = normaliseWhitespace(merged.defaultPractitionerName || '');
        merged.macros = Array.isArray(saved && saved.macros) ? saved.macros.map((macro) => ({ id: macro.id || uid('macro'), label: normaliseWhitespace(macro.label) || 'Snippet', text: String(macro.text || '') })) : base.macros;
        merged.customTags = dedupeStrings(Array.isArray(saved && saved.customTags) ? saved.customTags : base.customTags);
        merged.documentTemplates = Array.isArray(saved && saved.documentTemplates)
          ? saved.documentTemplates.map((template, index) => ({
              id: template.id || uid('doctype_' + index),
              name: normaliseWhitespace(template.name) || ('Document ' + String(index + 1)),
              instructions: String(template.instructions || '').trim()
            })).filter((template) => template.instructions)
          : base.documentTemplates;
        return merged;
      }

      function saveCustomisation() {
        if (!writeStorage(STORAGE_KEYS.customisation, state.customisation)) showToast('Unable to save customisation locally.', 'error', 4200);
      }

      function sortSessionsByUpdatedAt(sessions) {
        return sessions.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
      }

      function normaliseSessionCollection(rawSessions) {
        const sessions = Array.isArray(rawSessions) ? rawSessions.map(normaliseSession) : [];
        return sortSessionsByUpdatedAt(sessions);
      }

      function createSecureStorageRuntimeState() {
        return {
          unlocked: false,
          key: null,
          passphrase: '',
          lockedEnvelope: null,
          lockReason: '',
          showUnlockModal: false,
          modalError: '',
          persistWarning: '',
          lastPersistErrorAt: 0,
          lastPersistErrorMessage: '',
          autoLockTimerId: null,
          lastUnlockAt: null
        };
      }

      function createSessionLockState() {
        return {
          isLocked: false,
          lastUnlockAt: null,
          lastActivityAt: Date.now(),
          unlockMode: 'passphrase',
          lockedReason: null
        };
      }

      function createDestructiveConfirmState() {
        return {
          isOpen: false,
          action: '',
          phrase: 'DELETE ALL',
          title: 'Confirm deletion',
          message: 'This action permanently deletes local session data.',
          confirmLabel: 'Confirm',
          error: ''
        };
      }

      function mergeSessionCollections(primarySessions, secondarySessions) {
        const sessionMap = new Map();
        secondarySessions.concat(primarySessions).forEach((session) => {
          if (!session || !session.id) return;
          const existing = sessionMap.get(session.id);
          if (!existing || (session.updatedAt || 0) >= (existing.updatedAt || 0)) sessionMap.set(session.id, session);
        });
        return sortSessionsByUpdatedAt(Array.from(sessionMap.values()));
      }

      function isEphemeralSession(session) {
        return Boolean(session && session.ephemeral);
      }

      function getPersistableSessionsSnapshot() {
        return deepClone(sortSessionsByUpdatedAt(state.sessions.filter((session) => !isEphemeralSession(session)).slice()));
      }

      function getRetentionCutoffTimestamp() {
        const retentionDays = Number(state.settings.dataRetentionDays);
        if (!Number.isFinite(retentionDays) || retentionDays <= 0) return null;
        return Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
      }

      function isSessionProtectedFromAutomaticRetentionPurge(session) {
        return Boolean(session && state.activeSession && state.activeSession.id === session.id && session.status !== 'stopped');
      }

      function getSessionRetentionAnchor(session) {
        return session && (session.startedAt || session.createdAt || session.updatedAt || Date.now());
      }

      function clearSessionStorageBestEffort() {
        try {
          window.localStorage.removeItem(STORAGE_KEYS.sessions);
          return true;
        } catch (error) {
          return false;
        }
      }

      function renderDestructiveConfirmModal() {
        if (!refs.destructiveConfirmModal) return;
        refs.destructiveConfirmModal.classList.toggle('hidden', !state.destructiveConfirm.isOpen);
        refs.destructiveConfirmTitle.textContent = state.destructiveConfirm.title;
        refs.destructiveConfirmCopy.textContent = state.destructiveConfirm.message;
        refs.destructiveConfirmPhraseLabel.textContent = state.destructiveConfirm.phrase;
        refs.confirmDestructiveActionBtn.textContent = state.destructiveConfirm.confirmLabel;
        renderSupportBanner(refs.destructiveConfirmError, state.destructiveConfirm.error);
      }

      function openDestructiveConfirmModal(config) {
        state.destructiveConfirm.isOpen = true;
        state.destructiveConfirm.action = config.action;
        state.destructiveConfirm.phrase = config.phrase || 'DELETE ALL';
        state.destructiveConfirm.title = config.title || 'Confirm deletion';
        state.destructiveConfirm.message = config.message || 'This action permanently deletes local session data.';
        state.destructiveConfirm.confirmLabel = config.confirmLabel || 'Confirm';
        state.destructiveConfirm.error = '';
        if (refs.destructiveConfirmInput) refs.destructiveConfirmInput.value = '';
        renderDestructiveConfirmModal();
        window.setTimeout(() => {
          if (refs.destructiveConfirmInput) refs.destructiveConfirmInput.focus();
        }, 0);
      }

      function closeDestructiveConfirmModal() {
        state.destructiveConfirm.isOpen = false;
        state.destructiveConfirm.error = '';
        if (refs.destructiveConfirmInput) refs.destructiveConfirmInput.value = '';
        renderDestructiveConfirmModal();
      }

      function maybeResetSelectionAfterRemoval() {
        if (state.activeSession && !state.sessions.find((session) => session.id === state.activeSession.id)) resetConsultationDraft();
        if (state.historySelectedSessionId && !state.sessions.find((session) => session.id === state.historySelectedSessionId)) {
          state.historySelectedSessionId = null;
          state.historyEditMode = false;
        }
      }

      async function removeSessionsByPredicate(predicate, options = {}) {
        const sessionsToRemove = state.sessions.filter((session) => predicate(session));
        if (!sessionsToRemove.length) return { removedCount: 0, removedActive: false, didPersist: true };
        const removedActive = Boolean(state.activeSession && sessionsToRemove.some((session) => session.id === state.activeSession.id));
        sessionsToRemove.forEach((session) => clearSessionAuditDebounceState(session.id));
        state.sessions = state.sessions.filter((session) => !predicate(session));
        maybeResetSelectionAfterRemoval();
        const didPersist = options.skipPersist ? true : await persistSessions();
        return { removedCount: sessionsToRemove.length, removedActive, didPersist };
      }

      async function deleteArchivedSessionsNow() {
        if (!window.confirm('Delete all archived sessions from this browser now?')) return;
        const result = await removeSessionsByPredicate((session) => session.archived);
        if (!result.removedCount) {
          showToast('There are no archived sessions to delete.', 'info', 2600);
          return;
        }
        renderConsultation();
        renderHistory();
        renderDocumentsTab();
        showToast('Deleted ' + result.removedCount + ' archived session' + (result.removedCount === 1 ? '' : 's') + '.', 'success', 3200);
      }

      async function purgeSessionsOlderThanRetentionNow() {
        const cutoff = getRetentionCutoffTimestamp();
        if (!cutoff) {
          showToast('Set retention days above 0 before running a retention purge.', 'warning', 3200);
          return;
        }
        const eligibleCount = state.sessions.filter((session) => !isSessionProtectedFromAutomaticRetentionPurge(session) && getSessionRetentionAnchor(session) < cutoff).length;
        if (!eligibleCount) {
          showToast('No sessions are currently older than the retention cutoff.', 'info', 2600);
          return;
        }
        if (!window.confirm('Delete ' + eligibleCount + ' session' + (eligibleCount === 1 ? '' : 's') + ' older than the current retention cutoff?')) return;
        const result = await removeSessionsByPredicate((session) => !isSessionProtectedFromAutomaticRetentionPurge(session) && getSessionRetentionAnchor(session) < cutoff);
        renderConsultation();
        renderHistory();
        renderDocumentsTab();
        showToast('Deleted ' + result.removedCount + ' session' + (result.removedCount === 1 ? '' : 's') + '.', 'success', 3200);
      }

      function deleteAllSessionsNow() {
        openDestructiveConfirmModal({
          action: 'delete-all-sessions',
          phrase: 'DELETE ALL',
          title: 'Delete all sessions',
          message: 'This permanently deletes every saved or in-memory consultation in this browser, including archived sessions and any active consultation.',
          confirmLabel: 'Delete all sessions'
        });
      }

      async function executeDestructiveConfirmAction() {
        if (state.destructiveConfirm.action !== 'delete-all-sessions') return;
        const typedPhrase = normaliseWhitespace((refs.destructiveConfirmInput && refs.destructiveConfirmInput.value) || '').toUpperCase();
        if (typedPhrase !== state.destructiveConfirm.phrase) {
          state.destructiveConfirm.error = 'Type ' + state.destructiveConfirm.phrase + ' exactly to continue.';
          renderDestructiveConfirmModal();
          return;
        }
        const removedCount = state.sessions.length;
        if (state.speechProvider) state.speechProvider.stop();
        stopTimer();
        state.sessions.forEach((session) => clearSessionAuditDebounceState(session.id));
        state.sessions = [];
        state.historySelectedSessionId = null;
        state.historyEditMode = false;
        state.secureStorage.lockedEnvelope = null;
        state.secureStorage.persistWarning = '';
        state.lastPersistedAt = null;
        state.interimText = '';
        clearSessionStorageBestEffort();
        resetConsultationDraft();
        closeDestructiveConfirmModal();
        renderConsultation();
        renderHistory();
        renderDocumentsTab();
        renderLastSavedLabel();
        showToast('Deleted ' + removedCount + ' session' + (removedCount === 1 ? '' : 's') + ' from this browser.', 'success', 3600);
      }

      function clearSecureStorageAutoLockTimer() {
        if (!state || !state.secureStorage) return;
        window.clearTimeout(state.secureStorage.autoLockTimerId);
        state.secureStorage.autoLockTimerId = null;
      }

      function armSecureStorageAutoLockTimer() {
        clearSecureStorageAutoLockTimer();
        if (!state.settings.secureStorageEnabled || state.sessionLock.isLocked) return;
        const minutes = Number(state.settings.autoLockMinutes);
        if (!Number.isFinite(minutes) || minutes <= 0) return;
        const inactivityMs = minutes * 60 * 1000;
        const elapsed = Math.max(0, Date.now() - Number(state.sessionLock.lastActivityAt || Date.now()));
        const remaining = Math.max(0, inactivityMs - elapsed);
        state.secureStorage.autoLockTimerId = window.setTimeout(() => {
          lockSessionUi('inactivity', { showFeedback: true });
        }, remaining);
      }

      function clearSecureStorageAccess() {
        clearSecureStorageAutoLockTimer();
        state.secureStorage.key = null;
        state.secureStorage.passphrase = '';
        state.secureStorage.unlocked = false;
        state.settings.secureStorageUnlocked = false;
      }

      function markSecureStorageUnlocked(key, passphrase = '') {
        state.secureStorage.key = key;
        state.secureStorage.passphrase = String(passphrase || '');
        state.secureStorage.unlocked = true;
        state.settings.secureStorageUnlocked = true;
        state.secureStorage.lockReason = '';
        state.secureStorage.modalError = '';
        state.secureStorage.persistWarning = '';
        state.secureStorage.lastUnlockAt = Date.now();
        state.sessionLock.lastUnlockAt = state.secureStorage.lastUnlockAt;
        state.sessionLock.lastActivityAt = Date.now();
        state.sessionLock.unlockMode = getEffectiveSecureStorageMode();
        armSecureStorageAutoLockTimer();
      }

      function hasLockedSessionEnvelope() {
        return Boolean(state.secureStorage.lockedEnvelope && !state.secureStorage.unlocked);
      }

      function getLockedSessionPersistMessage() {
        if (!hasLockedSessionEnvelope()) return '';
        if (state.secureStorage.lockedEnvelope.mode === 'session') return 'Encrypted session history is locked and cannot be reopened after refresh in session-only mode. The stored payload has been left untouched.';
        return 'Encrypted session history is locked. Enter the passphrase to load saved sessions and resume secure saves.';
      }

      function isSessionUiLocked() {
        return Boolean(state.settings.secureStorageEnabled && state.sessionLock.isLocked);
      }

      function getSessionLockReasonMessage() {
        if (!isSessionUiLocked()) return '';
        if (state.sessionLock.lockedReason === 'session-key-unavailable') return 'This tab no longer has the in-memory session key required to unlock previously encrypted session history.';
        if (state.sessionLock.lockedReason === 'inactivity') return 'The app locked after a period of inactivity.';
        if (state.sessionLock.lockedReason === 'manual') return 'The app was locked manually.';
        if (state.sessionLock.lockedReason === 'passphrase-required') return 'Enter the secure storage passphrase to view saved consultation data.';
        return 'Unlock the app to view sensitive consultation data.';
      }

      function getSessionLockPlaceholderText(area) {
        const areaLabel = area || 'session data';
        if (state.sessionLock.unlockMode === 'session' && state.sessionLock.lockedReason === 'session-key-unavailable') {
          return 'Protected ' + areaLabel + ' cannot be reopened after refresh because the session-only key was only kept in memory.';
        }
        return 'Protected ' + areaLabel + ' is hidden while the app is locked.';
      }

      function renderLockedPlaceholder(text, size = 'small') {
        return '<div class="empty-state' + (size === 'small' ? ' small' : '') + '">' + escapeHtml(text) + '</div>';
      }

      function stopActiveSessionForLock() {
        if (!state.activeSession || !['listening', 'paused'].includes(state.activeSession.status)) return;
        stopListening();
        showToast('The active consultation was stopped before the app locked.', 'warning', 4200);
      }

      function lockSessionUi(reason, options = {}) {
        const shouldShowFeedback = options.showFeedback !== false;
        if (!state.settings.secureStorageEnabled && !hasLockedSessionEnvelope()) return;
        stopActiveSessionForLock();
        if (state.activeSession) {
          appendAuditEvent(
            state.activeSession,
            'secure-lock',
            'App lock engaged.',
            { reason: reason || 'manual' },
            reason === 'manual' ? 'user' : 'system'
          );
          upsertSession(state.activeSession);
        }
        state.sessionLock.isLocked = true;
        state.sessionLock.unlockMode = getEffectiveSecureStorageMode();
        state.sessionLock.lockedReason = reason || 'manual';
        state.secureStorage.showUnlockModal = false;
        state.secureStorage.modalError = '';

        if (state.sessionLock.unlockMode === 'passphrase' || hasLockedSessionEnvelope()) {
          clearSecureStorageAccess();
        } else {
          clearSecureStorageAutoLockTimer();
        }

        renderConsultation();
        renderHistory();
        renderDocumentsTab();
        renderSettingsForm();
        renderSecureStorageModal();

        if (shouldShowFeedback) {
          const message = reason === 'inactivity' ? 'The app locked after inactivity.' : 'The app is now locked.';
          showToast(message, 'info', 2600);
        }
      }

      function unlockSessionUi() {
        if (state.activeSession) {
          appendAuditEvent(state.activeSession, 'secure-unlock', 'App unlocked.', { mode: getEffectiveSecureStorageMode() }, 'user');
          upsertSession(state.activeSession);
          persistSessionsDebounced();
        }
        state.sessionLock.isLocked = false;
        state.sessionLock.lockedReason = null;
        state.sessionLock.unlockMode = getEffectiveSecureStorageMode();
        state.sessionLock.lastUnlockAt = Date.now();
        state.sessionLock.lastActivityAt = Date.now();
        state.secureStorage.showUnlockModal = false;
        armSecureStorageAutoLockTimer();
        renderConsultation();
        renderHistory();
        renderDocumentsTab();
        renderSettingsForm();
        renderSecureStorageModal();
      }

      function recordSessionActivity() {
        if (!state.settings.secureStorageEnabled || isSessionUiLocked()) return;
        state.sessionLock.lastActivityAt = Date.now();
        armSecureStorageAutoLockTimer();
      }

      async function ensureRuntimeSessionKey() {
        if (hasLockedSessionEnvelope()) throw new Error(getLockedSessionPersistMessage());
        if (state.secureStorage.unlocked && isCryptoKeyLike(state.secureStorage.key)) return state.secureStorage.key;
        const key = await generateInMemorySessionKey();
        markSecureStorageUnlocked(key);
        return key;
      }

      async function loadSessions() {
        const saved = readStorage(STORAGE_KEYS.sessions, []);
        if (Array.isArray(saved)) {
          state.sessions = normaliseSessionCollection(saved);
          state.secureStorage.lockedEnvelope = null;
          state.secureStorage.lockReason = '';
          state.secureStorage.persistWarning = '';
          return state.sessions;
        }
        if (isEncryptedSessionEnvelope(saved)) {
          clearSecureStorageAccess();
          state.sessions = [];
          state.secureStorage.lockedEnvelope = saved;
          state.secureStorage.lockReason = saved.mode === 'session' ? 'session-key-unavailable' : 'passphrase-required';
          state.secureStorage.persistWarning = getLockedSessionPersistMessage();
          return state.sessions;
        }
        state.sessions = [];
        state.secureStorage.lockedEnvelope = null;
        state.secureStorage.lockReason = '';
        state.secureStorage.persistWarning = '';
        return state.sessions;
      }

      async function persistSessions() {
        const persistToken = uid('persist');
        const snapshot = getPersistableSessionsSnapshot();
        state.sessionPersistToken = persistToken;
        try {
          let payload = snapshot;

          if (hasLockedSessionEnvelope()) throw new Error(getLockedSessionPersistMessage());

          if (!snapshot.length) {
            if (state.sessionPersistToken !== persistToken) return false;
            clearSessionStorageBestEffort();
            state.lastPersistedAt = null;
            state.secureStorage.persistWarning = '';
            state.secureStorage.lastPersistErrorAt = 0;
            state.secureStorage.lastPersistErrorMessage = '';
            renderLastSavedLabel();
            if (state.currentTab === 'history') {
              renderHistoryList();
              if (!state.historyEditMode) renderHistoryDetail();
            }
            renderSettingsForm();
            return true;
          }

          if (state.settings.secureStorageEnabled) {
            if (!isWebCryptoAvailable()) throw new Error('Web Crypto API is unavailable in this browser, so secure local storage cannot be used here.');
            const mode = state.settings.secureStorageMode === 'session' ? 'session' : 'passphrase';
            if (mode === 'session') {
              const key = await ensureRuntimeSessionKey();
              payload = await encryptJsonValue(snapshot, key, mode);
            } else {
              const passphrase = String(state.secureStorage.passphrase || '');
              if (!state.secureStorage.unlocked || !passphrase) throw new Error('Secure local storage is enabled but locked. Enter the passphrase before sessions can be saved.');
              payload = await encryptJsonValue(snapshot, passphrase, mode);
            }
            armSecureStorageAutoLockTimer();
          }

          if (state.sessionPersistToken !== persistToken) return false;
          if (!writeStorage(STORAGE_KEYS.sessions, payload)) throw new Error('write failed');
          state.lastPersistedAt = Date.now();
          state.secureStorage.persistWarning = '';
          state.secureStorage.lastPersistErrorAt = 0;
          state.secureStorage.lastPersistErrorMessage = '';
          renderLastSavedLabel();
          if (state.currentTab === 'history') {
            renderHistoryList();
            if (!state.historyEditMode) renderHistoryDetail();
          }
          renderSettingsForm();
          return true;
        } catch (error) {
          const detail = normaliseWhitespace(error && error.message ? error.message : String(error || ''));
          state.secureStorage.persistWarning = detail || 'Unable to save locally.';
          renderLastSavedLabel();
          renderSettingsForm();
          renderHistory();
          const now = Date.now();
          if (detail !== state.secureStorage.lastPersistErrorMessage || (now - state.secureStorage.lastPersistErrorAt) > 4000) {
            state.secureStorage.lastPersistErrorMessage = detail;
            state.secureStorage.lastPersistErrorAt = now;
            showToast(detail || 'Unable to save locally. Local storage may be full or unavailable.', 'error', 4200);
          }
          return false;
        }
      }

      function purgeOldSessions() {
        const cutoff = getRetentionCutoffTimestamp();
        if (!cutoff) return 0;
        const beforeCount = state.sessions.length;
        state.sessions = state.sessions.filter((session) => {
          if (isSessionProtectedFromAutomaticRetentionPurge(session)) return true;
          const anchor = getSessionRetentionAnchor(session);
          return anchor >= cutoff;
        });
        maybeResetSelectionAfterRemoval();
        return beforeCount - state.sessions.length;
      }

      const persistSessionsDebounced = debounce(() => { persistSessions(); }, 450);

      const state = {
        currentTab: 'consultation',
        settings: loadSettings(),
        customisation: loadCustomisation(),
        sessions: [],
        activeSession: null,
        consultationDraftTags: [],
        interimText: '',
        transcriptSearch: '',
        historySelectedSessionId: null,
        historyEditMode: false,
        historyDetailSearch: '',
        reviewMode: {
          consultationLowConfidenceOnly: false,
          historyLowConfidenceOnly: false
        },
        historySelectedAssetId: 'summary',
        selectedDocumentId: null,
        documentGenerationRequest: null,
        integrationStatus: {
          type: 'info',
          message: ''
        },
        showSplash: false,
        showApiHelpModal: false,
        capabilityCheckToken: null,
        apiCapabilityStatus: {
          speech: { availability: stateSupports('webkitSpeechRecognition' in window), detail: '' },
          prompt: { availability: 'checking', detail: 'Checking browser support...' },
          summarizer: { availability: 'checking', detail: 'Checking browser support...' }
        },
        timerIntervalId: null,
        autoSaveIntervalId: null,
        speechProvider: null,
        supportsSpeech: 'webkitSpeechRecognition' in window,
        summaryRequestTokens: {},
        lastPersistedAt: null,
        secureStorage: createSecureStorageRuntimeState(),
        sessionLock: createSessionLockState(),
        destructiveConfirm: createDestructiveConfirmState(),
        sessionPersistToken: null,
        auditDebounce: {
          manualNotesTimers: {},
          transcriptEditTimers: {},
          manualNotesSignatures: {}
        }
      };

      const refs = {
        toastContainer: $('toastContainer'),
        orgDisplay: $('orgDisplay'),
        consultationOrgName: $('consultationOrgName'),
        patientName: $('patientName'),
        clinicianName: $('clinicianName'),
        consultationType: $('consultationType'),
        splashOverlay: $('splashOverlay'),
        splashOrganisationName: $('splashOrganisationName'),
        splashPractitionerName: $('splashPractitionerName'),
        splashApiStatusList: $('splashApiStatusList'),
        openApiHelpBtn: $('openApiHelpBtn'),
        refreshSplashStatusBtn: $('refreshSplashStatusBtn'),
        continueFromSplashBtn: $('continueFromSplashBtn'),
        apiHelpModal: $('apiHelpModal'),
        closeApiHelpBtn: $('closeApiHelpBtn'),
        secureStorageModal: $('secureStorageModal'),
        closeSecureStorageModalBtn: $('closeSecureStorageModalBtn'),
        secureStorageCancelBtn: $('secureStorageCancelBtn'),
        secureStorageModalTitle: $('secureStorageModalTitle'),
        secureStorageModalCopy: $('secureStorageModalCopy'),
        secureStoragePassphraseField: $('secureStoragePassphraseField'),
        secureStoragePassphraseInput: $('secureStoragePassphraseInput'),
        secureStorageModalError: $('secureStorageModalError'),
        unlockSecureStorageBtn: $('unlockSecureStorageBtn'),
        destructiveConfirmModal: $('destructiveConfirmModal'),
        closeDestructiveConfirmBtn: $('closeDestructiveConfirmBtn'),
        destructiveConfirmTitle: $('destructiveConfirmTitle'),
        destructiveConfirmCopy: $('destructiveConfirmCopy'),
        destructiveConfirmInput: $('destructiveConfirmInput'),
        destructiveConfirmPhraseLabel: $('destructiveConfirmPhraseLabel'),
        destructiveConfirmError: $('destructiveConfirmError'),
        cancelDestructiveConfirmBtn: $('cancelDestructiveConfirmBtn'),
        confirmDestructiveActionBtn: $('confirmDestructiveActionBtn'),
        manualNotes: $('manualNotes'),
        statusPill: $('statusPill'),
        sessionTimer: $('sessionTimer'),
        speechSupportMessage: $('speechSupportMessage'),
        consultationPrivacyMessage: $('consultationPrivacyMessage'),
        transcriptEditHint: $('transcriptEditHint'),
        transcriptContainer: $('transcriptContainer'),
        interimContainer: $('interimContainer'),
        interimText: $('interimText'),
        consultationSummaryCard: $('consultationSummaryCard'),
        consultationSummary: $('consultationSummary'),
        consultationSummaryMeta: $('consultationSummaryMeta'),
        generateSummaryBtn: $('generateSummaryBtn'),
        consultationStructuredCard: $('consultationStructuredCard'),
        consultationStructuredMeta: $('consultationStructuredMeta'),
        consultationStructuredContainer: $('consultationStructuredContainer'),
        extractStructuredBtn: $('extractStructuredBtn'),
        consultationReviewCard: $('consultationReviewCard'),
        consultationReviewMeta: $('consultationReviewMeta'),
        consultationReviewContainer: $('consultationReviewContainer'),
        consultationReviewLowConfidenceToggle: $('consultationReviewLowConfidenceToggle'),
        documentGenerationCard: $('documentGenerationCard'),
        documentCardMeta: $('documentCardMeta'),
        consultationDocumentType: $('consultationDocumentType'),
        generateDocumentBtn: $('generateDocumentBtn'),
        openDocumentsTabBtn: $('openDocumentsTabBtn'),
        consultationDocumentsList: $('consultationDocumentsList'),
        transcriptSearch: $('transcriptSearch'),
        copyTranscriptBtn: $('copyTranscriptBtn'),
        exportTranscriptBtn: $('exportTranscriptBtn'),
        downloadFhirBtn: $('downloadFhirBtn'),
        sendFhirBtn: $('sendFhirBtn'),
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
        documentsTabBtn: $('documentsTabBtn'),
        historyPatientFilter: $('historyPatientFilter'),
        historyClinicianFilter: $('historyClinicianFilter'),
        historyDateFilter: $('historyDateFilter'),
        historyHideArchived: $('historyHideArchived'),
        historySecurityMessage: $('historySecurityMessage'),
        historyDetail: $('historyDetail'),
        historyEditToggle: $('historyEditToggle'),
        historySaveBtn: $('historySaveBtn'),
        historyDownloadFhirBtn: $('historyDownloadFhirBtn'),
        historySendFhirBtn: $('historySendFhirBtn'),
        historyDetailHint: $('historyDetailHint'),
        settingLocale: $('settingLocale'),
        settingAutoPunctuation: $('settingAutoPunctuation'),
        settingInterimResults: $('settingInterimResults'),
        settingSaveRawTranscript: $('settingSaveRawTranscript'),
        settingSecureStorageEnabled: $('settingSecureStorageEnabled'),
        settingSecureStorageMode: $('settingSecureStorageMode'),
        settingAutoLockMinutes: $('settingAutoLockMinutes'),
        settingSecureStorageStatus: $('settingSecureStorageStatus'),
        settingSecureStorageHelp: $('settingSecureStorageHelp'),
        openSecureStorageModalBtn: $('openSecureStorageModalBtn'),
        lockSecureStorageBtn: $('lockSecureStorageBtn'),
        settingAutoSaveInterval: $('settingAutoSaveInterval'),
        settingAutoSaveIntervalValue: $('settingAutoSaveIntervalValue'),
        settingTheme: $('settingTheme'),
        settingDataRetentionDays: $('settingDataRetentionDays'),
        settingPurgeOnBrowserClose: $('settingPurgeOnBrowserClose'),
        settingEphemeralConsultationMode: $('settingEphemeralConsultationMode'),
        purgeOldSessionsNowBtn: $('purgeOldSessionsNowBtn'),
        deleteArchivedSessionsBtn: $('deleteArchivedSessionsBtn'),
        deleteAllSessionsBtn: $('deleteAllSessionsBtn'),
        settingTranscriptFontSize: $('settingTranscriptFontSize'),
        settingTranscriptFontSizeValue: $('settingTranscriptFontSizeValue'),
        settingLineSpacing: $('settingLineSpacing'),
        settingLineSpacingValue: $('settingLineSpacingValue'),
        settingSummaryPrompt: $('settingSummaryPrompt'),
        settingSummaryAvailability: $('settingSummaryAvailability'),
        settingsSecurityMessage: $('settingsSecurityMessage'),
        settingFhirEndpointUrl: $('settingFhirEndpointUrl'),
        settingFhirSendMode: $('settingFhirSendMode'),
        settingFhirAuthType: $('settingFhirAuthType'),
        settingFhirBearerTokenRow: $('settingFhirBearerTokenRow'),
        settingFhirBearerToken: $('settingFhirBearerToken'),
        settingFhirBearerTokenStatus: $('settingFhirBearerTokenStatus'),
        settingFhirCustomHeaderNameRow: $('settingFhirCustomHeaderNameRow'),
        settingFhirCustomHeaderName: $('settingFhirCustomHeaderName'),
        settingFhirCustomHeaderValueRow: $('settingFhirCustomHeaderValueRow'),
        settingFhirCustomHeaderValue: $('settingFhirCustomHeaderValue'),
        settingFhirCustomHeaderValueStatus: $('settingFhirCustomHeaderValueStatus'),
        testFhirEndpointBtn: $('testFhirEndpointBtn'),
        fhirEndpointStatusMessage: $('fhirEndpointStatusMessage'),
        documentsTemplateSelect: $('documentsTemplateSelect'),
        documentsGenerateBtn: $('documentsGenerateBtn'),
        documentsList: $('documentsList'),
        documentPreview: $('documentPreview'),
        documentDetailTitle: $('documentDetailTitle'),
        documentDetailMeta: $('documentDetailMeta'),
        documentsMetaText: $('documentsMetaText'),
        copyDocumentTextBtn: $('copyDocumentTextBtn'),
        downloadDocumentBtn: $('downloadDocumentBtn'),
        customOrgName: $('customOrgName'),
        customBrandColor: $('customBrandColor'),
        customBrandColorValue: $('customBrandColorValue'),
        customDefaultConsultationType: $('customDefaultConsultationType'),
        customDefaultPractitionerName: $('customDefaultPractitionerName'),
        brandPreviewTitle: $('brandPreviewTitle'),
        brandPreview: $('brandPreview'),
        reopenSplashBtn: $('reopenSplashBtn'),
        newMacroLabel: $('newMacroLabel'),
        newMacroText: $('newMacroText'),
        addMacroBtn: $('addMacroBtn'),
        macroList: $('macroList'),
        newCustomTag: $('newCustomTag'),
        addCustomTagBtn: $('addCustomTagBtn'),
        customTagList: $('customTagList'),
        newDocumentTemplateName: $('newDocumentTemplateName'),
        newDocumentTemplateInstructions: $('newDocumentTemplateInstructions'),
        addDocumentTemplateBtn: $('addDocumentTemplateBtn'),
        documentTemplateList: $('documentTemplateList')
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

      function stateSupports(value) {
        return value ? 'available' : 'unavailable';
      }

      function getLanguageModelApi() {
        return typeof globalThis.LanguageModel !== 'undefined' ? globalThis.LanguageModel : null;
      }

      function getSummarizerApi() {
        return typeof globalThis.Summarizer !== 'undefined' ? globalThis.Summarizer : null;
      }

      function findSession(sessionId) { return state.sessions.find((session) => session.id === sessionId) || null; }

      function getDefaultPractitionerName() {
        return normaliseWhitespace(state.customisation.defaultPractitionerName || '');
      }

      function getPromptApiAvailabilityLabel(value) {
        const labels = {
          available: 'Available',
          downloadable: 'Not ready yet',
          downloading: 'Downloading model',
          unavailable: 'Unavailable',
          'checking': 'Checking',
          'availability-check-failed': 'Check failed'
        };
        return labels[value] || 'Unavailable';
      }

      function getCapabilityStatusItems() {
        return [
          {
            key: 'speech',
            title: 'Speech recognition',
            description: 'Live consultation transcription in a supported browser.',
            availability: state.apiCapabilityStatus.speech.availability,
            detail: state.apiCapabilityStatus.speech.detail || (state.supportsSpeech ? 'Speech recognition is available in this browser.' : 'Speech recognition was not detected in this browser.')
          },
          {
            key: 'prompt',
            title: 'Prompt API',
            description: 'Primary engine for summaries and document drafting.',
            availability: state.apiCapabilityStatus.prompt.availability,
            detail: state.apiCapabilityStatus.prompt.detail
          },
          {
            key: 'summarizer',
            title: 'Summarizer API',
            description: 'Fallback summary engine when Prompt API is unavailable.',
            availability: state.apiCapabilityStatus.summarizer.availability,
            detail: state.apiCapabilityStatus.summarizer.detail
          }
        ];
      }

      function getCapabilityIndicator(availability) {
        if (availability === 'available') return '✅';
        if (availability === 'checking') return '⏳';
        return '❌';
      }

      function renderSplashScreen() {
        if (!refs.splashOverlay) return;
        refs.splashOrganisationName.value = state.customisation.organisationName === 'Findon Software' ? '' : (state.customisation.organisationName || '');
        refs.splashPractitionerName.value = getDefaultPractitionerName();
        refs.splashApiStatusList.innerHTML = getCapabilityStatusItems().map((item) => {
          const availability = item.availability || 'unavailable';
          const statusClass = availability === 'available' ? 'available' : (availability === 'checking' ? 'pending' : 'unavailable');
          return '<div class="api-status-item ' + statusClass + '"><div class="api-status-icon" aria-hidden="true">' + getCapabilityIndicator(availability) + '</div><div><h4>' + escapeHtml(item.title) + '</h4><div><span class="api-status-label">' + escapeHtml(getPromptApiAvailabilityLabel(availability)) + '</span><span class="api-status-detail">' + escapeHtml(item.detail || item.description) + '</span></div></div></div>';
        }).join('');
        refs.splashOverlay.classList.toggle('hidden', !state.showSplash);
        refs.apiHelpModal.classList.toggle('hidden', !state.showApiHelpModal);
      }

      function openSplashScreen() {
        state.showSplash = true;
        renderSplashScreen();
        refreshApiCapabilityChecks();
      }

      function closeSplashScreen() {
        state.showSplash = false;
        renderSplashScreen();
      }

      function openApiHelpModal() {
        state.showApiHelpModal = true;
        renderSplashScreen();
      }

      function closeApiHelpModal() {
        state.showApiHelpModal = false;
        renderSplashScreen();
      }

      function getEffectiveSecureStorageMode() {
        return state.secureStorage.lockedEnvelope ? state.secureStorage.lockedEnvelope.mode : state.settings.secureStorageMode;
      }

      function canPromptForSecureStoragePassphrase() {
        return getEffectiveSecureStorageMode() === 'passphrase';
      }

      function canUnlockCurrentSession() {
        if (!state.settings.secureStorageEnabled && !hasLockedSessionEnvelope()) return false;
        if (canPromptForSecureStoragePassphrase()) return true;
        if (hasLockedSessionEnvelope()) return false;
        return isCryptoKeyLike(state.secureStorage.key) || state.secureStorage.unlocked || !state.settings.secureStorageEnabled;
      }

      function getSecureStorageWarningMessage() {
        if (isSessionUiLocked()) return getSessionLockReasonMessage();
        if (hasLockedSessionEnvelope()) {
          if (state.secureStorage.lockedEnvelope.mode === 'session') {
            return 'Encrypted session history was saved with a session-only key and this tab no longer has that in-memory key. The locked payload has been preserved, but it cannot be reopened after refresh.';
          }
          return 'Encrypted session history is locked. Enter the secure storage passphrase to load saved sessions. Until then, changes remain in memory only and will not overwrite the locked payload.';
        }
        if (state.settings.secureStorageEnabled && state.settings.secureStorageMode === 'passphrase' && !state.secureStorage.unlocked) {
          return 'Secure local storage is enabled but currently locked. Enter the passphrase before sessions can be saved locally.';
        }
        return state.secureStorage.persistWarning || '';
      }

      function getSecureStorageStatusText() {
        if (hasLockedSessionEnvelope()) {
          return state.secureStorage.lockedEnvelope.mode === 'session'
            ? 'Locked encrypted history cannot be reopened because the session-only key was lost after refresh.'
            : 'Encrypted session history is locked until the correct passphrase is entered.';
        }
        if (!state.settings.secureStorageEnabled) return 'Secure local storage is disabled.';
        if (state.settings.secureStorageMode === 'session') {
          return state.secureStorage.unlocked
            ? 'Secure local storage is enabled with a session-only key for this tab.'
            : 'Secure local storage is enabled. A new session-only key will be created in memory on the next save.';
        }
        return state.secureStorage.unlocked
          ? 'Secure local storage is enabled and currently unlocked for this tab.'
          : 'Secure local storage is enabled but locked.';
      }

      function getSecureStorageHelpText() {
        if (!isWebCryptoAvailable()) return 'Web Crypto API is unavailable in this browser, so encrypted local storage cannot be used here.';
        if (getEffectiveSecureStorageMode() === 'session') return 'Session-only mode keeps the AES key in memory and never stores it. Refreshing or closing the tab makes previously encrypted history unavailable.';
        return 'Passphrase mode lets you reopen encrypted history after refresh by entering the same passphrase again. The passphrase is never stored by this app.';
      }

      function renderSupportBanner(target, message) {
        if (!target) return;
        const content = normaliseWhitespace(message);
        target.classList.toggle('visible', Boolean(content));
        target.textContent = content;
      }

      function openSecureStorageModal() {
        if (!canPromptForSecureStoragePassphrase() && !isSessionUiLocked()) {
          showToast('This encrypted session history cannot be unlocked with a passphrase.', 'warning', 4200);
          return;
        }
        state.secureStorage.showUnlockModal = true;
        state.secureStorage.modalError = '';
        renderSecureStorageModal();
        window.setTimeout(() => {
          if (refs.secureStoragePassphraseInput) refs.secureStoragePassphraseInput.focus();
        }, 0);
      }

      function closeSecureStorageModal() {
        if (isSessionUiLocked()) return;
        state.secureStorage.showUnlockModal = false;
        state.secureStorage.modalError = '';
        if (refs.secureStoragePassphraseInput) refs.secureStoragePassphraseInput.value = '';
        renderSecureStorageModal();
      }

      function renderSecureStorageModal() {
        if (!refs.secureStorageModal) return;
        const lockScreenVisible = isSessionUiLocked();
        const passphraseMode = canPromptForSecureStoragePassphrase();
        const hasLockedPayload = hasLockedSessionEnvelope();
        const isVisible = lockScreenVisible || state.secureStorage.showUnlockModal;
        refs.secureStorageModal.classList.toggle('hidden', !isVisible);
        refs.closeSecureStorageModalBtn.classList.toggle('hidden', lockScreenVisible);
        refs.secureStorageCancelBtn.classList.toggle('hidden', lockScreenVisible);
        refs.secureStorageModalTitle.textContent = lockScreenVisible ? 'Session locked' : (hasLockedPayload ? 'Unlock encrypted session history' : 'Unlock secure local storage');
        if (lockScreenVisible) {
          refs.secureStorageModalCopy.textContent = passphraseMode
            ? 'Sensitive consultation content is hidden while the app is locked. Enter the passphrase to continue.'
            : (hasLockedPayload
              ? 'This app is locked and the previous encrypted session history cannot be reopened because the session-only key is no longer in memory.'
              : 'Sensitive consultation content is hidden while the app is locked. Use the in-memory session key to unlock this tab.');
        } else {
          refs.secureStorageModalCopy.textContent = hasLockedPayload
            ? 'Enter the passphrase used when session history was encrypted in this browser.'
            : 'Enter a passphrase to keep secure local storage unlocked in this tab. It will not be stored by this app.';
        }
        refs.secureStoragePassphraseField.classList.toggle('hidden', !passphraseMode);
        refs.unlockSecureStorageBtn.disabled = passphraseMode ? false : !canUnlockCurrentSession();
        refs.unlockSecureStorageBtn.textContent = passphraseMode
          ? (hasLockedPayload ? 'Unlock session history' : 'Unlock secure local storage')
          : (canUnlockCurrentSession() ? 'Unlock this tab' : 'Unavailable after refresh');
        const overlayMessage = lockScreenVisible
          ? [state.secureStorage.modalError, getSessionLockReasonMessage()].filter(Boolean).join(' ')
          : state.secureStorage.modalError;
        renderSupportBanner(refs.secureStorageModalError, overlayMessage);
      }

      async function unlockSecureStorageWithPassphrase(passphrase) {
        const normalizedPassphrase = String(passphrase || '');
        if (!normalizedPassphrase) throw new Error('Enter a passphrase to continue.');
        const envelope = state.secureStorage.lockedEnvelope;
        const storedEnvelope = !envelope && isEncryptedSessionEnvelope(readStorage(STORAGE_KEYS.sessions, null)) ? readStorage(STORAGE_KEYS.sessions, null) : null;
        const saltBytes = envelope && envelope.salt ? base64ToUint8Array(envelope.salt) : getRandomBytes(SESSION_STORAGE_SALT_BYTES);
        const key = await deriveKeyFromPassphrase(normalizedPassphrase, saltBytes);

        if (envelope) {
          const decryptedSessions = await decryptJsonValue(envelope, normalizedPassphrase);
          if (!Array.isArray(decryptedSessions)) throw new Error('Encrypted session history could not be decoded.');
          state.sessions = mergeSessionCollections(normaliseSessionCollection(decryptedSessions), state.sessions);
          state.secureStorage.lockedEnvelope = null;
        } else if (storedEnvelope) {
          await decryptJsonValue(storedEnvelope, normalizedPassphrase);
        }

        markSecureStorageUnlocked(key, normalizedPassphrase);
        unlockSessionUi();
        if (!isSessionUiLocked()) closeSecureStorageModal();
        showToast(envelope ? 'Encrypted session history unlocked.' : 'Secure local storage unlocked for this tab.', 'success', 2400);
      }

      async function unlockCurrentSession() {
        if (canPromptForSecureStoragePassphrase()) {
          await unlockSecureStorageWithPassphrase(refs.secureStoragePassphraseInput.value);
          return;
        }
        if (!canUnlockCurrentSession()) throw new Error('This session cannot be unlocked in the current browser tab.');
        if (!state.secureStorage.unlocked && state.settings.secureStorageEnabled && state.settings.secureStorageMode === 'session' && !isCryptoKeyLike(state.secureStorage.key)) {
          const key = await ensureRuntimeSessionKey();
          markSecureStorageUnlocked(key);
        }
        unlockSessionUi();
        showToast('Session unlocked for this tab.', 'success', 2200);
      }

      async function getPromptApiAvailability() {
        const languageModelApi = getLanguageModelApi();
        if (!languageModelApi) return 'unavailable';
        try {
          return await languageModelApi.availability(getPromptApiOptions());
        } catch (error) {
          return 'availability-check-failed';
        }
      }

      async function getSummarizerAvailability() {
        const summarizerApi = getSummarizerApi();
        if (!summarizerApi) return 'unavailable';
        try {
          if (typeof summarizerApi.availability === 'function') return await summarizerApi.availability();
          return 'available';
        } catch (error) {
          return 'availability-check-failed';
        }
      }

      async function refreshApiCapabilityChecks() {
        const requestToken = uid('capability');
        state.capabilityCheckToken = requestToken;
        state.apiCapabilityStatus.speech = {
          availability: stateSupports(state.supportsSpeech),
          detail: state.supportsSpeech ? 'Speech recognition is available in this browser.' : 'Speech recognition is not available. Open the app in a supported Chromium browser such as Chrome or Edge to use live transcription.'
        };
        state.apiCapabilityStatus.prompt = { availability: 'checking', detail: 'Checking Prompt API availability...' };
        state.apiCapabilityStatus.summarizer = { availability: 'checking', detail: 'Checking Summarizer API availability...' };
        renderSplashScreen();

        const promptAvailability = await getPromptApiAvailability();
        if (state.capabilityCheckToken !== requestToken) return;
        if (promptAvailability === 'unavailable') {
          state.apiCapabilityStatus.prompt = {
            availability: 'unavailable',
            detail: 'Prompt API was not detected in this browser.'
          };
        } else if (promptAvailability === 'availability-check-failed') {
          state.apiCapabilityStatus.prompt = {
            availability: 'availability-check-failed',
            detail: 'Prompt API was detected, but the availability check failed in this browser build.'
          };
        } else {
          state.apiCapabilityStatus.prompt = {
            availability: promptAvailability,
            detail: promptAvailability === 'available'
              ? 'Prompt API is ready for on-device document drafting and SOAP summaries.'
              : ('Prompt API was detected, but it is currently ' + promptAvailability + '.')
          };
        }

        const summarizerAvailability = await getSummarizerAvailability();
        if (state.capabilityCheckToken !== requestToken) return;
        if (summarizerAvailability === 'unavailable') {
          state.apiCapabilityStatus.summarizer = {
            availability: 'unavailable',
            detail: 'Summarizer API was not detected in this browser.'
          };
        } else if (summarizerAvailability === 'availability-check-failed') {
          state.apiCapabilityStatus.summarizer = {
            availability: 'availability-check-failed',
            detail: 'Summarizer API was detected, but the availability check failed in this browser build.'
          };
        } else {
          state.apiCapabilityStatus.summarizer = {
            availability: summarizerAvailability === 'available' ? 'available' : String(summarizerAvailability || 'unavailable'),
            detail: summarizerAvailability === 'available'
              ? 'Summarizer API is available as a fallback for summary generation.'
              : ('Summarizer API was detected, but it is currently ' + summarizerAvailability + '.')
          };
        }

        if (state.capabilityCheckToken === requestToken) renderSplashScreen();
      }

      function saveSplashProfileAndContinue() {
        const organisationName = normaliseWhitespace(refs.splashOrganisationName.value);
        const practitionerName = normaliseWhitespace(refs.splashPractitionerName.value);
        const previousPractitioner = getDefaultPractitionerName();
        const previousOrganisation = state.customisation.organisationName;

        if (organisationName) state.customisation.organisationName = organisationName;
        state.customisation.defaultPractitionerName = practitionerName;
        state.settings.splashDismissedAt = Date.now();
        saveCustomisation();
        saveSettings();

        if (!state.activeSession) {
          if (!refs.clinicianName.value || refs.clinicianName.value === previousPractitioner) refs.clinicianName.value = practitionerName;
          if ((!refs.consultationOrgName.textContent || refs.consultationOrgName.textContent === previousOrganisation) && organisationName) refs.consultationOrgName.textContent = organisationName;
        }

        renderCustomisationForm();
        renderConsultation();
        renderSettingsForm();
        closeSplashScreen();
      }

      function getSummaryPromptValue() {
        return String(state.settings.summaryPrompt || '').trim() || createDefaultSummaryPrompt();
      }

      function getSummaryHeadingLabel(heading) {
        const labels = {
          subjective: 'Subjective',
          examination: 'Examination',
          assessment: 'Assessment',
          plan: 'Plan'
        };
        return labels[String(heading || '').toLowerCase()] || null;
      }

      function getTranscriptSummarySource(session) {
        if (!session || !Array.isArray(session.transcriptEntries)) return '';
        return session.transcriptEntries
          .map((entry) => entry.isImportantMarker ? '[Important moment]' : normaliseWhitespace(entry.text || ''))
          .filter(Boolean)
          .join('\n');
      }

      function hasSummarisableTranscript(session) {
        return Boolean(normaliseWhitespace(getTranscriptSummarySource(session)));
      }

      function isSessionSummaryStale(session) {
        if (!session || !normaliseWhitespace(session.summary)) return false;
        return (session.summarySignature || '') !== getTranscriptSummarySource(session) || (session.summaryPrompt || '') !== getSummaryPromptValue();
      }

      function getEffectiveSummaryStatus(session) {
        if (!session) return 'idle';
        if (session.summaryStatus === 'generating') return 'generating';
        if (session.summaryStatus === 'error') return 'error';
        if (isSessionSummaryStale(session)) return 'stale';
        if (normaliseWhitespace(session.summary)) return 'ready';
        return 'idle';
      }

      function hasPromptApiSupport() {
        return Boolean(getLanguageModelApi());
      }

      function hasSummarizerSupport() {
        return Boolean(getSummarizerApi());
      }

      function hasAiSummarySupport() {
        return Boolean(hasPromptApiSupport() || hasSummarizerSupport());
      }

      function closeTextSession(session) {
        if (!session) return;
        try {
          if (typeof session.destroy === 'function') session.destroy();
        } catch (_) {}
      }

      function getPromptApiOptions() {
        return {
          expectedOutputLanguage: 'en',
          expectedOutputs: [{ type: 'text', languages: ['en'] }]
        };
      }

      function createEmptySoapSections() {
        return ['Subjective', 'Examination', 'Assessment', 'Plan'].reduce((accumulator, heading) => {
          accumulator[heading] = [];
          return accumulator;
        }, {});
      }

      function buildSoapSummaryFromSections(sections) {
        return ['Subjective', 'Examination', 'Assessment', 'Plan'].map((heading) => {
          const seen = new Set();
          const items = (Array.isArray(sections && sections[heading]) ? sections[heading] : [])
            .map((item) => normaliseWhitespace(String(item || '').replace(/^[-*•]\s*/, '')))
            .filter((item) => item && item.toLowerCase() !== 'not stated')
            .filter((item) => {
              const key = item.toLowerCase();
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
          const finalItems = items.length ? items : ['Not stated'];
          return heading + '\n' + finalItems.map((item) => '- ' + item).join('\n');
        }).join('\n\n');
      }

      function extractSoapSections(summaryText) {
        const parsedSections = parseStructuredSummary(summaryText);
        if (parsedSections) return parsedSections;

        const sections = createEmptySoapSections();
        String(summaryText || '')
          .replace(/\r/g, '')
          .split('\n')
          .map((line) => normaliseWhitespace(line.replace(/^[-*•]\s*/, '')))
          .filter(Boolean)
          .forEach((line) => {
            if (/(?:\bexam\b|\bexamination\b|\bobserved\b|\bvitals?\b|\bbp\b|\bpulse\b|\btemp(?:erature)?\b|\bo\/e\b)/i.test(line)) {
              sections.Examination.push(line);
              return;
            }
            if (/(?:\bassessment\b|\bdiagnos(?:is|es)\b|\bimpression\b|\blikely\b|\bconsistent with\b)/i.test(line)) {
              sections.Assessment.push(line);
              return;
            }
            if (/(?:\bplan\b|\bfollow-up\b|\bfollow up\b|\breview\b|\bmonitor\b|\bprescrib(?:e|ed|ing)\b|\bstart\b|\bcontinue\b|\bcease\b|\brefer(?:ral|red)?\b|\binvestigations?\b|\breturn\b|\bseek urgent\b|\bsafety-net\b)/i.test(line)) {
              sections.Plan.push(line);
              return;
            }
            if (/(?:\bsymptom\b|\bhistory\b|\breports?\b|\bcomplains?\b|\bdenies\b|\bpain\b|\bcough\b|\bfever\b|\bnausea\b|\bvomit(?:ing)?\b)/i.test(line)) {
              sections.Subjective.push(line);
              return;
            }
            sections.Subjective.push(line);
          });

        return sections;
      }

      function normalizeSoapSummary(summaryText) {
        return buildSoapSummaryFromSections(extractSoapSections(summaryText));
      }

      function estimateTranscriptTooLarge(text, maxChars = 6000) {
        return String(text || '').length > maxChars;
      }

      function splitTranscriptIntoChunks(transcriptSource, maxChunkChars = 6000, overlapChars = 500) {
        const source = String(transcriptSource || '').replace(/\r/g, '').trim();
        if (!source) return [];
        if (!estimateTranscriptTooLarge(source, maxChunkChars)) return [source];

        const chunks = [];
        const safeOverlap = clamp(Number(overlapChars) || 0, 0, Math.max(0, Math.floor(maxChunkChars / 3)));
        let start = 0;

        while (start < source.length) {
          let end = Math.min(source.length, start + maxChunkChars);
          if (end < source.length) {
            const minimumBoundary = start + Math.max(1200, Math.floor(maxChunkChars * 0.6));
            const boundaries = [source.lastIndexOf('\n\n', end), source.lastIndexOf('\n', end), source.lastIndexOf('. ', end), source.lastIndexOf(' ', end)];
            const preferredBoundary = boundaries.find((index) => index >= minimumBoundary);
            if (preferredBoundary >= minimumBoundary) {
              end = preferredBoundary;
              if (source.slice(end, end + 2) === '\n\n') end += 2;
              else if (source.charAt(end) === '\n' || source.charAt(end) === ' ') end += 1;
              else if (source.slice(end, end + 2) === '. ') end += 1;
            } else {
              while (end > minimumBoundary && /\S/.test(source.charAt(end - 1)) && /\S/.test(source.charAt(end))) end -= 1;
            }
          }

          const chunk = source.slice(start, end).trim();
          if (chunk) chunks.push(chunk);
          if (end >= source.length) break;

          start = Math.max(0, end - safeOverlap);
          while (start > 0 && /\S/.test(source.charAt(start - 1)) && /\S/.test(source.charAt(start))) start -= 1;
          if (chunk && start >= end) start = end;
        }

        return chunks.length ? chunks : [source];
      }

      function buildSummaryPrompt(promptTemplate, transcriptSource) {
        return promptTemplate + '\n\nConsultation transcript:\n' + transcriptSource;
      }

      function buildChunkSummaryPrompt(promptTemplate, transcriptChunk, chunkIndex, chunkCount) {
        return [
          promptTemplate,
          '',
          'This is chunk ' + String(chunkIndex + 1) + ' of ' + String(chunkCount) + ' from one longer consultation transcript.',
          'Produce a concise partial SOAP summary for this chunk only.',
          'Use the headings Subjective, Examination, Assessment and Plan.',
          'If a heading has no supporting information in this chunk, write "- Not stated" under that heading.',
          'Do not invent facts. Keep clinically relevant negatives when present.',
          '',
          'Consultation transcript chunk:',
          transcriptChunk
        ].join('\n');
      }

      function buildSummaryMergePrompt(promptTemplate, partialSummaries) {
        return [
          promptTemplate,
          '',
          'The following are partial SOAP summaries from consecutive transcript chunks.',
          'Merge them into one concise clinical SOAP summary.',
          'Deduplicate repeated facts, preserve medically relevant details, and do not invent facts.',
          'Use the headings Subjective, Examination, Assessment and Plan.',
          'If a heading has no information, write "- Not stated".',
          '',
          partialSummaries.map((summary, index) => 'Chunk summary ' + String(index + 1) + ':\n' + String(summary || '').trim()).join('\n\n')
        ].join('\n');
      }

      async function promptWithLanguageModel(promptText) {
        let sessionHandle = null;
        try {
          const languageModelApi = getLanguageModelApi();
          if (!languageModelApi) throw new Error('Prompt API is not available in this browser.');
          sessionHandle = await languageModelApi.create(getPromptApiOptions());
          const result = await sessionHandle.prompt(promptText);
          const summaryText = String(result || '').trim();
          if (!summaryText) throw new Error('The browser returned an empty summary.');
          return summaryText;
        } finally {
          closeTextSession(sessionHandle);
        }
      }

      async function summarizeWithPromptApi(text, promptTemplate) {
        return promptWithLanguageModel(buildSummaryPrompt(promptTemplate, text));
      }

      async function summarizeWithSummarizer(text) {
        let sessionHandle = null;
        try {
          const summarizerApi = getSummarizerApi();
          if (!summarizerApi) throw new Error('Summarizer API is not available in this browser.');
          sessionHandle = await summarizerApi.create({
            type: 'key-points',
            format: 'markdown',
            length: 'medium'
          });
          const result = await sessionHandle.summarize(text);
          const summaryText = String(result || '').trim();
          if (!summaryText) throw new Error('The browser returned an empty summary.');
          return summaryText;
        } finally {
          closeTextSession(sessionHandle);
        }
      }

      async function summarizeChunkedWithPromptApi(transcriptSource, promptTemplate) {
        const chunks = splitTranscriptIntoChunks(transcriptSource);
        if (!chunks.length) return '';
        if (chunks.length === 1) return normalizeSoapSummary(await summarizeWithPromptApi(chunks[0], promptTemplate));

        const partialSummaries = [];
        for (let index = 0; index < chunks.length; index += 1) {
          partialSummaries.push(await promptWithLanguageModel(buildChunkSummaryPrompt(promptTemplate, chunks[index], index, chunks.length)));
        }

        const mergedSummary = await promptWithLanguageModel(buildSummaryMergePrompt(promptTemplate, partialSummaries));
        return normalizeSoapSummary(mergedSummary);
      }

      async function summarizeChunkedWithSummarizer(transcriptSource, promptTemplate) {
        const chunks = splitTranscriptIntoChunks(transcriptSource);
        if (!chunks.length) return '';
        if (chunks.length === 1) return normalizeSoapSummary(await summarizeWithSummarizer(chunks[0]));

        const partialSummaries = [];
        for (let index = 0; index < chunks.length; index += 1) {
          partialSummaries.push(await summarizeWithSummarizer(chunks[index]));
        }

        return normalizeSoapSummary(partialSummaries.join('\n\n'));
      }

      async function buildChunkedSummary(session, promptTemplate) {
        const transcriptSource = getTranscriptSummarySource(session);
        if (!normaliseWhitespace(transcriptSource)) return '';

        if (hasPromptApiSupport()) {
          const availability = await getPromptApiAvailability();
          if (availability === 'available') return summarizeChunkedWithPromptApi(transcriptSource, promptTemplate);
          if (!hasSummarizerSupport()) throw new Error('Language model is not available: ' + availability);
        }

        if (hasSummarizerSupport()) return summarizeChunkedWithSummarizer(transcriptSource, promptTemplate);
        throw new Error('On-device AI summarisation is unavailable in this browser.');
      }

      function renderSummaryViewsForSession(sessionId) {
        if (state.activeSession && state.activeSession.id === sessionId) renderConsultationSummary();
        if (state.currentTab === 'history' && state.historySelectedSessionId === sessionId) renderHistoryDetail();
      }

      function applyGeneratedSummary(sessionId, requestToken, summaryText, promptTemplate, transcriptSource, options = {}) {
        if (state.summaryRequestTokens[sessionId] !== requestToken) return null;
        const refreshedSession = findSession(sessionId);
        if (!refreshedSession) return null;

        refreshedSession.summary = summaryText;
        refreshedSession.summaryStatus = 'ready';
        refreshedSession.summaryUpdatedAt = Date.now();
        refreshedSession.summaryError = '';
        refreshedSession.summaryPrompt = promptTemplate;
        refreshedSession.summarySignature = transcriptSource;
        refreshedSession.updatedAt = Date.now();
        appendAuditEvent(
          refreshedSession,
          'summary-generated',
          'Summary generated.',
          {
            summaryCharacters: String(summaryText || '').length,
            transcriptCharacters: String(transcriptSource || '').length
          },
          options.actor === 'user' ? 'user' : 'system'
        );
        upsertSession(refreshedSession);
        persistSessions();
        renderSummaryViewsForSession(refreshedSession.id);
        if (refreshedSession.structuredDataStatus === 'idle' && !hasStructuredDataContent(refreshedSession.structuredData)) {
          void refreshSessionStructuredData(refreshedSession.id, { force: true, showFeedback: false, auditActor: 'system', auditSource: 'auto-summary' });
        }
        return refreshedSession;
      }

      function applySummaryGenerationError(sessionId, requestToken, error) {
        if (state.summaryRequestTokens[sessionId] !== requestToken) return null;
        const refreshedSession = findSession(sessionId);
        if (!refreshedSession) return null;

        const detail = normaliseWhitespace(error && error.message ? error.message : String(error || ''));
        refreshedSession.summaryStatus = 'error';
        refreshedSession.summaryError = detail ? ('On-device summary generation failed: ' + detail) : 'On-device summary generation failed in this browser.';
        refreshedSession.updatedAt = Date.now();
        upsertSession(refreshedSession);
        persistSessions();
        renderSummaryViewsForSession(refreshedSession.id);
        return refreshedSession;
      }

      function parseStructuredSummary(summaryText) {
        const headings = ['Subjective', 'Examination', 'Assessment', 'Plan'];
        const sections = headings.reduce((accumulator, heading) => {
          accumulator[heading] = [];
          return accumulator;
        }, {});
        let currentHeading = null;
        let foundHeading = false;

        String(summaryText || '')
          .replace(/\r/g, '')
          .split('\n')
          .forEach((line) => {
            const trimmed = line.trim();
            if (!trimmed) return;
            const cleaned = trimmed
              .replace(/^#+\s*/, '')
              .replace(/^\*\*(.*?)\*\*$/, '$1')
              .replace(/^__(.*?)__$/, '$1');
            const headingMatch = cleaned.match(/^(?:[-*•]\s*)?(Subjective|Examination|Assessment|Plan)\s*:?\s*(.*)$/i);
            if (headingMatch) {
              currentHeading = getSummaryHeadingLabel(headingMatch[1]);
              foundHeading = Boolean(currentHeading);
              if (currentHeading && headingMatch[2]) sections[currentHeading].push(headingMatch[2].trim());
              return;
            }
            const bulletMatch = cleaned.match(/^[-*•]\s+(.+)$/);
            if (bulletMatch && currentHeading) {
              sections[currentHeading].push(bulletMatch[1].trim());
              return;
            }
            if (currentHeading) sections[currentHeading].push(cleaned);
          });

        return foundHeading ? sections : null;
      }

      function buildSummaryMarkup(summaryText) {
        const sections = parseStructuredSummary(summaryText);
        if (!sections) return '<div class="summary-plaintext">' + escapeHtml(summaryText || '').replace(/\n/g, '<br>') + '</div>';
        return ['Subjective', 'Examination', 'Assessment', 'Plan'].map((heading) => {
          const items = sections[heading] && sections[heading].length ? sections[heading] : ['Not stated'];
          return '<section class="summary-section"><h4>' + heading + '</h4><ul class="summary-list">' + items.map((item) => '<li>' + escapeHtml(item) + '</li>').join('') + '</ul></section>';
        }).join('');
      }

      function getSummaryMetaText(session) {
        if (!session) return 'Generated after stopping the session using on-device AI.';
        const status = getEffectiveSummaryStatus(session);
        if (!hasAiSummarySupport()) return 'On-device AI summarisation is unavailable in this browser.';
        if (!hasSummarisableTranscript(session)) return 'Stop a consultation with transcript content to generate a summary.';
        if (status === 'generating') return 'Generating summary with on-device browser AI.';
        if (status === 'error') return session.summaryError || 'Summary generation failed.';
        if (status === 'stale') return 'Transcript or prompt changed since the last summary was generated.';
        if (session.summaryUpdatedAt) return 'Generated ' + formatDateTime(session.summaryUpdatedAt) + ' using the current saved prompt.';
        return 'Generated after stopping the session using on-device AI.';
      }

      function buildSummaryPanelHtml(session) {
        if (!session) return '<div class="empty-state small">Start or open a session to generate an AI summary from its transcript.</div>';
        if (!hasAiSummarySupport()) return '<div class="empty-state small">This browser does not currently expose the Prompt API or Summarizer API, so summaries cannot be generated here.</div>';
        if (!hasSummarisableTranscript(session)) return '<div class="empty-state small">No transcript content is available yet. Stop a consultation after dictation to generate the summary.</div>';

        const status = getEffectiveSummaryStatus(session);
        if (status === 'generating') return '<div class="summary-status generating">Generating summary with on-device AI. This usually completes a few moments after you stop the session.</div>';
        if (status === 'error') return '<div class="summary-status error">' + escapeHtml(session.summaryError || 'Summary generation failed. Try again.') + '</div>';
        if (!normaliseWhitespace(session.summary)) return '<div class="empty-state small">The summary will be generated automatically when the session stops. You can also run it manually.</div>';

        return '<div class="summary-grid">' + buildSummaryMarkup(session.summary) + '</div>';
      }

      function updateSummaryButton(button, session) {
        if (!button) return;
        const status = getEffectiveSummaryStatus(session);
        button.disabled = !session || !hasAiSummarySupport() || !hasSummarisableTranscript(session) || status === 'generating';
        button.textContent = normaliseWhitespace(session ? session.summary : '') ? 'Regenerate Summary' : 'Generate Summary';
      }

      function renderConsultationSummary() {
        if (isSessionUiLocked()) {
          refs.consultationSummaryCard.classList.remove('hidden');
          refs.consultationSummaryMeta.textContent = 'Unlock the app to view or generate AI summaries for this session.';
          refs.consultationSummary.innerHTML = renderLockedPlaceholder(getSessionLockPlaceholderText('summary output'));
          refs.generateSummaryBtn.disabled = true;
          return;
        }
        const session = state.activeSession;
        const canShow = canGenerateDocumentsForSession(session);
        refs.consultationSummaryCard.classList.toggle('hidden', !canShow);
        refs.consultationSummaryMeta.textContent = getSummaryMetaText(session);
        refs.consultationSummary.innerHTML = buildSummaryPanelHtml(session);
        updateSummaryButton(refs.generateSummaryBtn, session);
      }

      function renderStructuredViewsForSession(sessionId) {
        if (state.activeSession && state.activeSession.id === sessionId) renderConsultationStructuredView();
        if (state.activeSession && state.activeSession.id === sessionId) renderConsultationReviewMode();
        if (state.currentTab === 'history' && state.historySelectedSessionId === sessionId) renderHistoryDetail();
      }

      function getStructuredDataStatusText(session) {
        if (!session) return 'Extract clinically useful buckets from notes, summary, and transcript.';
        if (session.structuredDataStatus === 'generating') return 'Extracting structured items from manual notes, AI summary, and transcript.';
        if (session.structuredDataStatus === 'error') return session.structuredDataError || 'Structured extraction failed.';
        if (session.structuredDataStatus === 'ready') {
          return hasStructuredDataContent(session.structuredData)
            ? ('Updated ' + formatDateTime(session.structuredDataUpdatedAt || session.updatedAt) + ' from manual notes, AI summary, and transcript.')
            : 'No structured items were confidently extracted. You can still add or edit them manually in History.';
        }
        return 'Run extraction to build conservative problem, medication, investigation, follow-up, and admin buckets from this session.';
      }

      function buildStructuredDataViewHtml(session, options = {}) {
        const editable = Boolean(options.editable);
        const data = normalizeStructuredData(session && session.structuredData);
        const showEmptySections = options.showEmptySections !== false;
        const sections = STRUCTURED_DATA_FIELDS
          .map((field) => {
            const items = data[field.key];
            if (!editable && !showEmptySections && !items.length) return '';
            return '<section class="structured-section">' +
              '<div class="structured-section-head"><h4>' + escapeHtml(field.label) + '</h4></div>' +
              (editable
                ? '<textarea class="structured-editor" data-structured-field="' + escapeAttribute(field.key) + '" rows="4" placeholder="' + escapeAttribute(field.placeholder) + '">' + escapeHtml(items.join('\n')) + '</textarea><div class="subtle-note">One item per line. Remove lines to clear items.</div>'
                : (items.length
                  ? '<ul class="summary-list">' + items.map((item) => '<li>' + escapeHtml(item) + '</li>').join('') + '</ul>'
                  : '<div class="structured-empty">Not stated</div>')) +
              '</section>';
          })
          .filter(Boolean);
        if (!sections.length) return '<div class="empty-state small">No structured items are available for this session yet.</div>';
        return '<div class="structured-grid">' + sections.join('') + '</div>';
      }

      async function refreshSessionStructuredData(sessionId, options = {}) {
        const session = findSession(sessionId);
        if (!session) return null;
        const force = Boolean(options.force);
        const showFeedback = options.showFeedback !== false;
        const auditActor = options.auditActor === 'user' || options.auditActor === 'system'
          ? options.auditActor
          : (showFeedback ? 'user' : 'system');
        const auditSource = options.auditSource || 'manual';
        if (session.structuredDataStatus === 'generating') return session;
        if (!force && session.structuredDataStatus === 'ready' && hasStructuredDataContent(session.structuredData)) return session;

        session.structuredDataStatus = 'generating';
        session.structuredDataError = '';
        session.updatedAt = Date.now();
        upsertSession(session);
        persistSessionsDebounced();
        renderStructuredViewsForSession(session.id);

        try {
          await Promise.resolve();
          const extracted = extractStructuredDataFromSession(session);
          const refreshedSession = findSession(session.id);
          if (!refreshedSession) return null;
          refreshedSession.structuredData = extracted;
          refreshedSession.structuredDataUpdatedAt = Date.now();
          refreshedSession.structuredDataStatus = 'ready';
          refreshedSession.structuredDataError = '';
          refreshedSession.updatedAt = Date.now();
          const totalItems = STRUCTURED_DATA_FIELDS.reduce((count, field) => count + (Array.isArray(extracted[field.key]) ? extracted[field.key].length : 0), 0);
          appendAuditEvent(
            refreshedSession,
            'structured-extraction-run',
            totalItems > 0 ? 'Structured extraction completed.' : 'Structured extraction completed with no confidently extracted items.',
            { source: auditSource, totalItems },
            auditActor
          );
          upsertSession(refreshedSession);
          persistSessionsDebounced();
          renderStructuredViewsForSession(refreshedSession.id);
          if (showFeedback) showToast(hasStructuredDataContent(extracted) ? 'Structured items extracted.' : 'No structured items were confidently extracted.', hasStructuredDataContent(extracted) ? 'success' : 'info', 2600);
          return refreshedSession;
        } catch (error) {
          const refreshedSession = findSession(session.id);
          if (!refreshedSession) return null;
          refreshedSession.structuredDataStatus = 'error';
          refreshedSession.structuredDataError = 'Structured extraction failed: ' + normaliseWhitespace(error && error.message ? error.message : String(error || 'Unknown error'));
          refreshedSession.updatedAt = Date.now();
          appendAuditEvent(
            refreshedSession,
            'structured-extraction-run',
            'Structured extraction failed.',
            { source: auditSource },
            auditActor
          );
          upsertSession(refreshedSession);
          persistSessionsDebounced();
          renderStructuredViewsForSession(refreshedSession.id);
          if (showFeedback) showToast('Structured extraction failed.', 'error', 3600);
          return refreshedSession;
        }
      }

      function renderConsultationStructuredView() {
        if (isSessionUiLocked()) {
          refs.consultationStructuredCard.classList.remove('hidden');
          refs.consultationStructuredMeta.textContent = 'Unlock the app to review extracted structured items.';
          refs.extractStructuredBtn.disabled = true;
          refs.extractStructuredBtn.textContent = 'Extract structured items';
          refs.consultationStructuredContainer.innerHTML = renderLockedPlaceholder(getSessionLockPlaceholderText('structured session items'));
          return;
        }
        const session = state.activeSession;
        refs.consultationStructuredCard.classList.toggle('hidden', !session);
        if (!session) return;
        refs.extractStructuredBtn.disabled = session.structuredDataStatus === 'generating';
        refs.extractStructuredBtn.textContent = session.structuredDataStatus === 'generating' ? 'Extracting...' : 'Extract structured items';
        refs.consultationStructuredMeta.textContent = getStructuredDataStatusText(session);
        refs.consultationStructuredContainer.innerHTML = buildStructuredDataViewHtml(session, { editable: false, showEmptySections: true });
      }

      function getTranscriptEntryConfidenceBand(entry) {
        if (!entry || entry.isImportantMarker || typeof entry.confidence !== 'number') return 'unknown';
        if (entry.confidence >= 0.85) return 'high';
        if (entry.confidence >= 0.65) return 'medium';
        return 'low';
      }

      function getTranscriptEntryConfidenceLabel(entry) {
        const band = getTranscriptEntryConfidenceBand(entry);
        if (band === 'high') return 'High confidence';
        if (band === 'medium') return 'Medium confidence';
        if (band === 'low') return 'Low confidence';
        return 'Confidence unavailable';
      }

      function isLowConfidenceTranscriptEntry(entry) {
        return getTranscriptEntryConfidenceBand(entry) === 'low';
      }

      function getLowConfidenceTranscriptEntries(session) {
        return (Array.isArray(session && session.transcriptEntries) ? session.transcriptEntries : []).filter((entry) => !entry.isImportantMarker && isLowConfidenceTranscriptEntry(entry));
      }

      function hasLowConfidenceTranscriptEntries(session) {
        return getLowConfidenceTranscriptEntries(session).length > 0;
      }

      function getTranscriptLastUpdatedAt(session) {
        return (Array.isArray(session && session.transcriptEntries) ? session.transcriptEntries : []).reduce((latest, entry) => Math.max(latest, entry.lastUpdatedAt || entry.timestamp || 0), 0);
      }

      function getReviewSourceUpdatedAt(session) {
        return Math.max(getTranscriptLastUpdatedAt(session), Number(session && session.manualNotesUpdatedAt) || 0);
      }

      function isDocumentReviewStale(session, documentItem) {
        if (!session || !documentItem) return false;
        return getReviewSourceUpdatedAt(session) > Number(documentItem.updatedAt || 0);
      }

      function hasStaleReviewDocuments(session) {
        return (Array.isArray(session && session.documents) ? session.documents : []).some((documentItem) => isDocumentReviewStale(session, documentItem));
      }

      function hasSummaryNeedsReview(session) {
        return Boolean(session && normaliseWhitespace(session.summary) && hasLowConfidenceTranscriptEntries(session));
      }

      function hasStructuredDataStaleBadge(session) {
        return Boolean(session && hasStructuredDataContent(session.structuredData) && isSessionSummaryStale(session));
      }

      function getStructuredFieldExtractor(fieldKey) {
        const extractorMap = {
          problems: extractProblemsFromText,
          medications: extractMedicationsFromText,
          allergies: extractAllergiesFromText,
          investigations: extractInvestigationsFromText,
          followUpActions: extractFollowUpActionsFromText,
          diagnoses: extractDiagnosesFromText,
          safetyNetting: extractSafetyNettingFromText,
          adminTasks: extractAdminTasksFromText
        };
        return extractorMap[fieldKey] || (() => []);
      }

      function itemMatchesSource(item, sourceText, extractor) {
        const normalizedItem = normaliseWhitespace(String(item || '')).toLowerCase();
        if (!normalizedItem || !normaliseWhitespace(sourceText)) return false;
        const extractedItems = normalizeStructuredDataItems(extractor(sourceText)).map((value) => value.toLowerCase());
        if (extractedItems.includes(normalizedItem)) return true;
        return normaliseWhitespace(sourceText).toLowerCase().includes(normalizedItem);
      }

      function getStructuredItemSourceLabels(session, fieldKey, item) {
        const extractor = getStructuredFieldExtractor(fieldKey);
        const labels = [];
        if (itemMatchesSource(item, session && session.manualNotes, extractor)) labels.push('User-entered note');
        if (itemMatchesSource(item, session && session.summary, extractor)) labels.push('AI-generated summary');
        if (itemMatchesSource(item, getTranscriptSummarySource(session), extractor)) labels.push('Transcript-derived');
        return labels.length ? labels : ['Structured extraction'];
      }

      function buildReviewBadge(text, tone = 'neutral') {
        return '<span class="review-badge ' + escapeAttribute(tone) + '">' + escapeHtml(text) + '</span>';
      }

      function buildReviewProvenanceLabels(labels) {
        return (Array.isArray(labels) ? labels : []).map((label) => buildReviewBadge(label, 'provenance')).join('');
      }

      function focusTranscriptEntryInContainer(container, entryId) {
        if (!container || !entryId) return;
        const entry = Array.from(container.querySelectorAll('[data-transcript-entry-id]')).find((item) => item.dataset.transcriptEntryId === entryId);
        if (!entry) return;
        entry.classList.add('review-focus');
        entry.scrollIntoView({ block: 'center', behavior: 'smooth' });
        const textNode = entry.querySelector('.transcript-text');
        if (textNode && textNode.getAttribute('contenteditable') === 'true') textNode.focus();
        window.setTimeout(() => { entry.classList.remove('review-focus'); }, 2200);
      }

      function focusTranscriptEntry(session, entryId, context = 'consultation') {
        if (!session || !entryId) return;
        if (context === 'history') {
          state.historyDetailSearch = '';
          renderHistoryDetail();
          window.requestAnimationFrame(() => {
            focusTranscriptEntryInContainer(refs.historyDetail.querySelector('#historyTranscriptContainer'), entryId);
          });
          return;
        }
        state.transcriptSearch = '';
        refs.transcriptSearch.value = '';
        renderConsultationTranscript();
        renderSessionHint();
        window.requestAnimationFrame(() => {
          focusTranscriptEntryInContainer(refs.transcriptContainer, entryId);
        });
      }

      function applyReviewTranscriptSearch(session, query, context = 'consultation') {
        if (!session) return;
        const searchText = normaliseWhitespace(query);
        if (!searchText) return;
        if (context === 'history') {
          state.historyDetailSearch = searchText;
          renderHistoryDetail();
          window.requestAnimationFrame(() => {
            const firstMatch = refs.historyDetail.querySelector('[data-transcript-entry-id]');
            if (firstMatch) focusTranscriptEntryInContainer(refs.historyDetail.querySelector('#historyTranscriptContainer'), firstMatch.dataset.transcriptEntryId);
          });
          return;
        }
        state.transcriptSearch = searchText;
        refs.transcriptSearch.value = searchText;
        renderConsultationTranscript();
        renderSessionHint();
        window.requestAnimationFrame(() => {
          const firstMatch = refs.transcriptContainer.querySelector('[data-transcript-entry-id]');
          if (firstMatch) focusTranscriptEntryInContainer(refs.transcriptContainer, firstMatch.dataset.transcriptEntryId);
        });
      }

      function getReviewTranscriptEntries(session, onlyLowConfidence) {
        const entries = Array.isArray(session && session.transcriptEntries) ? session.transcriptEntries.filter((entry) => !entry.isImportantMarker) : [];
        if (onlyLowConfidence) return entries.filter((entry) => isLowConfidenceTranscriptEntry(entry));
        return entries.slice(-8);
      }

      function getReviewModeMetaText(session) {
        if (!session) return 'Review transcript confidence, generated content, and stale outputs before finalising the note.';
        const lowConfidenceCount = getLowConfidenceTranscriptEntries(session).length;
        const staleParts = [];
        if (isSessionSummaryStale(session)) staleParts.push('summary stale');
        if (hasStructuredDataStaleBadge(session)) staleParts.push('structured data stale');
        if (hasStaleReviewDocuments(session)) staleParts.push('document stale');
        const notes = [];
        if (lowConfidenceCount) notes.push(String(lowConfidenceCount) + ' low-confidence transcript block' + (lowConfidenceCount === 1 ? '' : 's'));
        if (staleParts.length) notes.push(staleParts.join(', '));
        return notes.length ? notes.join(' • ') : 'No review warnings are currently flagged for this stopped session.';
      }

      function buildReviewTranscriptSectionHtml(session, context) {
        const onlyLowConfidence = context === 'history' ? state.reviewMode.historyLowConfidenceOnly : state.reviewMode.consultationLowConfidenceOnly;
        const entries = getReviewTranscriptEntries(session, onlyLowConfidence);
        const lowConfidenceCount = getLowConfidenceTranscriptEntries(session).length;
        return '<section class="review-section">' +
          '<div class="review-section-header"><div><h4>Transcript</h4><div class="review-badges">' + buildReviewProvenanceLabels(['Transcript-derived']) + (lowConfidenceCount ? buildReviewBadge(String(lowConfidenceCount) + ' low-confidence', 'warning') : '') + '</div></div></div>' +
          (entries.length
            ? '<div class="review-entry-list">' + entries.map((entry) => '<button type="button" class="review-entry-button ' + escapeAttribute(getTranscriptEntryConfidenceBand(entry)) + '" data-review-entry-id="' + escapeAttribute(entry.id) + '" data-review-context="' + escapeAttribute(context) + '"><div class="review-entry-head"><span>' + escapeHtml(formatClock(entry.timestamp)) + '</span><span class="review-entry-confidence ' + escapeAttribute(getTranscriptEntryConfidenceBand(entry)) + '">' + escapeHtml(getTranscriptEntryConfidenceLabel(entry)) + '</span></div><div class="review-entry-text">' + escapeHtml(String(entry.text || '').slice(0, 220) || 'Transcript segment') + '</div></button>').join('') + '</div>'
            : '<div class="empty-state small">' + escapeHtml(onlyLowConfidence ? 'No low-confidence transcript blocks were found for this session.' : 'No transcript entries are available for review.') + '</div>') +
          '</section>';
      }

      function buildReviewSummarySectionHtml(session) {
        const badges = [buildReviewBadge('AI-generated summary', 'provenance')];
        if (hasSummaryNeedsReview(session)) badges.push(buildReviewBadge('Needs review', 'warning'));
        if (isSessionSummaryStale(session)) badges.push(buildReviewBadge('Stale', 'stale'));
        return '<section class="review-section">' +
          '<div class="review-section-header"><div><h4>AI Summary</h4><div class="review-badges">' + badges.join('') + '</div></div><div class="inline-actions"><button class="btn small" type="button" data-review-action="regenerate-summary">' + escapeHtml(normaliseWhitespace(session && session.summary) ? 'Regenerate Summary' : 'Generate Summary') + '</button></div></div>' +
          '<div class="review-section-body">' + buildSummaryPanelHtml(session) + '</div>' +
          '</section>';
      }

      function buildReviewStructuredSectionHtml(session, context) {
        const data = normalizeStructuredData(session && session.structuredData);
        const badges = [buildReviewBadge('Structured extraction', 'provenance')];
        if (hasStructuredDataStaleBadge(session)) badges.push(buildReviewBadge('Stale', 'stale'));
        const groups = STRUCTURED_DATA_FIELDS
          .filter((field) => data[field.key].length)
          .map((field) => '<div class="review-structured-group"><h5>' + escapeHtml(field.label) + '</h5><div class="review-structured-items">' + data[field.key].map((item) => '<button type="button" class="review-structured-item" data-review-query="' + escapeAttribute(item) + '" data-review-context="' + escapeAttribute(context) + '"><span class="review-structured-item-text">' + escapeHtml(item) + '</span><span class="review-badges">' + buildReviewProvenanceLabels(getStructuredItemSourceLabels(session, field.key, item)) + '</span></button>').join('') + '</div></div>').join('');
        return '<section class="review-section">' +
          '<div class="review-section-header"><div><h4>Structured Items</h4><div class="review-badges">' + badges.join('') + '</div></div><div class="inline-actions"><button class="btn small" type="button" data-review-action="extract-structured">Extract structured items</button></div></div>' +
          (groups ? '<div class="review-section-body">' + groups + '</div>' : '<div class="empty-state small">No structured items are available for review yet.</div>') +
          '</section>';
      }

      function buildReviewDocumentsSectionHtml(session) {
        const documents = Array.isArray(session && session.documents) ? session.documents.slice().sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0)) : [];
        const badges = [buildReviewBadge('AI-generated document', 'provenance')];
        if (hasStaleReviewDocuments(session)) badges.push(buildReviewBadge('Stale output', 'stale'));
        return '<section class="review-section">' +
          '<div class="review-section-header"><div><h4>Generated Documents</h4><div class="review-badges">' + badges.join('') + '</div></div></div>' +
          (documents.length
            ? '<div class="review-document-list">' + documents.map((documentItem) => '<div class="review-document-card"><div class="review-document-head"><strong>' + escapeHtml(documentItem.title || documentItem.templateName || 'Document') + '</strong><div class="review-badges">' + (isDocumentReviewStale(session, documentItem) ? buildReviewBadge('Stale', 'stale') : '') + '</div></div><p>' + escapeHtml(getDocumentPreviewText(documentItem).slice(0, 220) || 'Generated document preview') + '</p><div class="inline-actions"><button class="btn small" type="button" data-review-action="open-document" data-review-document-id="' + escapeAttribute(documentItem.id) + '">Open document</button>' + (documentItem.templateId ? '<button class="btn small" type="button" data-review-action="regenerate-document" data-review-template-id="' + escapeAttribute(documentItem.templateId) + '">Regenerate</button>' : '') + '</div></div>').join('') + '</div>'
            : '<div class="empty-state small">No generated documents are available for review yet.</div>') +
          '</section>';
      }

      function buildReviewModePanelHtml(session, context = 'consultation') {
        if (!session) return '<div class="empty-state small">Stop or open a session to review its transcript, summary, structured items, and generated documents.</div>';
        return '<div class="review-grid">' +
          buildReviewTranscriptSectionHtml(session, context) +
          buildReviewSummarySectionHtml(session) +
          buildReviewStructuredSectionHtml(session, context) +
          buildReviewDocumentsSectionHtml(session) +
          '</div>';
      }

      function renderConsultationReviewMode() {
        if (isSessionUiLocked()) {
          refs.consultationReviewCard.classList.remove('hidden');
          refs.consultationReviewMeta.textContent = 'Unlock the app to review generated and extracted outputs.';
          refs.consultationReviewLowConfidenceToggle.disabled = true;
          refs.consultationReviewLowConfidenceToggle.textContent = 'Show low-confidence only';
          refs.consultationReviewContainer.innerHTML = renderLockedPlaceholder(getSessionLockPlaceholderText('review mode'));
          return;
        }
        const session = state.activeSession;
        const canShow = Boolean(session && session.status === 'stopped');
        refs.consultationReviewCard.classList.toggle('hidden', !canShow);
        if (!canShow) return;
        refs.consultationReviewMeta.textContent = getReviewModeMetaText(session);
        refs.consultationReviewLowConfidenceToggle.disabled = false;
        refs.consultationReviewLowConfidenceToggle.textContent = state.reviewMode.consultationLowConfidenceOnly ? 'Show all transcript blocks' : 'Show low-confidence only';
        refs.consultationReviewContainer.innerHTML = buildReviewModePanelHtml(session, 'consultation');
      }

      function getDocumentTemplates() {
        return Array.isArray(state.customisation.documentTemplates) ? state.customisation.documentTemplates : [];
      }

      function findDocumentTemplate(templateId) {
        return getDocumentTemplates().find((template) => template.id === templateId) || null;
      }

      function canGenerateDocumentsForSession(session) {
        return Boolean(session && session.status === 'stopped' && hasSummarisableTranscript(session));
      }

      function getDocumentTargetSession() {
        const selectedHistorySession = getSelectedHistorySession();
        const activeSession = canGenerateDocumentsForSession(state.activeSession) ? state.activeSession : null;
        const historySession = canGenerateDocumentsForSession(selectedHistorySession) ? selectedHistorySession : null;
        if (state.currentTab === 'history' || state.currentTab === 'documents') return historySession || activeSession;
        return activeSession || historySession;
      }

      function getSelectedSessionDocument(session) {
        if (!session || !Array.isArray(session.documents) || !session.documents.length) return null;
        return session.documents.find((documentItem) => documentItem.id === state.selectedDocumentId) || session.documents[0] || null;
      }

      function getDocumentPreviewText(documentItem) {
        return String(documentItem && documentItem.content ? documentItem.content : '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      }

      function ensureSelectedDocument(session) {
        const selectedDocument = getSelectedSessionDocument(session);
        state.selectedDocumentId = selectedDocument ? selectedDocument.id : null;
      }

      function setSelectedDocument(documentId) {
        state.selectedDocumentId = documentId || null;
      }

      function sanitizeRichTextMarkup(markup) {
        const parser = new window.DOMParser();
        const parsed = parser.parseFromString(String(markup || ''), 'text/html');

        const sanitizeNode = (node) => {
          if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent || '');
          if (node.nodeType !== Node.ELEMENT_NODE) return document.createDocumentFragment();
          if (node.namespaceURI !== HTML_NAMESPACE) return document.createDocumentFragment();

          const tagName = String(node.tagName || '').toUpperCase();
          if (STRIP_CONTENT_TAGS.has(tagName)) return document.createDocumentFragment();

          if (!ALLOWED_DOCUMENT_TAGS.has(tagName)) {
            const fragment = document.createDocumentFragment();
            Array.from(node.childNodes).forEach((childNode) => fragment.appendChild(sanitizeNode(childNode)));
            return fragment;
          }

          const element = document.createElement(tagName.toLowerCase());
          if (tagName === 'A') {
            const href = getSafeDocumentHref(node.getAttribute('href'));
            if (href) {
              element.setAttribute('href', href);
              element.setAttribute('target', '_blank');
              element.setAttribute('rel', 'noopener noreferrer');
            }
          }
          if (tagName === 'TH') {
            const scope = String(node.getAttribute('scope') || '').toLowerCase();
            if (scope === 'row' || scope === 'col') element.setAttribute('scope', scope);
          }
          if (tagName === 'TD' || tagName === 'TH') {
            const colspan = getSanitizedTableSpanAttribute(node.getAttribute('colspan'));
            const rowspan = getSanitizedTableSpanAttribute(node.getAttribute('rowspan'));
            if (colspan) element.setAttribute('colspan', colspan);
            if (rowspan) element.setAttribute('rowspan', rowspan);
          }
          Array.from(node.childNodes).forEach((childNode) => element.appendChild(sanitizeNode(childNode)));
          return element;
        };

        const output = document.createElement('div');
        Array.from(parsed.body.childNodes).forEach((childNode) => output.appendChild(sanitizeNode(childNode)));
        return output.innerHTML.trim();
      }

      function wrapPlainTextAsHtml(text) {
        const blocks = String(text || '')
          .replace(/\r/g, '')
          .split(/\n\s*\n/)
          .map((block) => normaliseWhitespace(block))
          .filter(Boolean);
        return blocks.length
          ? blocks.map((block) => '<p>' + escapeHtml(block) + '</p>').join('')
          : '<p>No content generated.</p>';
      }

      function normaliseGeneratedDocumentMarkup(markup) {
        const trimmed = String(markup || '').trim();
        const html = /<[a-z][\s\S]*>/i.test(trimmed) ? trimmed : wrapPlainTextAsHtml(trimmed);
        return sanitizeRichTextMarkup(html);
      }

      function getDocumentTemplatePrompt(template, session, transcriptSource) {
        const structuredData = getEffectiveStructuredData(session);
        const structuredContext = STRUCTURED_DATA_FIELDS
          .map((field) => ({ label: field.label, items: structuredData[field.key] }))
          .filter((field) => Array.isArray(field.items) && field.items.length)
          .map((field) => field.label + ':\n- ' + field.items.join('\n- '))
          .join('\n\n');
        return [
          'Generate a rich text HTML fragment for the following medical document type.',
          'Return semantic HTML only. Do not return markdown. Do not use code fences. Do not include <html>, <head>, <body>, <script>, or <style> tags.',
          'Use headings, paragraphs, lists, and tables when appropriate.',
          'Document type: ' + template.name,
          'Template instructions: ' + template.instructions,
          'Organisation: ' + (state.customisation.organisationName || ''),
          'Patient: ' + (session.patientName || ''),
          'Clinician: ' + (session.clinicianName || ''),
          'Consultation Type: ' + (session.consultationType || ''),
          structuredContext ? ('\nStructured extraction:\n' + structuredContext) : '',
          '',
          'Consultation transcript:',
          transcriptSource
        ].join('\n');
      }

      function getDocumentTargetLabel(session) {
        if (!session) return 'No session selected';
        const identity = session.patientName || session.consultationType || 'Unnamed session';
        const timestamp = formatDateTime(session.startedAt || session.createdAt);
        return timestamp ? (identity + ' • ' + timestamp) : identity;
      }

      function isDocumentGenerationBusy() {
        return Boolean(state.documentGenerationRequest);
      }

      function getDocumentGenerationBusyMessage() {
        return 'A document is already being generated. Please wait a moment.';
      }

      function refreshDocumentGenerationUi() {
        renderConsultationDocuments();
        renderConsultationReviewMode();
        renderDocumentsTab();
        if (state.currentTab === 'history' && state.historySelectedSessionId) renderHistoryDetail();
      }

      function updateDocumentGenerateButton(button, enabled, isBusy) {
        if (!button) return;
        button.disabled = false;
        button.setAttribute('aria-disabled', enabled ? 'false' : 'true');
        button.classList.toggle('is-disabled', !enabled);
        button.textContent = isBusy ? 'Generating...' : 'Generate Document';
      }

      function getHistorySessionAssets(session) {
        if (!session) return [];
        const assets = [{ id: 'summary', label: 'AI Summary', kind: 'summary' }];
        const documents = Array.isArray(session.documents)
          ? session.documents.slice().sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))
          : [];
        documents.forEach((documentItem) => {
          assets.push({
            id: documentItem.id,
            label: documentItem.title || documentItem.templateName || 'Document',
            kind: 'document',
            documentItem
          });
        });
        return assets;
      }

      function getSelectedHistoryAsset(session) {
        const assets = getHistorySessionAssets(session);
        return assets.find((asset) => asset.id === state.historySelectedAssetId) || assets[0] || null;
      }

      function setSelectedHistoryAsset(assetId) {
        state.historySelectedAssetId = assetId || 'summary';
      }

      function getHistoryAssetMetaText(session, asset) {
        if (!asset || asset.kind === 'summary') return getSummaryMetaText(session);
        return (asset.documentItem.templateName || 'Document') + ' • Last updated ' + formatDateTime(asset.documentItem.updatedAt);
      }

      function buildHistoryAssetHtml(session, asset) {
        if (!asset || asset.kind === 'summary') return buildSummaryPanelHtml(session);
        return '<div class="document-preview">' + normaliseGeneratedDocumentMarkup(asset.documentItem.content) + '</div>';
      }

      function renderConsultationDocuments() {
        if (isSessionUiLocked()) {
          refs.documentGenerationCard.classList.remove('hidden');
          refs.consultationDocumentType.innerHTML = '';
          refs.consultationDocumentsList.innerHTML = renderLockedPlaceholder(getSessionLockPlaceholderText('generated documents'));
          refs.documentCardMeta.textContent = 'Unlock the app to review or generate session documents.';
          updateDocumentGenerateButton(refs.generateDocumentBtn, false, false);
          refs.openDocumentsTabBtn.disabled = true;
          return;
        }
        const session = state.activeSession;
        const canShow = canGenerateDocumentsForSession(session);
        const isBusy = isDocumentGenerationBusy();
        refs.documentGenerationCard.classList.toggle('hidden', !canShow);
        if (!canShow) {
          refs.consultationDocumentType.innerHTML = '';
          refs.consultationDocumentsList.innerHTML = '';
          refs.documentCardMeta.textContent = 'Generate rich text documents from the stopped transcript.';
          updateDocumentGenerateButton(refs.generateDocumentBtn, false, isBusy);
          refs.openDocumentsTabBtn.disabled = true;
          return;
        }

        const templates = getDocumentTemplates();
        refs.consultationDocumentType.innerHTML = templates.length
          ? templates.map((template) => '<option value="' + escapeAttribute(template.id) + '">' + escapeHtml(template.name) + '</option>').join('')
          : '';

        if (!templates.find((template) => template.id === refs.consultationDocumentType.value) && templates.length) {
          refs.consultationDocumentType.value = templates[0].id;
        }
        updateDocumentGenerateButton(refs.generateDocumentBtn, hasPromptApiSupport() && Boolean(templates.length) && !isBusy, isBusy);
        refs.openDocumentsTabBtn.disabled = false;

        const documents = Array.isArray(session.documents) ? session.documents.slice().sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0)) : [];
        refs.documentCardMeta.textContent = documents.length
          ? ('Generated ' + String(documents.length) + ' document' + (documents.length === 1 ? '' : 's') + ' for this session.')
          : (isBusy ? 'Generating a document for this session. Please wait a moment.' : 'Generate rich text documents from the stopped transcript.');
        refs.consultationDocumentsList.innerHTML = documents.length
          ? documents.map((documentItem) => '<button type="button" class="document-card" data-document-id="' + escapeAttribute(documentItem.id) + '"><h4>' + escapeHtml(documentItem.title || documentItem.templateName) + '</h4><p>' + escapeHtml(getDocumentPreviewText(documentItem).slice(0, 150) || 'Rich text document') + '</p><div class="document-card-meta"><span class="plain-chip">' + escapeHtml(formatDateTime(documentItem.updatedAt)) + '</span></div></button>').join('')
          : '<div class="empty-state small">No documents have been generated for this session yet.</div>';
      }

      function renderDocumentsTab() {
        if (isSessionUiLocked()) {
          refs.documentsTabBtn.classList.toggle('hidden', false);
          refs.documentsTemplateSelect.innerHTML = '';
          updateDocumentGenerateButton(refs.documentsGenerateBtn, false, false);
          refs.copyDocumentTextBtn.disabled = true;
          refs.downloadDocumentBtn.disabled = true;
          refs.documentsMetaText.textContent = 'Unlock the app to review or generate session documents.';
          refs.documentsList.innerHTML = renderLockedPlaceholder(getSessionLockPlaceholderText('document drafts'));
          refs.documentDetailTitle.textContent = 'Document preview';
          refs.documentDetailMeta.textContent = 'Sensitive document content is hidden while the app is locked.';
          refs.documentPreview.innerHTML = '<div class="document-preview-empty">' + escapeHtml(getSessionLockPlaceholderText('document content')) + '</div>';
          refs.documentPreview.removeAttribute('contenteditable');
          return;
        }
        const session = getDocumentTargetSession();
        const canShow = canGenerateDocumentsForSession(session);
        const isBusy = isDocumentGenerationBusy();
        refs.documentsTabBtn.classList.toggle('hidden', !canShow);

        if (state.currentTab === 'documents' && !canShow) {
          switchTab(getSelectedHistorySession() ? 'history' : 'consultation');
          return;
        }

        const templates = getDocumentTemplates();
        refs.documentsTemplateSelect.innerHTML = templates.length
          ? templates.map((template) => '<option value="' + escapeAttribute(template.id) + '">' + escapeHtml(template.name) + '</option>').join('')
          : '';

        if (!templates.find((template) => template.id === refs.documentsTemplateSelect.value) && templates.length) {
          refs.documentsTemplateSelect.value = templates[0].id;
        }

        updateDocumentGenerateButton(refs.documentsGenerateBtn, canShow && hasPromptApiSupport() && Boolean(templates.length) && !isBusy, isBusy);
        refs.copyDocumentTextBtn.disabled = true;
        refs.downloadDocumentBtn.disabled = true;

        if (!canShow) {
          refs.documentsMetaText.textContent = hasPromptApiSupport()
            ? 'Stop the active consultation or open a stopped history session to enable document generation.'
            : 'Document generation requires the Prompt API in this browser.';
          refs.documentsList.innerHTML = '<div class="empty-state small">Stop a transcripted consultation or select a stopped history session to generate and review documents here.</div>';
          refs.documentDetailTitle.textContent = 'Document preview';
          refs.documentDetailMeta.textContent = 'Generated documents use rich text HTML and can be edited inline.';
          refs.documentPreview.innerHTML = '<div class="document-preview-empty">Stop a transcripted consultation or select a stopped history session to unlock document generation.</div>';
          refs.documentPreview.removeAttribute('contenteditable');
          return;
        }

        const targetLabel = getDocumentTargetLabel(session);
        refs.documentsMetaText.textContent = hasPromptApiSupport()
          ? ('Target session: ' + targetLabel + '. ' + (isBusy ? 'Document generation is in progress. Please wait a moment.' : 'Generate rich text drafts from this stopped transcript.'))
          : 'Document generation requires the Prompt API in this browser.';

        const documents = Array.isArray(session.documents) ? session.documents.slice().sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0)) : [];
        ensureSelectedDocument(session);
        const selectedDocument = getSelectedSessionDocument(session);
        refs.documentsList.innerHTML = documents.length
          ? documents.map((documentItem) => '<button type="button" class="document-card' + (selectedDocument && selectedDocument.id === documentItem.id ? ' selected' : '') + '" data-documents-document-id="' + escapeAttribute(documentItem.id) + '"><h4>' + escapeHtml(documentItem.title || documentItem.templateName) + '</h4><p>' + escapeHtml(getDocumentPreviewText(documentItem).slice(0, 180) || 'Rich text document') + '</p><div class="document-card-meta"><span class="plain-chip">' + escapeHtml(documentItem.templateName) + '</span><span class="plain-chip secondary">' + escapeHtml(formatDateTime(documentItem.updatedAt)) + '</span></div></button>').join('')
          : '<div class="empty-state small">No documents have been generated for this session yet.</div>';

        if (!selectedDocument) {
          refs.documentDetailTitle.textContent = 'Document preview';
          refs.documentDetailMeta.textContent = 'No document selected for ' + targetLabel + '.';
          refs.documentPreview.innerHTML = '<div class="document-preview-empty">Generate a document to preview and edit it here.</div>';
          refs.documentPreview.removeAttribute('contenteditable');
          return;
        }

        refs.copyDocumentTextBtn.disabled = false;
        refs.downloadDocumentBtn.disabled = false;
        refs.documentDetailTitle.textContent = selectedDocument.title || selectedDocument.templateName;
        refs.documentDetailMeta.textContent = targetLabel + ' • Last updated ' + formatDateTime(selectedDocument.updatedAt) + ' • Rich text HTML';
        refs.documentPreview.innerHTML = normaliseGeneratedDocumentMarkup(selectedDocument.content);
        refs.documentPreview.setAttribute('contenteditable', 'true');
      }

      async function generateSessionDocument(sessionId, templateId, options = {}) {
        const session = findSession(sessionId);
        const template = findDocumentTemplate(templateId);
        if (!session || !template) return;
        if (isDocumentGenerationBusy()) {
          showToast(getDocumentGenerationBusyMessage(), 'warning', 2600);
          return;
        }
        if (!hasPromptApiSupport()) {
          showToast('Document generation requires the Prompt API in this browser.', 'warning', 4200);
          return;
        }
        if (!canGenerateDocumentsForSession(session)) return;

        const transcriptSource = getTranscriptSummarySource(session);
        const requestPrompt = getDocumentTemplatePrompt(template, session, transcriptSource);
        const auditActor = options.auditActor === 'system' ? 'system' : 'user';
        let sessionHandle = null;
        state.documentGenerationRequest = {
          sessionId: session.id,
          templateId: template.id,
          templateName: template.name
        };
        refreshDocumentGenerationUi();

        try {
          const languageModelApi = getLanguageModelApi();
          if (!languageModelApi) throw new Error('Prompt API is not available in this browser.');
          const availability = await getPromptApiAvailability();
          if (availability !== 'available') throw new Error('Language model is not available: ' + availability);

          sessionHandle = await languageModelApi.create(getPromptApiOptions());

          const result = await sessionHandle.prompt(requestPrompt);
          if (!String(result || '').trim()) throw new Error('The browser returned an empty document.');
          const markup = normaliseGeneratedDocumentMarkup(result);

          const refreshedSession = findSession(session.id);
          if (!refreshedSession) return;

          const existingDocument = (refreshedSession.documents || []).find((documentItem) => documentItem.templateId === template.id);
          const nextTimestamp = Date.now();
          if (existingDocument) {
            existingDocument.title = template.name;
            existingDocument.templateName = template.name;
            existingDocument.content = markup;
            existingDocument.updatedAt = nextTimestamp;
          } else {
            refreshedSession.documents = Array.isArray(refreshedSession.documents) ? refreshedSession.documents : [];
            refreshedSession.documents.unshift(createSessionDocument({
              templateId: template.id,
              templateName: template.name,
              title: template.name,
              content: markup,
              createdAt: nextTimestamp,
              updatedAt: nextTimestamp
            }));
          }

          refreshedSession.updatedAt = nextTimestamp;
          appendAuditEvent(
            refreshedSession,
            'document-generated',
            existingDocument ? 'Document regenerated from template.' : 'Document generated from template.',
            {
              templateId: template.id,
              templateName: template.name,
              action: existingDocument ? 'updated' : 'created'
            },
            auditActor
          );
          upsertSession(refreshedSession);
          const generatedDocument = (refreshedSession.documents || []).find((documentItem) => documentItem.templateId === template.id) || null;
          setSelectedDocument(generatedDocument ? generatedDocument.id : null);
          if (state.currentTab === 'history' && state.historySelectedSessionId === refreshedSession.id) {
            setSelectedHistoryAsset(generatedDocument ? generatedDocument.id : 'summary');
            renderHistoryDetail();
          }
          persistSessions();
          renderConsultationDocuments();
          renderDocumentsTab();
          if (options.openTab) switchTab('documents');
          showToast(template.name + ' generated.', 'success', 2200);
        } catch (error) {
          showToast('Document generation failed: ' + normaliseWhitespace(error && error.message ? error.message : String(error || 'Unknown error')), 'error', 4200);
        } finally {
          state.documentGenerationRequest = null;
          closeTextSession(sessionHandle);
          refreshDocumentGenerationUi();
        }
      }

      async function generateSessionSummary(sessionId, options = {}) {
        const session = findSession(sessionId);
        if (!session) return;

        const promptTemplate = getSummaryPromptValue();
        const transcriptSource = getTranscriptSummarySource(session);
        const status = getEffectiveSummaryStatus(session);
        const force = Boolean(options.force);
        const showFeedback = options.showFeedback !== false;
        const auditActor = options.auditActor === 'user' || options.auditActor === 'system'
          ? options.auditActor
          : (force ? 'user' : 'system');

        if (!hasAiSummarySupport()) {
          if (showFeedback) showToast('On-device AI summarisation is not available in this browser.', 'warning', 4200);
          renderSummaryViewsForSession(session.id);
          return;
        }
        if (!normaliseWhitespace(transcriptSource)) return;
        if (!force && status === 'ready') return;
        if (!force && status === 'generating') return;

        const requestToken = uid('summary');
        state.summaryRequestTokens[session.id] = requestToken;
        session.summaryStatus = 'generating';
        session.summaryError = '';
        session.updatedAt = Date.now();
        upsertSession(session);
        persistSessions();
        renderSummaryViewsForSession(session.id);

        try {
          const summaryText = await buildChunkedSummary(session, promptTemplate);
          if (!normaliseWhitespace(summaryText)) throw new Error('The browser returned an empty summary.');
          applyGeneratedSummary(session.id, requestToken, summaryText, promptTemplate, transcriptSource, { actor: auditActor });
          if (showFeedback) showToast('Summary generated.', 'success', 2200);
        } catch (error) {
          applySummaryGenerationError(session.id, requestToken, error);
          if (showFeedback) showToast('Summary generation failed.', 'error', 4200);
        } finally {
          if (state.summaryRequestTokens[session.id] === requestToken) delete state.summaryRequestTokens[session.id];
        }
      }

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
        const manualNotesChanged = state.activeSession.manualNotes !== values.manualNotes;
        state.activeSession.patientName = values.patientName;
        state.activeSession.clinicianName = values.clinicianName;
        state.activeSession.consultationType = values.consultationType;
        state.activeSession.manualNotes = values.manualNotes;
        if (manualNotesChanged) {
          state.activeSession.manualNotesUpdatedAt = Date.now();
          queueManualNotesAuditEvent(state.activeSession.id, 'consultation');
        }
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
        const session = createSession({ patientName: formValues.patientName, clinicianName: formValues.clinicianName, consultationType: formValues.consultationType, manualNotes: formValues.manualNotes, manualNotesUpdatedAt: normaliseWhitespace(formValues.manualNotes) ? now : null, tags: formValues.tags.slice(), status, startedAt: now, createdAt: now, updatedAt: now, elapsedMs: 0, lastStartedSegmentAt: null, stoppedAt: status === 'stopped' ? now : null, ephemeral: Boolean(state.settings.ephemeralConsultationMode) });
        appendAuditEvent(session, 'session-created', 'Session created.', { status, ephemeral: Boolean(session.ephemeral) }, 'user');
        state.activeSession = session;
        state.selectedDocumentId = null;
        state.consultationDraftTags = formValues.tags.slice();
        upsertSession(session);
        state.auditDebounce.manualNotesSignatures[session.id] = normaliseWhitespace(session.manualNotes || '');
        return session;
      }

      function populateConsultationForm(session) {
        const source = session || null;
        refs.patientName.value = source ? source.patientName || '' : '';
        refs.clinicianName.value = source ? source.clinicianName || getDefaultPractitionerName() : getDefaultPractitionerName();
        refs.consultationType.value = source ? (source.consultationType || state.customisation.defaultConsultationType || '') : (state.customisation.defaultConsultationType || '');
        refs.manualNotes.value = source ? (source.manualNotes || '') : '';
        state.consultationDraftTags = source ? (source.tags || []).slice() : [];
      }

      function resetConsultationDraft(keepIdentityFields = false) {
        if (!keepIdentityFields) { refs.patientName.value = ''; refs.clinicianName.value = getDefaultPractitionerName(); }
        refs.consultationType.value = state.customisation.defaultConsultationType || '';
        refs.manualNotes.value = '';
        refs.transcriptSearch.value = '';
        state.consultationDraftTags = [];
        state.activeSession = null;
        state.selectedDocumentId = null;
        state.interimText = '';
        state.transcriptSearch = '';
      }

      function renderLastSavedLabel() {
        if (state.secureStorage.persistWarning) {
          refs.lastSavedLabel.textContent = state.secureStorage.persistWarning;
          return;
        }
        if (state.activeSession && isEphemeralSession(state.activeSession)) {
          refs.lastSavedLabel.textContent = 'Ephemeral consultation kept in memory only';
          return;
        }
        refs.lastSavedLabel.textContent = state.lastPersistedAt ? ('Last saved ' + formatDateTime(state.lastPersistedAt)) : 'Not yet saved';
      }

      function getConsultationPrivacyMessage() {
        if (isSessionUiLocked()) return getSessionLockReasonMessage();
        if (state.activeSession && isEphemeralSession(state.activeSession)) {
          return 'This consultation is in ephemeral mode. It stays in memory for this tab only unless you choose to save it to local storage.';
        }
        if (state.settings.secureStorageEnabled && !state.secureStorage.unlocked && state.settings.secureStorageMode === 'passphrase') {
          return 'Saved consultation history is protected by encrypted local storage, but this tab is still locked. Enter the secure-storage passphrase before saving identifiable session data.';
        }
        if (state.settings.ephemeralConsultationMode) {
          return 'New consultations start in ephemeral mode and are kept in memory only until you explicitly save them into encrypted local history.';
        }
        if (state.settings.purgeOnBrowserClose) {
          return 'Saved consultation history will be purged from this browser when the tab is closed, if the browser allows unload cleanup.';
        }
        return '';
      }

      function renderConsultationPrivacyMessage() {
        renderSupportBanner(refs.consultationPrivacyMessage, getConsultationPrivacyMessage());
      }

      function renderConsultationSummaryLabel() {
        if (isSessionUiLocked()) { refs.sessionSummaryLabel.textContent = 'Session locked'; return; }
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
        if (isSessionUiLocked()) {
          refs.statusPill.className = 'status-pill paused';
          refs.statusPill.textContent = 'Locked';
          return;
        }
        const status = state.activeSession ? state.activeSession.status : 'idle';
        refs.statusPill.className = 'status-pill ' + status;
        refs.statusPill.textContent = titleCaseStatus(status);
      }

      function refreshControlStates() {
        if (isSessionUiLocked()) {
          refs.startBtn.disabled = true;
          refs.pauseBtn.disabled = true;
          refs.resumeBtn.disabled = true;
          refs.stopBtn.disabled = true;
          refs.markImportantBtn.disabled = true;
          refs.saveSessionBtn.disabled = true;
          refs.copyTranscriptBtn.disabled = true;
          refs.exportTranscriptBtn.disabled = true;
          return;
        }
        const status = state.activeSession ? state.activeSession.status : 'idle';
        refs.startBtn.disabled = !state.supportsSpeech || status === 'listening';
        refs.pauseBtn.disabled = status !== 'listening';
        refs.resumeBtn.disabled = !state.supportsSpeech || status !== 'paused';
        refs.stopBtn.disabled = !(status === 'listening' || status === 'paused');
        refs.markImportantBtn.disabled = !state.activeSession;
        refs.saveSessionBtn.disabled = false;
        refs.copyTranscriptBtn.disabled = false;
        refs.exportTranscriptBtn.disabled = false;
      }

      function renderSessionHint() {
        if (isSessionUiLocked()) {
          refs.transcriptEditHint.textContent = 'Unlock the app to view or edit transcript content.';
          return;
        }
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
        refs.speechSupportMessage.textContent = 'Speech recognition is not supported in this browser. Open this file in a supported Chromium browser such as Chrome or Edge to use live transcription. Manual notes, session saving, history, settings, and customisation still work.';
      }

      function renderActiveSessionStateText() {
        if (isSessionUiLocked()) {
          refs.activeSessionStateText.textContent = 'Sensitive consultation content is hidden until the app is unlocked.';
          return;
        }
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
        refs.downloadFhirBtn.disabled = isSessionUiLocked() || !state.activeSession;
        refs.sendFhirBtn.disabled = isSessionUiLocked() || !state.activeSession || Boolean(getFhirConfigurationError());
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

      function handleTranscriptEntryUpdate(sessionId, entryId, newText, persistImmediately = false, source = 'consultation') {
        const session = findSession(sessionId);
        if (!session) return;
        const entry = session.transcriptEntries.find((item) => item.id === entryId);
        if (!entry) return;
        entry.text = newText;
        entry.lastUpdatedAt = Date.now();
        session.updatedAt = Date.now();
        upsertSession(session);
        queueTranscriptEditAuditEvent(session.id, entry.id, source);
        if (persistImmediately) persistSessionsDebounced();
        if (state.activeSession && state.activeSession.id === session.id) {
          renderConsultationChrome();
          renderConsultationSummary();
          renderConsultationReviewMode();
        }
        if (state.currentTab === 'history' && state.historySelectedSessionId === session.id) renderHistoryDetail();
      }

      function renderTranscriptEntries(container, session, options = {}) {
        const searchTerm = String(options.searchTerm || '').trim();
        const editable = Boolean(options.editable);
        const onlyLowConfidence = Boolean(options.onlyLowConfidence);
        const emptyMessage = options.emptyMessage || 'No transcript recorded yet.';
        const onEntryChange = typeof options.onEntryChange === 'function' ? options.onEntryChange : null;
        const entries = getTranscriptDisplayEntries(session, searchTerm).filter((entry) => !onlyLowConfidence || entry.isImportantMarker || isLowConfidenceTranscriptEntry(entry));
        container.innerHTML = '';
        if (!entries.length) {
          container.innerHTML = '<div class="empty-state small">' + escapeHtml(searchTerm ? 'No matching transcript segments.' : emptyMessage) + '</div>';
          return;
        }
        entries.forEach((entry) => {
          const article = document.createElement('article');
          article.className = 'transcript-entry' + (entry.isImportantMarker ? ' marker' : '') + (entry.isImportantMarker ? '' : ' ' + getTranscriptEntryConfidenceBand(entry) + '-confidence');
          article.dataset.transcriptEntryId = entry.id;
          const header = document.createElement('div');
          header.className = 'transcript-entry-head';
          const meta = document.createElement('div');
          meta.className = 'entry-meta';
          meta.innerHTML = '<span class="timestamp-badge">' + escapeHtml(formatClock(entry.timestamp)) + '</span>' + '<span class="offset-badge">+' + escapeHtml(formatDuration(Math.max(0, (entry.timestamp || 0) - (session.startedAt || entry.timestamp || 0)))) + '</span>' + (entry.isImportantMarker ? '<span class="meta-badge">Important moment</span>' : (entry.confidence != null ? '<span class="confidence-pill ' + escapeAttribute(getTranscriptEntryConfidenceBand(entry)) + '">' + Math.round(entry.confidence * 100) + '% confidence</span><span class="review-badge provenance">' + escapeHtml(getTranscriptEntryConfidenceLabel(entry)) + '</span>' : ''));
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
        if (isSessionUiLocked()) {
          refs.transcriptContainer.innerHTML = renderLockedPlaceholder(getSessionLockPlaceholderText('transcript'));
          renderInterim();
          return;
        }
        const session = state.activeSession;
        if (!session) {
          refs.transcriptContainer.innerHTML = '<div class="empty-state">Start listening to populate the live transcript. Important markers and transcript edits appear here.</div>';
          renderInterim();
          return;
        }
        renderTranscriptEntries(refs.transcriptContainer, session, { searchTerm: state.transcriptSearch, editable: session.status === 'stopped', emptyMessage: 'Transcript entries will appear as timestamped blocks.', onEntryChange: (entryId, newText) => handleTranscriptEntryUpdate(session.id, entryId, newText, true, 'consultation') });
        renderInterim();
      }

      function renderConsultation() {
        if (isSessionUiLocked()) {
          refs.patientName.value = '';
          refs.clinicianName.value = '';
          refs.consultationType.value = '';
          refs.manualNotes.value = '';
          refs.transcriptSearch.value = '';
          refs.patientName.disabled = true;
          refs.clinicianName.disabled = true;
          refs.consultationType.disabled = true;
          refs.manualNotes.disabled = true;
          refs.transcriptSearch.disabled = true;
          refs.macroBar.innerHTML = '<span class="subtle-note">Unlock the app to access snippets.</span>';
          refs.tagSelector.innerHTML = '<span class="subtle-note">Unlock the app to access session tags.</span>';
          renderSpeechSupportBanner();
          renderConsultationPrivacyMessage();
          renderConsultationChrome();
          renderConsultationSummary();
          renderConsultationStructuredView();
          renderConsultationReviewMode();
          renderConsultationDocuments();
          renderConsultationTranscript();
          renderDocumentsTab();
          return;
        }
        refs.patientName.disabled = false;
        refs.clinicianName.disabled = false;
        refs.consultationType.disabled = false;
        refs.manualNotes.disabled = false;
        refs.transcriptSearch.disabled = false;
        if (state.activeSession) populateConsultationForm(state.activeSession);
        renderSpeechSupportBanner();
        renderConsultationPrivacyMessage();
        renderMacroBar();
        renderConsultationTagSelector();
        renderConsultationChrome();
        renderConsultationSummary();
        renderConsultationStructuredView();
        renderConsultationReviewMode();
        renderConsultationDocuments();
        renderConsultationTranscript();
        renderDocumentsTab();
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
        if (isSessionUiLocked()) {
          refs.historyCount.textContent = 'Locked';
          refs.sessionList.innerHTML = '<div class="empty-state">' + escapeHtml(getSessionLockPlaceholderText('session history')) + '</div>';
          return;
        }
        const sessions = getFilteredSessions();
        refs.historyCount.textContent = sessions.length === state.sessions.length ? String(sessions.length) : (String(sessions.length) + ' / ' + String(state.sessions.length));
        if (!sessions.length) {
          refs.sessionList.innerHTML = '<div class="empty-state">' + escapeHtml(hasLockedSessionEnvelope() ? 'Encrypted session history is locked. Unlock it from Settings to review saved consultations.' : 'No sessions match the current history filters.') + '</div>';
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
            session.manualNotesUpdatedAt = Date.now();
            session.updatedAt = Date.now();
            upsertSession(session);
            syncConsultationViewForSession(session);
            queueManualNotesAuditEvent(session.id, 'history');
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
        const copyAuditButton = detailRoot.querySelector('#historyCopyAuditTextBtn');
        if (copyAuditButton) {
          copyAuditButton.addEventListener('click', () => {
            copyToClipboard(buildAuditLogText(session))
              .then(() => showToast('Audit log copied to clipboard.', 'success', 2200))
              .catch(() => showToast('Copy failed in this browser context.', 'error', 3200));
          });
        }
        const exportAuditTextButton = detailRoot.querySelector('#historyExportAuditTextBtn');
        if (exportAuditTextButton) {
          exportAuditTextButton.addEventListener('click', () => {
            exportSessionAuditLog(session, 'text');
            showToast('Audit log exported as text.', 'success', 2200);
          });
        }
        const exportAuditJsonButton = detailRoot.querySelector('#historyExportAuditJsonBtn');
        if (exportAuditJsonButton) {
          exportAuditJsonButton.addEventListener('click', () => {
            exportSessionAuditLog(session, 'json');
            showToast('Audit log exported as JSON.', 'success', 2200);
          });
        }
        const summaryButton = detailRoot.querySelector('#historyGenerateSummaryBtn');
        if (summaryButton) {
          summaryButton.addEventListener('click', async () => {
            await generateSessionSummary(session.id, { force: true });
          });
        }
        const historyReviewToggle = detailRoot.querySelector('#historyReviewLowConfidenceToggle');
        if (historyReviewToggle) {
          historyReviewToggle.addEventListener('click', () => {
            state.reviewMode.historyLowConfidenceOnly = !state.reviewMode.historyLowConfidenceOnly;
            renderHistoryDetail();
          });
        }
        const structuredButton = detailRoot.querySelector('#historyExtractStructuredBtn');
        if (structuredButton) {
          structuredButton.addEventListener('click', async () => {
            await refreshSessionStructuredData(session.id, { force: true });
          });
        }
        detailRoot.querySelectorAll('[data-structured-field]').forEach((input) => {
          input.addEventListener('input', () => {
            session.structuredData = normalizeStructuredData(Object.assign({}, session.structuredData, {
              [input.dataset.structuredField]: splitStructuredEditorValue(input.value)
            }));
            session.structuredDataUpdatedAt = Date.now();
            session.structuredDataStatus = 'ready';
            session.structuredDataError = '';
            session.updatedAt = Date.now();
            upsertSession(session);
            if (state.activeSession && state.activeSession.id === session.id) renderConsultationStructuredView();
            if (state.activeSession && state.activeSession.id === session.id) renderConsultationReviewMode();
            if (state.currentTab === 'history') renderHistoryList();
            persistSessionsDebounced();
          });
        });
        detailRoot.querySelectorAll('[data-review-entry-id]').forEach((button) => {
          button.addEventListener('click', () => {
            focusTranscriptEntry(session, button.dataset.reviewEntryId, button.dataset.reviewContext || 'history');
          });
        });
        detailRoot.querySelectorAll('[data-review-query]').forEach((button) => {
          button.addEventListener('click', () => {
            applyReviewTranscriptSearch(session, button.dataset.reviewQuery, button.dataset.reviewContext || 'history');
          });
        });
        detailRoot.querySelectorAll('[data-review-action]').forEach((button) => {
          button.addEventListener('click', async () => {
            const action = button.dataset.reviewAction;
            if (action === 'regenerate-summary') {
              await generateSessionSummary(session.id, { force: true });
              return;
            }
            if (action === 'extract-structured') {
              await refreshSessionStructuredData(session.id, { force: true });
              return;
            }
            if (action === 'open-document') {
              const documentId = button.dataset.reviewDocumentId || null;
              setSelectedDocument(documentId);
              setSelectedHistoryAsset(documentId || 'summary');
              renderHistoryDetail();
              renderDocumentsTab();
              return;
            }
            if (action === 'regenerate-document') {
              const templateId = button.dataset.reviewTemplateId || '';
              if (!templateId) return;
              await generateSessionDocument(session.id, templateId, { openTab: false });
            }
          });
        });
        const historyAssetSelect = detailRoot.querySelector('#historySessionAssetSelect');
        if (historyAssetSelect) {
          historyAssetSelect.addEventListener('change', () => {
            setSelectedHistoryAsset(historyAssetSelect.value);
            renderHistoryDetail();
          });
        }
        const generateDocumentButton = detailRoot.querySelector('#historyGenerateDocumentBtn');
        if (generateDocumentButton) {
          generateDocumentButton.addEventListener('click', async () => {
            if (isDocumentGenerationBusy()) {
              showToast(getDocumentGenerationBusyMessage(), 'warning', 2600);
              return;
            }
            const templateSelect = detailRoot.querySelector('#historyDocumentTemplateSelect');
            const templateId = templateSelect ? templateSelect.value : '';
            if (!templateId) {
              showToast('Add a document template before generating a document.', 'warning');
              return;
            }
            await generateSessionDocument(session.id, templateId, { openTab: false });
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
        if (isSessionUiLocked()) {
          refs.historyEditToggle.disabled = true;
          refs.historySaveBtn.disabled = true;
          refs.historyDownloadFhirBtn.disabled = true;
          refs.historySendFhirBtn.disabled = true;
          refs.historyDetailHint.textContent = 'Unlock the app to review transcript, notes, metadata, and documents.';
          refs.historyEditToggle.textContent = 'Edit Mode';
          refs.historyDetail.innerHTML = '<div class="empty-state">' + escapeHtml(getSessionLockPlaceholderText('session details')) + '</div>';
          return;
        }
        const session = getSelectedHistorySession();
        refs.historyEditToggle.disabled = !session;
        refs.historySaveBtn.disabled = !session;
        refs.historyDownloadFhirBtn.disabled = !session;
        refs.historySendFhirBtn.disabled = !session || Boolean(getFhirConfigurationError());
        refs.historyDetailHint.textContent = session ? 'Review transcript, notes, metadata, and tags for the selected session.' : 'Select a session to review transcript and notes.';
        refs.historyEditToggle.textContent = state.historyEditMode ? 'Read Mode' : 'Edit Mode';
        if (!session) {
          refs.historyDetail.innerHTML = '<div class="empty-state">' + escapeHtml(hasLockedSessionEnvelope() ? 'Saved session history is currently locked, so detail view is unavailable until it is unlocked.' : 'Select a session from the list to open its transcript and notes.') + '</div>';
          return;
        }
        const editable = state.historyEditMode;
        const canShowDocuments = canGenerateDocumentsForSession(session);
        const selectedAsset = getSelectedHistoryAsset(session);
        const detail = refs.historyDetail;
        detail.innerHTML = '<div class="detail-grid">' +
          '<div class="field"><span class="label">Patient</span>' + (editable ? '<input data-history-field="patientName" value="' + escapeAttribute(session.patientName || '') + '" />' : '<div class="static-value">' + escapeHtml(session.patientName || '-') + '</div>') + '</div>' +
          '<div class="field"><span class="label">Clinician</span>' + (editable ? '<input data-history-field="clinicianName" value="' + escapeAttribute(session.clinicianName || '') + '" />' : '<div class="static-value">' + escapeHtml(session.clinicianName || '-') + '</div>') + '</div>' +
          '<div class="field"><span class="label">Consultation Type</span>' + (editable ? '<input data-history-field="consultationType" value="' + escapeAttribute(session.consultationType || '') + '" />' : '<div class="static-value">' + escapeHtml(session.consultationType || '-') + '</div>') + '</div>' +
          '</div>' +
          '<div class="detail-block"><div class="detail-header-row"><div><h4 style="margin:0;">Metadata</h4><div class="subtle-note">Started ' + escapeHtml(formatDateTime(session.startedAt || session.createdAt)) + ' • Duration ' + escapeHtml(formatDuration(getSessionElapsedMs(session))) + ' • Updated ' + escapeHtml(formatDateTime(session.updatedAt)) + '</div></div><div class="inline-actions"><span class="status-pill ' + escapeAttribute(session.status) + '">' + escapeHtml(titleCaseStatus(session.status)) + '</span>' + (session.archived ? '<span class="archived-badge">Archived</span>' : '') + '</div></div><div class="tag-selector" id="historyTagList"></div></div>' +
          '<div class="detail-block"><div class="detail-header-row"><div><h4 style="margin:0;">Audit log</h4><div class="subtle-note">Append-only local timeline of important user and system actions.</div></div><div class="inline-actions"><button class="btn small" type="button" id="historyCopyAuditTextBtn">Copy log</button><button class="btn small" type="button" id="historyExportAuditTextBtn">Export .txt</button><button class="btn small" type="button" id="historyExportAuditJsonBtn">Export .json</button></div></div><div class="summary-output audit-output" id="historyAuditContainer"></div></div>' +
          '<div class="detail-block"><div class="detail-header-row"><div><h4 style="margin:0;">Review mode</h4><div class="subtle-note" id="historyReviewMeta"></div></div><div class="inline-actions"><button class="btn small" type="button" id="historyReviewLowConfidenceToggle">' + escapeHtml(state.reviewMode.historyLowConfidenceOnly ? 'Show all transcript blocks' : 'Show low-confidence only') + '</button></div></div><div class="review-mode-container" id="historyReviewContainer"></div></div>' +
          '<div class="detail-block"><div class="detail-header-row"><div><h4 style="margin:0;">Manual notes</h4><div class="subtle-note">Editable when history detail is in edit mode.</div></div></div>' + (editable ? '<textarea id="historyNotesEditor" class="manual-notes" style="min-height:140px;">' + escapeHtml(session.manualNotes || '') + '</textarea>' : '<div class="note-preview">' + escapeHtml(session.manualNotes || 'No manual notes.').replace(/\n/g, '<br>') + '</div>') + '</div>' +
          '<div class="detail-block"><div class="detail-header-row"><div><h4 style="margin:0;">Structured view</h4><div class="subtle-note" id="historyStructuredMeta"></div></div><div class="inline-actions"><button class="btn small" type="button" id="historyExtractStructuredBtn">' + escapeHtml(session.structuredDataStatus === 'generating' ? 'Extracting...' : 'Extract structured items') + '</button></div></div><div class="structured-output" id="historyStructuredContainer"></div></div>' +
          '<div class="detail-block"><div class="detail-header-row"><div><h4 style="margin:0;">Session documents</h4><div class="subtle-note" id="historyDocumentMeta"></div></div><div class="inline-actions"><div class="field" style="margin:0; min-width:220px;"><label class="label" for="historySessionAssetSelect">Show document</label><select id="historySessionAssetSelect"></select></div>' + (canShowDocuments ? '<div class="field" style="margin:0; min-width:220px;"><label class="label" for="historyDocumentTemplateSelect">Generate type</label><select id="historyDocumentTemplateSelect"></select></div><button class="btn small secondary" type="button" id="historyGenerateDocumentBtn">Generate Document</button>' : '') + '<button class="btn small" type="button" id="historyGenerateSummaryBtn">Generate Summary</button></div></div><div class="summary-output" id="historyDocumentContainer"></div></div>' +
          '<div class="detail-block"><div class="detail-header-row"><div><h4 style="margin:0;">Transcript</h4><div class="subtle-note">' + (editable && !state.historyDetailSearch ? 'Stopped transcripts can be corrected inline.' : 'Search to filter transcript segments.') + '</div></div><input id="historyDetailSearch" class="search-input" type="search" placeholder="Search within this transcript..." value="' + escapeAttribute(state.historyDetailSearch || '') + '" /></div><div class="transcript-container history-transcript" id="historyTranscriptContainer"></div></div>';
        renderHistoryTags(detail.querySelector('#historyTagList'), session, editable);
        detail.querySelector('#historyAuditContainer').innerHTML = buildAuditTimelineHtml(session);
        detail.querySelector('#historyReviewMeta').textContent = getReviewModeMetaText(session);
        detail.querySelector('#historyReviewContainer').innerHTML = buildReviewModePanelHtml(session, 'history');
        detail.querySelector('#historyStructuredMeta').textContent = getStructuredDataStatusText(session);
        detail.querySelector('#historyStructuredContainer').innerHTML = buildStructuredDataViewHtml(session, { editable, showEmptySections: true });
        const historyExtractStructuredBtn = detail.querySelector('#historyExtractStructuredBtn');
        if (historyExtractStructuredBtn) historyExtractStructuredBtn.disabled = session.structuredDataStatus === 'generating';
        const historyAssetOptions = getHistorySessionAssets(session);
        const historyAssetSelect = detail.querySelector('#historySessionAssetSelect');
        historyAssetSelect.innerHTML = historyAssetOptions.map((asset) => '<option value="' + escapeAttribute(asset.id) + '">' + escapeHtml(asset.label) + '</option>').join('');
        historyAssetSelect.value = selectedAsset ? selectedAsset.id : 'summary';
        detail.querySelector('#historyDocumentMeta').textContent = getHistoryAssetMetaText(session, selectedAsset);
        detail.querySelector('#historyDocumentContainer').innerHTML = buildHistoryAssetHtml(session, selectedAsset);
        const historyDocumentTemplateSelect = detail.querySelector('#historyDocumentTemplateSelect');
        if (historyDocumentTemplateSelect) {
          const templates = getDocumentTemplates();
          historyDocumentTemplateSelect.innerHTML = templates.length
            ? templates.map((template) => '<option value="' + escapeAttribute(template.id) + '">' + escapeHtml(template.name) + '</option>').join('')
            : '<option value="">No document templates configured</option>';
        }
        updateSummaryButton(detail.querySelector('#historyGenerateSummaryBtn'), session);
        const historyGenerateDocumentBtn = detail.querySelector('#historyGenerateDocumentBtn');
        if (historyGenerateDocumentBtn) updateDocumentGenerateButton(historyGenerateDocumentBtn, hasPromptApiSupport() && Boolean(getDocumentTemplates().length) && !isDocumentGenerationBusy(), isDocumentGenerationBusy());
        renderTranscriptEntries(detail.querySelector('#historyTranscriptContainer'), session, { searchTerm: state.historyDetailSearch, editable: editable && session.status === 'stopped', emptyMessage: 'This session does not yet contain transcript segments.', onEntryChange: (entryId, newText) => {
          handleTranscriptEntryUpdate(session.id, entryId, newText, true, 'history');
          syncConsultationViewForSession(session);
          renderHistoryDetail();
        } });
        renderDocumentsTab();
        attachHistoryDetailListeners(session, detail);
      }

      function renderHistory() {
        renderSupportBanner(refs.historySecurityMessage, getSecureStorageWarningMessage());
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
        refs.settingSecureStorageEnabled.checked = Boolean(state.settings.secureStorageEnabled);
        refs.settingSecureStorageMode.value = state.settings.secureStorageMode;
        refs.settingAutoLockMinutes.value = String(state.settings.autoLockMinutes);
        refs.settingAutoSaveInterval.value = String(state.settings.autoSaveInterval);
        refs.settingAutoSaveIntervalValue.textContent = state.settings.autoSaveInterval + 's';
        refs.settingTheme.value = state.settings.theme;
        refs.settingDataRetentionDays.value = String(state.settings.dataRetentionDays);
        refs.settingPurgeOnBrowserClose.checked = Boolean(state.settings.purgeOnBrowserClose);
        refs.settingEphemeralConsultationMode.checked = Boolean(state.settings.ephemeralConsultationMode);
        refs.settingTranscriptFontSize.value = String(state.settings.transcriptFontSize);
        refs.settingTranscriptFontSizeValue.textContent = state.settings.transcriptFontSize + 'px';
        refs.settingLineSpacing.value = String(state.settings.transcriptLineSpacing);
        refs.settingLineSpacingValue.textContent = Number(state.settings.transcriptLineSpacing).toFixed(2);
        refs.settingSummaryPrompt.value = getSummaryPromptValue();
        refs.settingFhirEndpointUrl.value = state.settings.fhirEndpointUrl;
        refs.settingFhirSendMode.value = state.settings.fhirSendMode;
        refs.settingFhirAuthType.value = state.settings.fhirAuthType;
        refs.settingFhirBearerToken.value = state.settings.fhirBearerToken;
        refs.settingFhirCustomHeaderName.value = state.settings.fhirCustomHeaderName;
        refs.settingFhirCustomHeaderValue.value = state.settings.fhirCustomHeaderValue;
        refs.settingFhirBearerTokenRow.classList.toggle('hidden', state.settings.fhirAuthType !== 'bearer');
        refs.settingFhirCustomHeaderNameRow.classList.toggle('hidden', state.settings.fhirAuthType !== 'custom-header');
        refs.settingFhirCustomHeaderValueRow.classList.toggle('hidden', state.settings.fhirAuthType !== 'custom-header');
        refs.settingFhirBearerTokenStatus.textContent = maskSecretForDisplay(state.settings.fhirBearerToken);
        refs.settingFhirCustomHeaderValueStatus.textContent = maskSecretForDisplay(state.settings.fhirCustomHeaderValue);
        refs.settingFhirBearerTokenStatus.title = getFhirCredentialStorageMessage();
        refs.settingFhirCustomHeaderValueStatus.title = getFhirCredentialStorageMessage();
        refs.settingSummaryAvailability.textContent = hasAiSummarySupport()
          ? (hasPromptApiSupport()
            ? 'Prompt API is available through the browser. Summaries run on-device with no API key.'
            : 'Prompt API is unavailable, but the Summarizer API is available as a fallback.')
          : 'Prompt API and Summarizer API are unavailable in this browser, so summary generation is unavailable here.';
        refs.settingSecureStorageEnabled.disabled = hasLockedSessionEnvelope();
        refs.settingSecureStorageMode.disabled = hasLockedSessionEnvelope() || !state.settings.secureStorageEnabled;
        refs.settingAutoLockMinutes.disabled = hasLockedSessionEnvelope() || !state.settings.secureStorageEnabled;
        refs.settingSecureStorageStatus.textContent = getSecureStorageStatusText();
        refs.settingSecureStorageStatus.classList.toggle('warning', Boolean(getSecureStorageWarningMessage()));
        refs.settingSecureStorageHelp.textContent = getSecureStorageHelpText();
        refs.openSecureStorageModalBtn.textContent = isSessionUiLocked() ? 'Unlock app' : (hasLockedSessionEnvelope() ? 'Unlock session history' : 'Unlock secure local storage');
        refs.openSecureStorageModalBtn.disabled = (!canPromptForSecureStoragePassphrase() && !isSessionUiLocked()) || (!state.settings.secureStorageEnabled && !hasLockedSessionEnvelope());
        refs.lockSecureStorageBtn.disabled = !state.settings.secureStorageEnabled || isSessionUiLocked();
        renderSupportBanner(refs.settingsSecurityMessage, getSecureStorageWarningMessage());
        renderSupportBanner(refs.fhirEndpointStatusMessage, getFhirEndpointStatusMessage());
        renderSecureStorageModal();
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

      function renderDocumentTemplateEditor() {
        const templates = getDocumentTemplates();
        if (!templates.length) {
          refs.documentTemplateList.innerHTML = '<div class="empty-state small">No document templates yet. Add one above to enable document generation.</div>';
          return;
        }
        refs.documentTemplateList.innerHTML = templates.map((template) => '<div class="list-editor-item" data-document-template-id="' + escapeAttribute(template.id) + '"><div class="field"><label>Document type</label><input class="document-template-name" value="' + escapeAttribute(template.name) + '" /></div><div class="field"><label>Instructions</label><textarea class="document-template-instructions" rows="6">' + escapeHtml(template.instructions) + '</textarea></div><div class="inline-actions"><button class="btn small" type="button" data-action="save-document-template" data-document-template-id="' + escapeAttribute(template.id) + '">Save</button><button class="btn small danger" type="button" data-action="delete-document-template" data-document-template-id="' + escapeAttribute(template.id) + '">Delete</button></div></div>').join('');
      }

      function renderCustomisationForm() {
        refs.customOrgName.value = state.customisation.organisationName || '';
        refs.customBrandColor.value = state.customisation.brandingColor || '#2f7df6';
        refs.customBrandColorValue.textContent = (state.customisation.brandingColor || '#2f7df6').toUpperCase();
        refs.customDefaultConsultationType.value = state.customisation.defaultConsultationType || '';
        refs.customDefaultPractitionerName.value = getDefaultPractitionerName();
        applyThemeAndBranding();
        renderMacroEditor();
        renderCustomTagEditor();
        renderDocumentTemplateEditor();
        renderMacroBar();
        renderConsultationTagSelector();
      }

      async function handleSecureStorageToggleChange(enabled) {
        if (hasLockedSessionEnvelope()) {
          refs.settingSecureStorageEnabled.checked = true;
          showToast('Unlock the existing encrypted session history before changing secure storage settings.', 'warning', 4200);
          renderSettingsForm();
          return;
        }

        if (enabled) {
          if (!isWebCryptoAvailable()) {
            state.settings.secureStorageEnabled = false;
            saveSettings();
            renderSettingsForm();
            showToast('Web Crypto API is unavailable in this browser, so secure local storage cannot be enabled here.', 'error', 4200);
            return;
          }

          state.settings.secureStorageEnabled = true;
          if (state.settings.secureStorageMode === 'session') {
            try {
              await ensureRuntimeSessionKey();
            } catch (error) {
              state.settings.secureStorageEnabled = false;
              saveSettings();
              renderSettingsForm();
              showToast(normaliseWhitespace(error && error.message ? error.message : String(error || 'Unable to enable secure local storage.')), 'error', 4200);
              return;
            }
          } else {
            clearSecureStorageAccess();
          }

          saveSettings();
          applySettingsChange();
          state.sessionLock.isLocked = false;

          if (state.settings.secureStorageMode === 'passphrase') {
            openSecureStorageModal();
            showToast('Enter a passphrase to unlock secure local storage for this tab.', 'info', 3200);
            return;
          }

          await persistSessions();
          showToast('Secure local storage enabled.', 'success', 2400);
          return;
        }

        state.settings.secureStorageEnabled = false;
        state.sessionLock.isLocked = false;
        state.sessionLock.lockedReason = null;
        clearSecureStorageAccess();
        saveSettings();
        applySettingsChange();
        await persistSessions();
        showToast('Secure local storage disabled. Future saves use standard local storage.', 'warning', 3200);
      }

      async function handleSecureStorageModeChange(nextMode) {
        if (hasLockedSessionEnvelope()) {
          renderSettingsForm();
          showToast('Unlock the existing encrypted session history before changing unlock mode.', 'warning', 4200);
          return;
        }

        state.settings.secureStorageMode = nextMode === 'session' ? 'session' : 'passphrase';
        clearSecureStorageAccess();
        saveSettings();
        applySettingsChange();

        if (!state.settings.secureStorageEnabled) return;

        if (state.settings.secureStorageMode === 'session') {
          try {
            await ensureRuntimeSessionKey();
            await persistSessions();
            renderSettingsForm();
            showToast('Secure local storage now uses a session-only key for this tab.', 'success', 2400);
          } catch (error) {
            showToast(normaliseWhitespace(error && error.message ? error.message : String(error || 'Unable to switch secure storage mode.')), 'error', 4200);
          }
          return;
        }

        openSecureStorageModal();
        showToast('Enter a passphrase to continue using secure local storage.', 'info', 3200);
      }

      function lockSecureStorageNow(showFeedback = true) {
        lockSessionUi('manual', { showFeedback });
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
        renderConsultationSummary();
        renderConsultationReviewMode();
        renderConsultationDocuments();
        renderConsultationTranscript();
        renderDocumentsTab();
        renderHistory();
        resetAutoSaveInterval();
        armSecureStorageAutoLockTimer();
        if (!state.settings.interimResults) state.interimText = '';
        renderInterim();
        if (state.speechProvider) state.speechProvider.applyConfig();
      }

      function handleRetentionUpdate() {
        const removedCount = purgeOldSessions();
        if (removedCount > 0) {
          persistSessions();
          renderConsultation();
          renderHistory();
          renderDocumentsTab();
          showToast('Removed ' + removedCount + ' session' + (removedCount === 1 ? '' : 's') + ' due to data retention settings.', 'warning', 4200);
        }
      }

      function transitionSessionStatus(session, nextStatus, options = {}) {
        if (!session) return;
        const now = Date.now();
        const previousStatus = session.status;
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
        if (nextStatus !== previousStatus) {
          if (nextStatus === 'listening' && previousStatus === 'paused') {
            appendAuditEvent(session, 'listening-resumed', 'Listening resumed.', { from: previousStatus, to: nextStatus }, 'user');
          } else if (nextStatus === 'listening') {
            appendAuditEvent(session, 'listening-started', 'Listening started.', { from: previousStatus, to: nextStatus }, 'user');
          } else if (nextStatus === 'paused') {
            appendAuditEvent(session, 'listening-paused', 'Listening paused.', { from: previousStatus, to: nextStatus }, 'user');
          } else if (nextStatus === 'stopped') {
            appendAuditEvent(session, 'listening-stopped', 'Listening stopped.', { from: previousStatus, to: nextStatus }, 'user');
          }
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
        const shouldMerge = shouldMergeTranscriptEntry(lastEntry, now);
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
          renderConsultationSummary();
          renderConsultationDocuments();
          renderConsultationTranscript();
          renderConsultationChrome();
          scrollTranscriptToBottom(refs.transcriptContainer);
        }
        renderDocumentsTab();
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
        const message = code === 'network'
          ? 'Speech recognition was interrupted. ' + describeSpeechRecognitionError(code)
          : describeSpeechRecognitionError(code);
        showToast(message, code === 'network' ? 'warning' : 'error', 4200);
        persistSessions();
      }

      function beginListening() {
        if (!state.supportsSpeech || !state.speechProvider) { showToast('Live speech recognition is unavailable in this browser. Open the file in a supported Chromium browser such as Chrome or Edge.', 'warning', 4200); return; }
        if (state.activeSession && state.activeSession.status === 'paused') { resumeListening(); return; }
        state.interimText = '';
        refs.transcriptSearch.value = '';
        state.transcriptSearch = '';
        let session = state.activeSession;
        let createdSession = false;
        if (!session || session.status === 'stopped' || session.archived) {
          session = createSessionFromConsultation('listening');
          createdSession = true;
        }
        else syncActiveSessionFromForm();
        transitionSessionStatus(session, 'listening', { startClock: false, skipPersist: true });
        if (createdSession) appendAuditEvent(session, 'listening-started', 'Listening started.', { from: 'created', to: 'listening' }, 'user');
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
        generateSessionSummary(state.activeSession.id, { force: false, showFeedback: false });
      }

      function markImportantMoment() {
        if (!state.activeSession) return;
        syncActiveSessionFromForm();
        const now = Date.now();
        state.activeSession.transcriptEntries.push(createTranscriptEntry({ text: '', timestamp: now, isImportantMarker: true, confidence: null, flags: { isImportantMarker: true } }));
        appendAuditEvent(state.activeSession, 'important-marker-added', 'Important moment marker added.', { transcriptEntries: state.activeSession.transcriptEntries.length }, 'user');
        state.activeSession.updatedAt = now;
        upsertSession(state.activeSession);
        renderConsultationSummary();
        renderConsultationTranscript();
        renderConsultationChrome();
        scrollTranscriptToBottom(refs.transcriptContainer);
        if (state.currentTab === 'history' && state.historySelectedSessionId === state.activeSession.id) renderHistoryDetail();
        persistSessionsDebounced();
      }

      async function saveSessionImmediately(showFeedback = true) {
        let session = state.activeSession;
        if (!session) session = createSessionFromConsultation('stopped');
        else {
          syncActiveSessionFromForm();
          if (session.status === 'idle') { session.status = 'stopped'; session.stoppedAt = Date.now(); }
          session.updatedAt = Date.now();
          upsertSession(session);
        }
        if (session && isEphemeralSession(session)) {
          const shouldPersist = window.confirm('This consultation is currently ephemeral and only kept in memory for this tab. Save it to local browser storage now?');
          if (!shouldPersist) {
            renderConsultation();
            if (showFeedback) showToast('Ephemeral consultation kept in memory only.', 'info', 2800);
            return;
          }
          session.ephemeral = false;
          session.updatedAt = Date.now();
          upsertSession(session);
        }
        if (state.settings.secureStorageEnabled && state.settings.secureStorageMode === 'passphrase' && !state.secureStorage.unlocked) {
          openSecureStorageModal();
          if (showFeedback) showToast('Unlock secure local storage before saving this consultation to encrypted history.', 'info', 3200);
          renderConsultation();
          return;
        }
        const didPersist = await persistSessions();
        renderConsultation();
        if (showFeedback && didPersist) showToast('Session saved locally.', 'success');
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
        state.historySelectedAssetId = 'summary';
        renderHistoryList();
        renderHistoryDetail();
      }

      async function duplicateSession(sessionId) {
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
        appendAuditEvent(duplicated, 'session-created', 'Session duplicated from existing record.', { sourceSessionId: original.id }, 'user');
        upsertSession(duplicated);
        state.historySelectedSessionId = duplicated.id;
        state.historyEditMode = false;
        const didPersist = await persistSessions();
        renderHistory();
        if (didPersist) showToast('Session duplicated.', 'success');
      }

      async function toggleArchiveSession(sessionId) {
        const session = findSession(sessionId);
        if (!session) return;
        session.archived = !session.archived;
        session.archivedAt = session.archived ? Date.now() : null;
        appendAuditEvent(session, session.archived ? 'session-archived' : 'session-restored', session.archived ? 'Session archived.' : 'Session restored from archive.', null, 'user');
        session.updatedAt = Date.now();
        upsertSession(session);
        const didPersist = await persistSessions();
        renderHistory();
        if (didPersist) showToast(session.archived ? 'Session archived.' : 'Session restored.', 'success');
      }

      async function deleteSession(sessionId) {
        const session = findSession(sessionId);
        if (!session) return;
        if (!window.confirm('Permanently delete ' + (session.patientName || 'this session') + '? This cannot be undone.')) return;
        appendAuditEvent(session, 'session-deleted', 'Session deleted permanently.', null, 'user');
        clearSessionAuditDebounceState(sessionId);
        if (state.activeSession && state.activeSession.id === sessionId) {
          if (state.speechProvider) state.speechProvider.stop();
          stopTimer();
          state.interimText = '';
        }
        const didPersist = (await removeSessionsByPredicate((item) => item.id === sessionId)).didPersist;
        renderConsultation();
        renderHistory();
        renderDocumentsTab();
        if (didPersist) showToast('Session deleted permanently.', 'success');
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
        else if (tabName === 'documents') renderDocumentsTab();
        else if (tabName === 'settings') renderSettingsForm();
        else if (tabName === 'customisation') renderCustomisationForm();
      }

      function attachEventListeners() {
        document.querySelectorAll('.nav-tab').forEach((button) => button.addEventListener('click', () => switchTab(button.dataset.tab)));
        const consultationInputHandler = debounce(() => {
          if (state.activeSession) {
            syncActiveSessionFromForm();
            renderConsultationChrome();
            renderConsultationReviewMode();
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
        refs.saveSessionBtn.addEventListener('click', async () => { await saveSessionImmediately(true); });
        refs.generateSummaryBtn.addEventListener('click', async () => {
          if (!state.activeSession) return;
          await generateSessionSummary(state.activeSession.id, { force: true });
        });
        refs.extractStructuredBtn.addEventListener('click', async () => {
          if (!state.activeSession) return;
          await refreshSessionStructuredData(state.activeSession.id, { force: true });
        });
        refs.consultationReviewLowConfidenceToggle.addEventListener('click', () => {
          state.reviewMode.consultationLowConfidenceOnly = !state.reviewMode.consultationLowConfidenceOnly;
          renderConsultationReviewMode();
        });
        refs.consultationReviewContainer.addEventListener('click', async (event) => {
          const reviewAction = event.target.closest('[data-review-action]');
          if (reviewAction && state.activeSession) {
            const action = reviewAction.dataset.reviewAction;
            if (action === 'regenerate-summary') {
              await generateSessionSummary(state.activeSession.id, { force: true });
              return;
            }
            if (action === 'extract-structured') {
              await refreshSessionStructuredData(state.activeSession.id, { force: true });
              return;
            }
            if (action === 'open-document') {
              setSelectedDocument(reviewAction.dataset.reviewDocumentId || null);
              switchTab('documents');
              return;
            }
            if (action === 'regenerate-document') {
              const templateId = reviewAction.dataset.reviewTemplateId || '';
              if (!templateId) return;
              await generateSessionDocument(state.activeSession.id, templateId, { openTab: false });
              return;
            }
          }
          const reviewEntry = event.target.closest('[data-review-entry-id]');
          if (reviewEntry && state.activeSession) {
            focusTranscriptEntry(state.activeSession, reviewEntry.dataset.reviewEntryId, reviewEntry.dataset.reviewContext || 'consultation');
            return;
          }
          const reviewQuery = event.target.closest('[data-review-query]');
          if (reviewQuery && state.activeSession) {
            applyReviewTranscriptSearch(state.activeSession, reviewQuery.dataset.reviewQuery, reviewQuery.dataset.reviewContext || 'consultation');
          }
        });
        refs.generateDocumentBtn.addEventListener('click', async () => {
          if (isDocumentGenerationBusy()) {
            showToast(getDocumentGenerationBusyMessage(), 'warning', 2600);
            return;
          }
          if (!state.activeSession) return;
          await generateSessionDocument(state.activeSession.id, refs.consultationDocumentType.value, { openTab: false });
        });
        refs.openDocumentsTabBtn.addEventListener('click', () => {
          if (!canGenerateDocumentsForSession(state.activeSession)) return;
          switchTab('documents');
        });
        refs.consultationDocumentsList.addEventListener('click', (event) => {
          const card = event.target.closest('[data-document-id]');
          if (!card) return;
          setSelectedDocument(card.dataset.documentId);
          switchTab('documents');
        });
        refs.documentsGenerateBtn.addEventListener('click', async () => {
          if (isDocumentGenerationBusy()) {
            showToast(getDocumentGenerationBusyMessage(), 'warning', 2600);
            return;
          }
          const session = getDocumentTargetSession();
          if (!session) return;
          await generateSessionDocument(session.id, refs.documentsTemplateSelect.value, { openTab: true });
        });
        refs.documentsList.addEventListener('click', (event) => {
          const card = event.target.closest('[data-documents-document-id]');
          if (!card) return;
          setSelectedDocument(card.dataset.documentsDocumentId);
          renderDocumentsTab();
        });
        refs.documentPreview.addEventListener('blur', () => {
          const session = getDocumentTargetSession();
          const documentItem = getSelectedSessionDocument(session);
          if (!session || !documentItem) return;
          const sanitized = sanitizeRichTextMarkup(refs.documentPreview.innerHTML);
          if (sanitized === documentItem.content) return;
          documentItem.content = sanitized;
          documentItem.updatedAt = Date.now();
          session.updatedAt = Date.now();
          appendAuditEvent(session, 'document-edited', 'Document content edited.', {
            documentId: documentItem.id,
            templateId: documentItem.templateId,
            title: documentItem.title || documentItem.templateName || 'Document'
          }, 'user');
          upsertSession(session);
          persistSessionsDebounced();
          renderConsultationDocuments();
          renderConsultationReviewMode();
          renderDocumentsTab();
          if (state.currentTab === 'history' && state.historySelectedSessionId === session.id) renderHistoryDetail();
        });
        refs.copyDocumentTextBtn.addEventListener('click', () => {
          const documentItem = getSelectedSessionDocument(getDocumentTargetSession());
          if (!documentItem) return;
          copyToClipboard(getDocumentPreviewText(documentItem)).then(() => showToast('Document text copied to the clipboard.', 'success')).catch(() => showToast('Copy failed in this browser context.', 'error'));
        });
        refs.downloadDocumentBtn.addEventListener('click', () => {
          const session = getDocumentTargetSession();
          const documentItem = getSelectedSessionDocument(session);
          if (!session || !documentItem) return;
          const filename = sanitizeFilenamePart((session.patientName || 'document') + '_' + (documentItem.title || documentItem.templateName || 'document')) + '.html';
          downloadTextFile(filename, documentItem.content, 'text/html;charset=utf-8');
          showToast('Document HTML downloaded.', 'success', 2200);
        });
        refs.copyTranscriptBtn.addEventListener('click', copyCurrentTranscript);
        refs.exportTranscriptBtn.addEventListener('click', exportCurrentTranscript);
        refs.downloadFhirBtn.addEventListener('click', () => {
          if (!state.activeSession) {
            showToast('There is no active session to export.', 'warning');
            return;
          }
          try {
            downloadSessionFhir(state.activeSession);
            showToast('FHIR document downloaded.', 'success');
          } catch (error) {
            showToast('FHIR export failed.', 'error');
          }
        });
        refs.sendFhirBtn.addEventListener('click', async () => {
          if (!state.activeSession) {
            showToast('There is no active session to send.', 'warning');
            return;
          }
          try {
            const result = await sendSessionFhir(state.activeSession);
            showToast('FHIR sent to the configured endpoint as ' + (result.mode === 'composition-only' ? 'Composition JSON.' : 'Bundle JSON.'), 'success', 3200);
          } catch (error) {
            showToast(normaliseWhitespace(error && error.message ? error.message : 'FHIR send failed.'), 'error', 4200);
          }
        });
        refs.historyDownloadFhirBtn.addEventListener('click', () => {
          const session = getSelectedHistorySession();
          if (!session) return;
          try {
            downloadSessionFhir(session);
            showToast('FHIR document downloaded.', 'success');
          } catch (error) {
            showToast('FHIR export failed.', 'error');
          }
        });
        refs.historySendFhirBtn.addEventListener('click', async () => {
          const session = getSelectedHistorySession();
          if (!session) return;
          try {
            const result = await sendSessionFhir(session);
            showToast('FHIR sent to the configured endpoint as ' + (result.mode === 'composition-only' ? 'Composition JSON.' : 'Bundle JSON.'), 'success', 3200);
          } catch (error) {
            showToast(normaliseWhitespace(error && error.message ? error.message : 'FHIR send failed.'), 'error', 4200);
          }
        });
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
        refs.historySaveBtn.addEventListener('click', async () => {
          if (!getSelectedHistorySession()) return;
          const didPersist = await persistSessions();
          if (didPersist) showToast('History changes saved.', 'success');
        });
        refs.settingLocale.addEventListener('change', () => { state.settings.locale = refs.settingLocale.value; applySettingsChange(); });
        refs.settingAutoPunctuation.addEventListener('change', () => { state.settings.autoPunctuation = refs.settingAutoPunctuation.checked; applySettingsChange(); });
        refs.settingInterimResults.addEventListener('change', () => { state.settings.interimResults = refs.settingInterimResults.checked; applySettingsChange(); });
        refs.settingSaveRawTranscript.addEventListener('change', () => { state.settings.saveRawTranscript = refs.settingSaveRawTranscript.checked; applySettingsChange(); });
        refs.settingSecureStorageEnabled.addEventListener('change', async () => { await handleSecureStorageToggleChange(refs.settingSecureStorageEnabled.checked); });
        refs.settingSecureStorageMode.addEventListener('change', async () => { await handleSecureStorageModeChange(refs.settingSecureStorageMode.value); });
        refs.settingAutoLockMinutes.addEventListener('input', () => {
          state.settings.autoLockMinutes = clamp(Number(refs.settingAutoLockMinutes.value) || 0, 0, 240);
          saveSettings();
          renderSettingsForm();
          armSecureStorageAutoLockTimer();
        });
        refs.settingAutoSaveInterval.addEventListener('input', () => { state.settings.autoSaveInterval = clamp(Number(refs.settingAutoSaveInterval.value) || 5, 1, 30); applySettingsChange(); });
        refs.settingTheme.addEventListener('change', () => { state.settings.theme = refs.settingTheme.value === 'dark' ? 'dark' : 'light'; applySettingsChange(); });
        refs.settingDataRetentionDays.addEventListener('input', () => { state.settings.dataRetentionDays = Math.max(0, Number(refs.settingDataRetentionDays.value) || 0); saveSettings(); renderSettingsForm(); handleRetentionUpdate(); });
        refs.settingPurgeOnBrowserClose.addEventListener('change', () => { state.settings.purgeOnBrowserClose = refs.settingPurgeOnBrowserClose.checked; applySettingsChange(); });
        refs.settingEphemeralConsultationMode.addEventListener('change', () => { state.settings.ephemeralConsultationMode = refs.settingEphemeralConsultationMode.checked; applySettingsChange(); });
        refs.purgeOldSessionsNowBtn.addEventListener('click', async () => { await purgeSessionsOlderThanRetentionNow(); });
        refs.deleteArchivedSessionsBtn.addEventListener('click', async () => { await deleteArchivedSessionsNow(); });
        refs.deleteAllSessionsBtn.addEventListener('click', () => { deleteAllSessionsNow(); });
        refs.settingTranscriptFontSize.addEventListener('input', () => { state.settings.transcriptFontSize = clamp(Number(refs.settingTranscriptFontSize.value) || 16, 14, 24); applySettingsChange(); });
        refs.settingLineSpacing.addEventListener('input', () => { state.settings.transcriptLineSpacing = clamp(Number(refs.settingLineSpacing.value) || 1.55, 1.2, 2); applySettingsChange(); });
        refs.settingSummaryPrompt.addEventListener('input', debounce(() => {
          state.settings.summaryPrompt = String(refs.settingSummaryPrompt.value || '').trim() || createDefaultSummaryPrompt();
          saveSettings();
        }, 180));
        refs.settingFhirEndpointUrl.addEventListener('input', debounce(() => {
          state.settings.fhirEndpointUrl = String(refs.settingFhirEndpointUrl.value || '').trim();
          state.integrationStatus.message = '';
          saveSettings();
          renderSettingsForm();
          renderConsultationChrome();
          renderHistoryDetail();
        }, 180));
        refs.settingFhirSendMode.addEventListener('change', () => { state.settings.fhirSendMode = refs.settingFhirSendMode.value === 'composition-only' ? 'composition-only' : 'bundle-json'; applySettingsChange(); });
        refs.settingFhirAuthType.addEventListener('change', () => {
          state.settings.fhirAuthType = ['none', 'bearer', 'custom-header'].includes(refs.settingFhirAuthType.value) ? refs.settingFhirAuthType.value : 'none';
          if (state.settings.fhirAuthType !== 'bearer') state.settings.fhirBearerToken = '';
          if (state.settings.fhirAuthType !== 'custom-header') state.settings.fhirCustomHeaderValue = '';
          state.integrationStatus.message = '';
          applySettingsChange();
        });
        refs.settingFhirBearerToken.addEventListener('input', debounce(() => {
          state.settings.fhirBearerToken = String(refs.settingFhirBearerToken.value || '');
          state.integrationStatus.message = '';
          saveSettings();
          renderSettingsForm();
        }, 180));
        refs.settingFhirCustomHeaderName.addEventListener('input', debounce(() => {
          state.settings.fhirCustomHeaderName = String(refs.settingFhirCustomHeaderName.value || '').trim();
          state.integrationStatus.message = '';
          saveSettings();
          renderSettingsForm();
        }, 180));
        refs.settingFhirCustomHeaderValue.addEventListener('input', debounce(() => {
          state.settings.fhirCustomHeaderValue = String(refs.settingFhirCustomHeaderValue.value || '');
          state.integrationStatus.message = '';
          saveSettings();
          renderSettingsForm();
        }, 180));
        refs.testFhirEndpointBtn.addEventListener('click', async () => { await testFhirEndpointConnection(); });
        refs.customOrgName.addEventListener('input', () => { state.customisation.organisationName = normaliseWhitespace(refs.customOrgName.value) || 'Organisation'; saveCustomisation(); applyThemeAndBranding(); renderConsultation(); });
        refs.customBrandColor.addEventListener('input', () => { state.customisation.brandingColor = refs.customBrandColor.value; saveCustomisation(); applyThemeAndBranding(); renderConsultation(); });
        refs.customDefaultConsultationType.addEventListener('input', () => {
          const previousDefault = state.customisation.defaultConsultationType;
          state.customisation.defaultConsultationType = normaliseWhitespace(refs.customDefaultConsultationType.value) || 'General consultation';
          if (!state.activeSession && (!refs.consultationType.value || refs.consultationType.value === previousDefault)) refs.consultationType.value = state.customisation.defaultConsultationType;
          saveCustomisation();
        });
        refs.customDefaultPractitionerName.addEventListener('input', () => {
          const previousDefault = getDefaultPractitionerName();
          state.customisation.defaultPractitionerName = normaliseWhitespace(refs.customDefaultPractitionerName.value);
          if (!state.activeSession && (!refs.clinicianName.value || refs.clinicianName.value === previousDefault)) refs.clinicianName.value = state.customisation.defaultPractitionerName;
          saveCustomisation();
        });
        refs.refreshSplashStatusBtn.addEventListener('click', () => { refreshApiCapabilityChecks(); });
        refs.continueFromSplashBtn.addEventListener('click', () => { saveSplashProfileAndContinue(); });
        refs.openApiHelpBtn.addEventListener('click', () => { openApiHelpModal(); });
        refs.closeApiHelpBtn.addEventListener('click', () => { closeApiHelpModal(); });
        refs.openSecureStorageModalBtn.addEventListener('click', () => { openSecureStorageModal(); });
        refs.lockSecureStorageBtn.addEventListener('click', () => { lockSecureStorageNow(true); });
        refs.closeSecureStorageModalBtn.addEventListener('click', () => { closeSecureStorageModal(); });
        refs.secureStorageCancelBtn.addEventListener('click', () => { closeSecureStorageModal(); });
        refs.unlockSecureStorageBtn.addEventListener('click', async () => {
          try {
            await unlockCurrentSession();
            if (state.settings.secureStorageEnabled) await persistSessions();
          } catch (error) {
            state.secureStorage.modalError = normaliseWhitespace(error && error.message ? error.message : String(error || 'Unable to unlock encrypted session history.'));
            renderSecureStorageModal();
          }
        });
        refs.secureStoragePassphraseInput.addEventListener('keydown', async (event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          refs.unlockSecureStorageBtn.click();
        });
        refs.reopenSplashBtn.addEventListener('click', () => { openSplashScreen(); });
        refs.apiHelpModal.addEventListener('click', (event) => {
          if (event.target === refs.apiHelpModal) closeApiHelpModal();
        });
        refs.secureStorageModal.addEventListener('click', (event) => {
          if (event.target === refs.secureStorageModal) closeSecureStorageModal();
        });
        refs.closeDestructiveConfirmBtn.addEventListener('click', () => { closeDestructiveConfirmModal(); });
        refs.cancelDestructiveConfirmBtn.addEventListener('click', () => { closeDestructiveConfirmModal(); });
        refs.confirmDestructiveActionBtn.addEventListener('click', async () => { await executeDestructiveConfirmAction(); });
        refs.destructiveConfirmInput.addEventListener('keydown', async (event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          await executeDestructiveConfirmAction();
        });
        refs.destructiveConfirmModal.addEventListener('click', (event) => {
          if (event.target === refs.destructiveConfirmModal) closeDestructiveConfirmModal();
        });
        refs.splashOverlay.addEventListener('click', (event) => {
          if (event.target === refs.splashOverlay && state.settings.splashDismissedAt) closeSplashScreen();
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
        refs.addDocumentTemplateBtn.addEventListener('click', () => {
          const name = normaliseWhitespace(refs.newDocumentTemplateName.value);
          const instructions = String(refs.newDocumentTemplateInstructions.value || '').trim();
          if (!name || !instructions) { showToast('Add both a document type name and instructions.', 'warning'); return; }
          state.customisation.documentTemplates.unshift({ id: uid('doctype'), name, instructions });
          refs.newDocumentTemplateName.value = '';
          refs.newDocumentTemplateInstructions.value = '';
          saveCustomisation();
          renderCustomisationForm();
          renderConsultationDocuments();
          renderDocumentsTab();
          showToast('Document type added.', 'success');
        });
        refs.documentTemplateList.addEventListener('click', (event) => {
          const button = event.target.closest('[data-action]');
          if (!button) return;
          const action = button.dataset.action;
          const templateId = button.dataset.documentTemplateId;
          const item = button.closest('[data-document-template-id]');
          const templateIndex = state.customisation.documentTemplates.findIndex((template) => template.id === templateId);
          if (templateIndex === -1) return;
          if (action === 'save-document-template' && item) {
            const name = normaliseWhitespace(item.querySelector('.document-template-name').value);
            const instructions = String(item.querySelector('.document-template-instructions').value || '').trim();
            if (!name || !instructions) { showToast('Document type name and instructions cannot be empty.', 'warning'); return; }
            state.customisation.documentTemplates[templateIndex].name = name;
            state.customisation.documentTemplates[templateIndex].instructions = instructions;
            saveCustomisation();
            renderCustomisationForm();
            renderConsultationDocuments();
            renderDocumentsTab();
            showToast('Document template updated.', 'success');
          }
          if (action === 'delete-document-template') {
            state.customisation.documentTemplates.splice(templateIndex, 1);
            saveCustomisation();
            renderCustomisationForm();
            renderConsultationDocuments();
            renderDocumentsTab();
            showToast('Document template deleted.', 'success');
          }
        });
        ['pointerdown', 'touchstart', 'mousedown'].forEach((eventName) => {
          document.addEventListener(eventName, () => { recordSessionActivity(); }, { passive: true });
        });
        document.addEventListener('keydown', () => { recordSessionActivity(); });
        window.addEventListener('beforeunload', () => {
          if (state.activeSession) syncActiveSessionFromForm();
          if (state.settings.purgeOnBrowserClose) {
            clearSessionStorageBestEffort();
            return;
          }
          if (state.activeSession || state.sessions.some((session) => isEphemeralSession(session))) persistSessions();
        });
        window.addEventListener('pagehide', () => {
          if (!state.settings.purgeOnBrowserClose) return;
          clearSessionStorageBestEffort();
        });
        document.addEventListener('visibilitychange', () => {
          if (document.hidden && state.activeSession) { syncActiveSessionFromForm(); persistSessions(); }
          if (!document.hidden) recordSessionActivity();
          else armSecureStorageAutoLockTimer();
        });
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
        state.sessionLock.unlockMode = getEffectiveSecureStorageMode();
        state.sessionLock.lastActivityAt = Date.now();
        if (state.settings.secureStorageEnabled && (hasLockedSessionEnvelope() || state.sessions.length || state.activeSession)) {
          state.sessionLock.isLocked = true;
          state.sessionLock.lockedReason = hasLockedSessionEnvelope()
            ? (state.secureStorage.lockedEnvelope.mode === 'session' ? 'session-key-unavailable' : 'passphrase-required')
            : 'startup';
        }
        state.showSplash = !state.settings.splashDismissedAt;
      }

      async function init() {
        applyThemeAndBranding();
        initialiseSpeechProvider();
        await loadSessions();
        const removedCount = purgeOldSessions();
        if (removedCount > 0) await persistSessions();
        initialiseStateFromStorage();
        renderSettingsForm();
        renderCustomisationForm();
        renderConsultation();
        renderHistory();
        resetAutoSaveInterval();
        attachEventListeners();
        renderDestructiveConfirmModal();
        renderSecureStorageModal();
        renderSplashScreen();
        refreshApiCapabilityChecks();
        if (state.activeSession && state.activeSession.status === 'listening' && state.activeSession.lastStartedSegmentAt) ensureTimerRunning();
        if (removedCount > 0) showToast('Removed ' + removedCount + ' old session' + (removedCount === 1 ? '' : 's') + ' based on retention settings.', 'warning', 4200);
        if (hasLockedSessionEnvelope()) showToast(getLockedSessionPersistMessage(), 'warning', 5200);
      }

      window.__scribeDebugCapabilities = async function () {
        return {
          speechSupported: Boolean(state.supportsSpeech),
          languageModelPresent: Boolean(getLanguageModelApi()),
          summarizerPresent: Boolean(getSummarizerApi()),
          promptAvailability: await getPromptApiAvailability(),
          summarizerAvailability: await getSummarizerAvailability()
        };
      };

      init().catch((error) => {
        console.error(error);
        showToast('The app could not finish initialising local session storage.', 'error', 5200);
      });
    })();
