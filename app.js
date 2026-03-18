

    (() => {
      'use strict';

      const STORAGE_KEYS = {
        sessions: 'ai_medical_scribe_sessions_v1',
        settings: 'ai_medical_scribe_settings_v1',
        customisation: 'ai_medical_scribe_customisation_v1'
      };

      const FHIR_BUNDLE_IDENTIFIER_SYSTEM = 'urn:findonsoftware:ai-medical-scribe:bundle';
      const FHIR_DOCUMENT_LANGUAGE = 'en-GB';
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
          items: parsed && parsed[heading] && parsed[heading].length ? parsed[heading].slice() : ['Not stated']
        }));
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

      function buildSessionFhirBundle(session) {
        if (!session) throw new Error('Session is required for FHIR export.');

        const sessionId = String(session.id || uid('session'));
        const patientName = normaliseWhitespace(session.patientName || '');
        const clinicianName = normaliseWhitespace(session.clinicianName || '');
        const organisationName = normaliseWhitespace(state.customisation.organisationName || '') || 'Unknown organisation';
        const consultationType = normaliseWhitespace(session.consultationType || '') || 'Consultation';
        const transcriptText = buildTranscriptPlainText(session) || 'No transcript recorded.';
        const manualNotes = String(session.manualNotes || '').trim() || 'No manual notes.';
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
        const patientFullUrl = 'urn:uuid:patient-' + sessionId;
        const practitionerFullUrl = 'urn:uuid:practitioner-' + sessionId;
        const organizationFullUrl = 'urn:uuid:organization-' + sessionId;
        const encounterFullUrl = 'urn:uuid:encounter-' + sessionId;
        const transcriptDocFullUrl = 'urn:uuid:docref-transcript-' + sessionId;
        const manualNotesDocFullUrl = 'urn:uuid:docref-manual-notes-' + sessionId;
        const authorReference = clinicianName ? practitionerFullUrl : organizationFullUrl;
        const subjectReference = patientName ? patientFullUrl : undefined;
        const generatedDocuments = Array.isArray(session.documents) ? session.documents : [];
        const soapSections = buildSoapSectionsFromSession(session);

        const organization = {
          resourceType: 'Organization',
          id: 'organization-' + sessionId,
          name: organisationName
        };

        const practitioner = clinicianName ? {
          resourceType: 'Practitioner',
          id: 'practitioner-' + sessionId,
          name: [{ text: clinicianName }]
        } : null;

        const patient = patientName ? {
          resourceType: 'Patient',
          id: 'patient-' + sessionId,
          name: [{ text: patientName }]
        } : null;

        const encounter = simplifyFhirObject({
          resourceType: 'Encounter',
          id: 'encounter-' + sessionId,
          status: encounterStatusMap[session.status] || 'planned',
          class: {
            system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
            code: 'AMB',
            display: 'ambulatory'
          },
          type: consultationType ? [{ text: consultationType }] : undefined,
          subject: subjectReference ? { reference: subjectReference } : undefined,
          participant: clinicianName ? [{ individual: { reference: practitionerFullUrl } }] : undefined,
          period: simplifyFhirObject({
            start: encounterStart,
            end: encounterEnd
          })
        });

        const transcriptDocumentReference = simplifyFhirObject({
          resourceType: 'DocumentReference',
          id: 'docref-transcript-' + sessionId,
          status: 'current',
          docStatus,
          type: { text: 'Consultation transcript' },
          subject: subjectReference ? { reference: subjectReference } : undefined,
          author: [{ reference: authorReference }],
          date: compositionDate,
          content: [{
            attachment: {
              contentType: 'text/plain; charset=utf-8',
              language: FHIR_DOCUMENT_LANGUAGE,
              title: 'Consultation transcript',
              data: base64EncodeUtf8(transcriptText),
              creation: compositionDate
            }
          }],
          context: {
            encounter: [{ reference: encounterFullUrl }]
          }
        });

        const manualNotesDocumentReference = simplifyFhirObject({
          resourceType: 'DocumentReference',
          id: 'docref-manual-notes-' + sessionId,
          status: 'current',
          docStatus,
          type: { text: 'Manual notes' },
          subject: subjectReference ? { reference: subjectReference } : undefined,
          author: [{ reference: authorReference }],
          date: compositionDate,
          content: [{
            attachment: {
              contentType: 'text/plain; charset=utf-8',
              language: FHIR_DOCUMENT_LANGUAGE,
              title: 'Manual notes',
              data: base64EncodeUtf8(manualNotes),
              creation: compositionDate
            }
          }],
          context: {
            encounter: [{ reference: encounterFullUrl }]
          }
        });

        const generatedDocumentEntries = generatedDocuments.map((documentItem) => {
          const fullUrl = 'urn:uuid:docref-generated-' + documentItem.id;
          const documentDate = toIsoInstant(documentItem.updatedAt || documentItem.createdAt || Date.now());
          const resource = simplifyFhirObject({
            resourceType: 'DocumentReference',
            id: 'docref-generated-' + documentItem.id,
            status: 'current',
            docStatus,
            type: { text: documentItem.templateName || 'Generated document' },
            subject: subjectReference ? { reference: subjectReference } : undefined,
            author: [{ reference: authorReference }],
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
              encounter: [{ reference: encounterFullUrl }]
            }
          });
          return { fullUrl, resource, documentItem };
        });

        const compositionSections = soapSections.map((section) => ({
          title: section.title,
          text: {
            status: 'generated',
            div: toFhirXhtmlDivFromPlainText(section.items.map((item) => '- ' + item).join('\n'))
          }
        }));

        compositionSections.push({
          title: 'Manual Notes',
          text: {
            status: 'generated',
            div: toFhirXhtmlDivFromPlainText(manualNotes)
          },
          entry: [{ reference: manualNotesDocFullUrl }]
        });

        compositionSections.push({
          title: 'Transcript',
          text: {
            status: 'generated',
            div: toFhirXhtmlDivFromPlainText(transcriptText)
          },
          entry: [{ reference: transcriptDocFullUrl }]
        });

        compositionSections.push({
          title: 'Generated Documents',
          text: {
            status: 'generated',
            div: generatedDocumentEntries.length
              ? toFhirXhtmlDivFromPlainText(generatedDocumentEntries.map((item) => '- ' + (item.documentItem.title || item.documentItem.templateName || 'Generated document')).join('\n'))
              : toFhirXhtmlDivFromPlainText('No generated documents.')
          },
          entry: generatedDocumentEntries.length ? generatedDocumentEntries.map((item) => ({ reference: item.fullUrl })) : undefined
        });

        const composition = simplifyFhirObject({
          resourceType: 'Composition',
          id: 'composition-' + sessionId,
          status: compositionStatus,
          type: deepClone(FHIR_COMPOSITION_TYPE),
          subject: subjectReference ? { reference: subjectReference } : undefined,
          encounter: { reference: encounterFullUrl },
          date: compositionDate,
          author: [{ reference: authorReference }],
          title: consultationType + ' for ' + (patientName || 'Unnamed patient'),
          custodian: { reference: organizationFullUrl },
          section: compositionSections
        });

        const entries = [
          { fullUrl: 'urn:uuid:composition-' + sessionId, resource: composition },
          patient ? { fullUrl: patientFullUrl, resource: patient } : null,
          practitioner ? { fullUrl: practitionerFullUrl, resource: practitioner } : null,
          { fullUrl: organizationFullUrl, resource: organization },
          { fullUrl: encounterFullUrl, resource: encounter },
          { fullUrl: transcriptDocFullUrl, resource: transcriptDocumentReference },
          { fullUrl: manualNotesDocFullUrl, resource: manualNotesDocumentReference }
        ].filter(Boolean);

        generatedDocumentEntries.forEach((entry) => {
          entries.push({ fullUrl: entry.fullUrl, resource: entry.resource });
        });

        return {
          resourceType: 'Bundle',
          id: 'bundle-' + sessionId,
          identifier: {
            system: FHIR_BUNDLE_IDENTIFIER_SYSTEM,
            value: sessionId
          },
          type: 'document',
          timestamp: compositionDate,
          entry: entries
        };
      }

      function downloadSessionFhir(session) {
        const bundle = buildSessionFhirBundle(session);
        const filename = sanitizeFilenamePart(session.patientName || 'session') + '_' + (toLocalDateInputValue(session.startedAt || session.createdAt || Date.now()) || 'session') + '_fhir.json';
        downloadTextFile(filename, JSON.stringify(bundle, null, 2), 'application/fhir+json;charset=utf-8');
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
          provider: overrides.provider || 'webkitSpeechRecognition',
          summary: String(overrides.summary || ''),
          summaryStatus,
          summaryUpdatedAt: typeof overrides.summaryUpdatedAt === 'number' ? overrides.summaryUpdatedAt : null,
          summaryError: String(overrides.summaryError || ''),
          summaryPrompt: String(overrides.summaryPrompt || ''),
          summarySignature: String(overrides.summarySignature || ''),
          documents: Array.isArray(overrides.documents) ? overrides.documents.map((documentItem) => createSessionDocument(documentItem)) : []
        };
      }

      function normaliseSession(rawSession) {
        const session = createSession(rawSession || {});
        session.transcriptEntries = (Array.isArray(rawSession && rawSession.transcriptEntries) ? rawSession.transcriptEntries : []).map((entry) => createTranscriptEntry(entry));
        session.documents = (Array.isArray(rawSession && rawSession.documents) ? rawSession.documents : []).map((documentItem) => createSessionDocument(documentItem));
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
        merged.summaryPrompt = String(merged.summaryPrompt || '').trim() || createDefaultSummaryPrompt();
        merged.splashDismissedAt = typeof merged.splashDismissedAt === 'number' ? merged.splashDismissedAt : null;
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
        historySelectedAssetId: 'summary',
        selectedDocumentId: null,
        documentGenerationRequest: null,
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
        lastPersistedAt: null
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
        manualNotes: $('manualNotes'),
        statusPill: $('statusPill'),
        sessionTimer: $('sessionTimer'),
        speechSupportMessage: $('speechSupportMessage'),
        transcriptEditHint: $('transcriptEditHint'),
        transcriptContainer: $('transcriptContainer'),
        interimContainer: $('interimContainer'),
        interimText: $('interimText'),
        consultationSummaryCard: $('consultationSummaryCard'),
        consultationSummary: $('consultationSummary'),
        consultationSummaryMeta: $('consultationSummaryMeta'),
        generateSummaryBtn: $('generateSummaryBtn'),
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
        historyDetail: $('historyDetail'),
        historyEditToggle: $('historyEditToggle'),
        historySaveBtn: $('historySaveBtn'),
        historyDownloadFhirBtn: $('historyDownloadFhirBtn'),
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
        settingSummaryPrompt: $('settingSummaryPrompt'),
        settingSummaryAvailability: $('settingSummaryAvailability'),
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

      function applyGeneratedSummary(sessionId, requestToken, summaryText, promptTemplate, transcriptSource) {
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
        upsertSession(refreshedSession);
        persistSessions();
        renderSummaryViewsForSession(refreshedSession.id);
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
        const session = state.activeSession;
        const canShow = canGenerateDocumentsForSession(session);
        refs.consultationSummaryCard.classList.toggle('hidden', !canShow);
        refs.consultationSummaryMeta.textContent = getSummaryMetaText(session);
        refs.consultationSummary.innerHTML = buildSummaryPanelHtml(session);
        updateSummaryButton(refs.generateSummaryBtn, session);
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
        const allowedTags = new Set(['A', 'B', 'BLOCKQUOTE', 'BR', 'DIV', 'EM', 'H1', 'H2', 'H3', 'H4', 'HR', 'I', 'LI', 'OL', 'P', 'SPAN', 'STRONG', 'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'U', 'UL']);
        const template = document.createElement('template');
        template.innerHTML = String(markup || '');

        const sanitizeNode = (node) => {
          if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent || '');
          if (node.nodeType !== Node.ELEMENT_NODE) return document.createDocumentFragment();

          if (!allowedTags.has(node.tagName)) {
            const fragment = document.createDocumentFragment();
            Array.from(node.childNodes).forEach((childNode) => fragment.appendChild(sanitizeNode(childNode)));
            return fragment;
          }

          const element = document.createElement(node.tagName.toLowerCase());
          if (node.tagName === 'A') {
            const href = String(node.getAttribute('href') || '');
            if (/^(https?:|mailto:|tel:)/i.test(href)) {
              element.setAttribute('href', href);
              element.setAttribute('target', '_blank');
              element.setAttribute('rel', 'noopener noreferrer');
            }
          }
          Array.from(node.childNodes).forEach((childNode) => element.appendChild(sanitizeNode(childNode)));
          return element;
        };

        const output = document.createElement('div');
        Array.from(template.content.childNodes).forEach((childNode) => output.appendChild(sanitizeNode(childNode)));
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
          applyGeneratedSummary(session.id, requestToken, summaryText, promptTemplate, transcriptSource);
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
        state.selectedDocumentId = null;
        state.consultationDraftTags = formValues.tags.slice();
        upsertSession(session);
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
        refs.speechSupportMessage.textContent = 'Speech recognition is not supported in this browser. Open this file in a supported Chromium browser such as Chrome or Edge to use live transcription. Manual notes, session saving, history, settings, and customisation still work.';
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
        refs.downloadFhirBtn.disabled = !state.activeSession;
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
        if (state.activeSession && state.activeSession.id === session.id) {
          renderConsultationChrome();
          renderConsultationSummary();
        }
        if (state.currentTab === 'history' && state.historySelectedSessionId === session.id) renderHistoryDetail();
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
        renderConsultationSummary();
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
        const summaryButton = detailRoot.querySelector('#historyGenerateSummaryBtn');
        if (summaryButton) {
          summaryButton.addEventListener('click', async () => {
            await generateSessionSummary(session.id, { force: true });
          });
        }
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
        const session = getSelectedHistorySession();
        refs.historyEditToggle.disabled = !session;
        refs.historySaveBtn.disabled = !session;
        refs.historyDownloadFhirBtn.disabled = !session;
        refs.historyDetailHint.textContent = session ? 'Review transcript, notes, metadata, and tags for the selected session.' : 'Select a session to review transcript and notes.';
        refs.historyEditToggle.textContent = state.historyEditMode ? 'Read Mode' : 'Edit Mode';
        if (!session) {
          refs.historyDetail.innerHTML = '<div class="empty-state">Select a session from the list to open its transcript and notes.</div>';
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
          '<div class="detail-block"><div class="detail-header-row"><div><h4 style="margin:0;">Manual notes</h4><div class="subtle-note">Editable when history detail is in edit mode.</div></div></div>' + (editable ? '<textarea id="historyNotesEditor" class="manual-notes" style="min-height:140px;">' + escapeHtml(session.manualNotes || '') + '</textarea>' : '<div class="note-preview">' + escapeHtml(session.manualNotes || 'No manual notes.').replace(/\n/g, '<br>') + '</div>') + '</div>' +
          '<div class="detail-block"><div class="detail-header-row"><div><h4 style="margin:0;">Session documents</h4><div class="subtle-note" id="historyDocumentMeta"></div></div><div class="inline-actions"><div class="field" style="margin:0; min-width:220px;"><label class="label" for="historySessionAssetSelect">Show document</label><select id="historySessionAssetSelect"></select></div>' + (canShowDocuments ? '<div class="field" style="margin:0; min-width:220px;"><label class="label" for="historyDocumentTemplateSelect">Generate type</label><select id="historyDocumentTemplateSelect"></select></div><button class="btn small secondary" type="button" id="historyGenerateDocumentBtn">Generate Document</button>' : '') + '<button class="btn small" type="button" id="historyGenerateSummaryBtn">Generate Summary</button></div></div><div class="summary-output" id="historyDocumentContainer"></div></div>' +
          '<div class="detail-block"><div class="detail-header-row"><div><h4 style="margin:0;">Transcript</h4><div class="subtle-note">' + (editable && !state.historyDetailSearch ? 'Stopped transcripts can be corrected inline.' : 'Search to filter transcript segments.') + '</div></div><input id="historyDetailSearch" class="search-input" type="search" placeholder="Search within this transcript..." value="' + escapeAttribute(state.historyDetailSearch || '') + '" /></div><div class="transcript-container history-transcript" id="historyTranscriptContainer"></div></div>';
        renderHistoryTags(detail.querySelector('#historyTagList'), session, editable);
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
          const entry = session.transcriptEntries.find((item) => item.id === entryId);
          if (!entry) return;
          entry.text = newText;
          entry.lastUpdatedAt = Date.now();
          session.updatedAt = Date.now();
          upsertSession(session);
          syncConsultationViewForSession(session);
          persistSessionsDebounced();
          renderHistoryDetail();
        } });
        renderDocumentsTab();
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
        refs.settingSummaryPrompt.value = getSummaryPromptValue();
        refs.settingSummaryAvailability.textContent = hasAiSummarySupport()
          ? (hasPromptApiSupport()
            ? 'Prompt API is available through the browser. Summaries run on-device with no API key.'
            : 'Prompt API is unavailable, but the Summarizer API is available as a fallback.')
          : 'Prompt API and Summarizer API are unavailable in this browser, so summary generation is unavailable here.';
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
        renderConsultationDocuments();
        renderConsultationTranscript();
        renderDocumentsTab();
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
        const messageMap = {
          'not-allowed': 'Microphone access was blocked. Allow microphone access in the browser and try again.',
          'service-not-allowed': 'Speech recognition service access was blocked by the browser.',
          'audio-capture': 'No microphone input was found. Check the selected device and permissions.',
          'network': 'Speech recognition was interrupted. The session remains available.',
          'language-not-supported': 'The selected speech locale is not supported in this browser.'
        };
        showToast(messageMap[code] || ('Speech recognition error: ' + code + '.'), code === 'network' ? 'warning' : 'error', 4200);
        persistSessions();
      }

      function beginListening() {
        if (!state.supportsSpeech || !state.speechProvider) { showToast('Live speech recognition is unavailable in this browser. Open the file in a supported Chromium browser such as Chrome or Edge.', 'warning', 4200); return; }
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
        generateSessionSummary(state.activeSession.id, { force: false, showFeedback: false });
      }

      function markImportantMoment() {
        if (!state.activeSession) return;
        syncActiveSessionFromForm();
        const now = Date.now();
        state.activeSession.transcriptEntries.push(createTranscriptEntry({ text: '', timestamp: now, isImportantMarker: true, confidence: null, flags: { isImportantMarker: true } }));
        state.activeSession.updatedAt = now;
        upsertSession(state.activeSession);
        renderConsultationSummary();
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
        state.historySelectedAssetId = 'summary';
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
        refs.generateSummaryBtn.addEventListener('click', async () => {
          if (!state.activeSession) return;
          await generateSessionSummary(state.activeSession.id, { force: true });
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
          documentItem.content = sanitizeRichTextMarkup(refs.documentPreview.innerHTML);
          documentItem.updatedAt = Date.now();
          session.updatedAt = Date.now();
          upsertSession(session);
          persistSessionsDebounced();
          renderConsultationDocuments();
          renderDocumentsTab();
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
        refs.settingSummaryPrompt.addEventListener('input', debounce(() => {
          state.settings.summaryPrompt = String(refs.settingSummaryPrompt.value || '').trim() || createDefaultSummaryPrompt();
          saveSettings();
        }, 180));
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
        refs.reopenSplashBtn.addEventListener('click', () => { openSplashScreen(); });
        refs.apiHelpModal.addEventListener('click', (event) => {
          if (event.target === refs.apiHelpModal) closeApiHelpModal();
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
        state.showSplash = !state.settings.splashDismissedAt;
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
        renderSplashScreen();
        refreshApiCapabilityChecks();
        if (state.activeSession && state.activeSession.status === 'listening' && state.activeSession.lastStartedSegmentAt) ensureTimerRunning();
        if (removedCount > 0) showToast('Removed ' + removedCount + ' old session' + (removedCount === 1 ? '' : 's') + ' based on retention settings.', 'warning', 4200);
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

      init();
    })();
