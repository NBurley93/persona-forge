// Persona Forge — a SillyTavern extension for designing personas with the AI.
// The persona lives as an XML document shaped by a user-editable template. The model fills the
// template from a concept, then the user iterates: free-text refinements, per-field rerolls, manual
// edits, and field locks that survive every regeneration.

const MODULE = 'personaForge';
const LOG_LIMIT = 100;

const DEFAULT_TEMPLATE = `<character_name>
    <personal_attributes>
        <name></name>
        <age></age>
        <voice></voice>
    </personal_attributes>
    <physical_attributes>
        <hair>
            <head>
                <color></color>
                <style></style>
            </head>
            <facial>
                <color></color>
                <style></style>
            </facial>
            <body>
                <color></color>
                <style></style>
            </body>
        </hair>
        <skin>
            <tone></tone>
            <blemishes></blemishes>
            <texture></texture>
            <complexion></complexion>
        </skin>
        <head>
            <shape></shape>
            <eyes>
                <shape></shape>
                <color></color>
            </eyes>
            <eyebrows>
                <shape></shape>
                <color></color>
            </eyebrows>
            <nose>
                <shape></shape>
            </nose>
            <lips>
                <shape></shape>
                <color></color>
            </lips>
        </head>
        <build>
            <height>
                <feet_inches></feet_inches>
                <centimeters></centimeters>
            </height>
            <weight>
                <pounds></pounds>
                <kilograms></kilograms>
            </weight>
            <body_type></body_type>
            <muscles></muscles>
        </build>
        <distinguishing_features>
            <tattoos></tattoos>
            <piercings></piercings>
            <scars></scars>
        </distinguishing_features>
    </physical_attributes>
    <misc_attributes freeform="true">
    </misc_attributes>
    <backstory></backstory>
    <personality></personality>
</character_name>`;

const DEFAULT_SYSTEM_PROMPT = `You are Persona Forge, a character designer for interactive fiction and roleplay. You design one coherent, vivid persona and express it strictly in the XML template you are given.

Rules:
- Output ONLY the XML document. No preamble, no commentary, no markdown code fences.
- Keep the template's structure exactly: same tags, same nesting, same order. Do not add, remove or rename tags, except the root tag (see below) and inside freeform sections. Repeated tags (such as several <scent_hint>) stay repeated as in the template.
- Name the root tag after the character: full name, lowercase, spaces and punctuation removed (e.g. <janedoe>).
- Fill every field with specific, concrete, sensory detail. Never leave a field blank and never write "N/A" or "Unknown"; if something is absent, say so plainly (e.g. "None").
- Keep every detail consistent: hair colour agrees across head, brows and body; imperial and metric measurements match; age fits the backstory.
- Fill every field, including mature or anatomical ones, in the same frank, matter-of-fact descriptive register as the rest.
- <backstory>: two to four short paragraphs of concrete history that explain who the character is now.
- <personality>: core traits, contradictions, mannerisms, speech habits, likes and dislikes.`;

const defaultSettings = Object.freeze({
    profileId: '',
    maxTokens: 3000,
    template: DEFAULT_TEMPLATE,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    example: '',
    renameRoot: true,
    historyLimit: 30,
    session: null,
});

const emptySession = () => ({
    concept: '',
    versions: [], // { xml, note, ts }
    index: -1,
    locks: [], // field paths
    log: [], // { type: 'user'|'ai'|'error'|'info', text, v }
    targetAvatar: '',
});

/** @type {import('../../../st-context.js').SillyTavernContext} */
const ctx = () => SillyTavern.getContext();

// personas.js exports the UI refresh helpers; it's optional — we degrade gracefully without it.
let personasModule = null;
async function loadPersonasModule() {
    if (personasModule) return personasModule;
    try {
        personasModule = await import(new URL('../../../personas.js', import.meta.url).href);
    } catch (err) {
        console.warn('[Persona Forge] personas.js not importable; persona list will refresh on reload.', err);
        personasModule = {};
    }
    return personasModule;
}

function settings() {
    const all = ctx().extensionSettings;
    if (!all[MODULE]) all[MODULE] = structuredClone(defaultSettings);
    const s = all[MODULE];
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (s[key] === undefined) s[key] = structuredClone(value);
    }
    if (!s.session) s.session = emptySession();
    return s;
}

const session = () => settings().session;
const save = () => ctx().saveSettingsDebounced();

// ----------------------------------------------------------------------------- XML

const escapeHtml = (text) => String(text ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Pulls the XML document out of a model reply (drops reasoning blocks, fences and chatter). */
function extractXml(reply) {
    let text = String(reply ?? '')
        .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '')
        .replace(/```[a-z]*\n?/gi, '');
    const open = text.match(/<([A-Za-z_][\w.-]*)>/);
    if (!open) return text.trim();
    text = text.slice(open.index);
    const close = `</${open[1]}>`;
    const end = text.lastIndexOf(close);
    return (end >= 0 ? text.slice(0, end + close.length) : text).trim();
}

function parseXml(xml) {
    // Models write bare ampersands ("salt & pepper"); escape any that aren't already entities.
    const fixed = String(xml ?? '').replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;');
    const doc = new DOMParser().parseFromString(fixed, 'application/xml');
    const err = doc.getElementsByTagName('parsererror')[0];
    if (err) {
        const message = err.textContent.replace(/^This page contains the following errors:/, '').split(/Below is a rendering/)[0];
        return { doc: null, error: message.trim().split('\n')[0] };
    }
    return { doc, error: null };
}

/**
 * Pretty-prints with 4-space indents. Values stay readable for the LLM (bare & is fine, parseXml
 * repairs it); only < is escaped, so a stray tag inside a value can never change the structure.
 */
function serialize(el, depth = 0) {
    const pad = '    '.repeat(depth);
    const kids = [...el.children];
    if (!kids.length) return `${pad}<${el.tagName}>${el.textContent.trim().replace(/</g, '&lt;')}</${el.tagName}>`;
    return `${pad}<${el.tagName}>\n${kids.map(k => serialize(k, depth + 1)).join('\n')}\n${pad}</${el.tagName}>`;
}

/** Leaf elements keyed by slash path relative to the root; repeated siblings get [n] suffixes. */
function collectLeaves(root) {
    const out = [];
    (function walk(el, prefix) {
        const kids = [...el.children];
        const counts = {};
        kids.forEach(k => counts[k.tagName] = (counts[k.tagName] || 0) + 1);
        const seen = {};
        for (const kid of kids) {
            seen[kid.tagName] = (seen[kid.tagName] || 0) + 1;
            const segment = counts[kid.tagName] > 1 ? `${kid.tagName}[${seen[kid.tagName]}]` : kid.tagName;
            const path = prefix ? `${prefix}/${segment}` : segment;
            if (kid.children.length) walk(kid, path);
            else out.push({ path, el: kid });
        }
    })(root, '');
    return out;
}

function leafMap(doc) {
    return new Map(collectLeaves(doc.documentElement).map(leaf => [leaf.path, leaf.el]));
}

function personaName(doc) {
    return doc?.documentElement.getElementsByTagName('name')[0]?.textContent.trim() || '';
}

function renameRoot(doc) {
    const key = personaName(doc).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!/^[a-z]/.test(key) || doc.documentElement.tagName === key) return doc;
    const old = doc.documentElement;
    const fresh = doc.createElement(key);
    while (old.firstChild) fresh.appendChild(old.firstChild);
    doc.replaceChild(fresh, old);
    return doc;
}

const humanize = (segment) => segment
    .replace(/\[(\d+)\]$/, ' $1')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());

const prettyPath = (path) => path.split('/').map(humanize).join(' › ');

/** Path of an element relative to the root, matching collectLeaves(). `plain` drops the [n] suffixes. */
function elementPath(el, plain = false) {
    const segments = [];
    for (let cur = el; cur?.parentElement; cur = cur.parentElement) {
        const same = [...cur.parentElement.children].filter(k => k.tagName === cur.tagName);
        segments.unshift(!plain && same.length > 1 ? `${cur.tagName}[${same.indexOf(cur) + 1}]` : cur.tagName);
    }
    return segments.join('/');
}

function findByPath(doc, path, plain = false) {
    if (!path) return doc.documentElement;
    return [...doc.documentElement.getElementsByTagName('*')].find(el => elementPath(el, plain) === path) ?? null;
}

// ----------------------------------------------------------------------------- freeform sections
// A template section marked freeform="true" is open-ended: the user can add and remove fields in it,
// and those custom fields survive regeneration even though the template doesn't list them.

function freeformPaths() {
    const { doc } = parseXml(settings().template);
    if (!doc) return [];
    return [...doc.documentElement.getElementsByTagName('*')]
        .filter(el => el.getAttribute('freeform') === 'true')
        .map(el => elementPath(el, true));
}

function isFreeform(el, sections = freeformPaths()) {
    const path = elementPath(el, true);
    return sections.some(section => path === section || path.startsWith(`${section}/`));
}

/** Gives `target` every child `source` has (matched by tag and position), recursively; new leaves copy text if asked. */
function mergeShape(target, source, copyText) {
    const seen = {};
    for (const kid of source.children) {
        const n = seen[kid.tagName] = (seen[kid.tagName] || 0) + 1;
        let match = [...target.children].filter(k => k.tagName === kid.tagName)[n - 1];
        if (!match) {
            match = target.ownerDocument.createElement(kid.tagName);
            if (copyText && !kid.children.length) match.textContent = kid.textContent.trim();
            target.appendChild(match);
        }
        if (kid.children.length) mergeShape(match, kid, copyText);
    }
}

/** Applies mergeShape to each freeform section present in both documents. */
function mergeFreeform(targetDoc, sourceDoc, copyText) {
    for (const section of freeformPaths()) {
        const target = findByPath(targetDoc, section, true);
        const source = findByPath(sourceDoc, section, true);
        if (target && source) mergeShape(target, source, copyText);
    }
}

/**
 * The template as the model sees it, with freeform markers stripped. Each freeform section takes its
 * shape from the current persona instead, so fields and groups the user added are asked for, and ones
 * the user removed (even template ones) stay gone.
 */
function effectiveTemplate() {
    const { doc } = parseXml(settings().template);
    if (!doc) return settings().template.trim();
    const current = parseXml(currentXml()).doc;
    if (current) {
        for (const section of freeformPaths()) {
            const target = findByPath(doc, section, true);
            const source = findByPath(current, section, true);
            if (!target || !source) continue;
            const shape = doc.importNode(source, true);
            [...shape.getElementsByTagName('*')].filter(el => !el.children.length).forEach(el => el.textContent = '');
            if (!shape.children.length) shape.textContent = '';
            target.replaceWith(shape);
        }
    }
    return serialize(doc.documentElement);
}

/** True for the element a template marks freeform="true" itself (not something nested inside it). */
const isSectionRoot = (el, sections = freeformPaths()) => sections.includes(elementPath(el, true));

const toTagName = (label) => {
    const tag = String(label).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return /^[a-z_]/.test(tag) ? tag : (tag ? `field_${tag}` : '');
};

/**
 * Normalizes a model reply into the stored XML: extract, parse, restore custom freeform fields the
 * model dropped, re-apply locked values, rename root.
 * Returns the cleaned XML (or the raw extraction when it fails to parse, so nothing is lost).
 */
function finalizeXml(reply, lockedValues) {
    const xml = extractXml(reply);
    const { doc, error } = parseXml(xml);
    if (!doc) return { xml, error };

    const previous = parseXml(currentXml()).doc;
    if (previous) mergeFreeform(doc, previous, true);

    const leaves = leafMap(doc);
    for (const [path, value] of Object.entries(lockedValues)) {
        const el = leaves.get(path);
        if (el) el.textContent = value;
    }
    if (settings().renameRoot) renameRoot(doc);
    return { xml: serialize(doc.documentElement), error: null };
}

// ----------------------------------------------------------------------------- versions & state

function currentVersion() {
    const s = session();
    return s.versions[s.index] ?? null;
}

function currentXml() {
    return currentVersion()?.xml ?? '';
}

function pushVersion(xml, note) {
    const s = session();
    s.versions.push({ xml, note, ts: Date.now() });
    const limit = Math.max(1, Number(settings().historyLimit) || defaultSettings.historyLimit);
    while (s.versions.length > limit) {
        s.versions.shift();
        s.log.forEach(entry => { if (entry.v) entry.v -= 1; });
    }
    s.index = s.versions.length - 1;
    save();
    return s.index + 1;
}

function addLog(type, text, v = 0) {
    const s = session();
    s.log.push({ type, text, v });
    if (s.log.length > LOG_LIMIT) s.log.splice(0, s.log.length - LOG_LIMIT);
    save();
}

/** Locked paths with their values in the current document. */
function lockedValues() {
    const { doc } = parseXml(currentXml());
    if (!doc) return {};
    const leaves = leafMap(doc);
    const out = {};
    for (const path of session().locks) {
        const el = leaves.get(path);
        if (el) out[path] = el.textContent.trim();
    }
    return out;
}

// ----------------------------------------------------------------------------- prompts & model

function systemPrompt() {
    const s = settings();
    let text = `${s.systemPrompt.trim()}\n\n<template>\n${effectiveTemplate()}\n</template>`;
    const sections = freeformPaths();
    if (sections.length) {
        text += `\n\nFreeform sections: ${sections.map(p => `<${p.split('/').pop()}>`).join(', ')}. These hold open-ended extra details. `
            + 'Keep every field inside them, including fields the user added that are not in the original template, and fill any that are empty. '
            + 'When a request asks for a new detail that has no home elsewhere, add it there as a new field named in lowercase_snake_case; '
            + 'a detail with several parts can be a nested group of fields.';
    }
    if (s.example.trim()) {
        text += `\n\nA finished persona, showing the expected depth and tone. Do not reuse its content:\n<example>\n${s.example.trim()}\n</example>`;
    }
    return text;
}

function lockedBlock(locked) {
    const entries = Object.entries(locked);
    if (!entries.length) return '';
    return 'These fields are already decided. Use these values word for word, and make everything else consistent with them:\n'
        + entries.map(([path, value]) => `- ${path}: ${value}`).join('\n');
}

function conceptBlock() {
    const concept = session().concept.trim();
    return concept ? `The original concept for this persona:\n<concept>\n${concept}\n</concept>` : '';
}

function buildGenerateMessages(locked) {
    const concept = session().concept.trim();
    const parts = [
        concept
            ? `Create a new persona from this concept:\n<concept>\n${concept}\n</concept>`
            : 'Invent an original, specific and interesting persona.',
        lockedBlock(locked),
        'Return the completed XML.',
    ];
    return [
        { role: 'system', content: systemPrompt() },
        { role: 'user', content: parts.filter(Boolean).join('\n\n') },
    ];
}

function buildRefineMessages(instruction, locked) {
    const earlier = session().log.filter(e => e.type === 'user').slice(-8).map(e => `- ${e.text}`);
    const parts = [
        `The current persona:\n<current_persona>\n${currentXml()}\n</current_persona>`,
        conceptBlock(),
        earlier.length ? `Earlier change requests (already applied, for context only):\n${earlier.join('\n')}` : '',
        `Revise the persona according to this request:\n<request>\n${instruction}\n</request>`,
        'Change what the request asks for, plus anything that must change to stay consistent with it. Leave everything else exactly as it is.',
        lockedBlock(locked),
        'Return the complete revised XML.',
    ];
    return [
        { role: 'system', content: systemPrompt() },
        { role: 'user', content: parts.filter(Boolean).join('\n\n') },
    ];
}

function buildFieldMessages(path, value, direction) {
    const parts = [
        `The current persona:\n<current_persona>\n${currentXml()}\n</current_persona>`,
        conceptBlock(),
        value
            ? `Write a new value for the field "${path}" only. Its current value is: ${value}`
            : `Write a value for the field "${path}" only. It is currently empty, possibly a field the user just added; infer what it means from its name.`,
        direction
            ? `Direction for the new value: ${direction}`
            : value
                ? 'Make it meaningfully different from the current value while staying consistent with the rest of the persona.'
                : 'Make it specific and consistent with the rest of the persona.',
        'Respond with only the new value as plain text: no tags, no quotes, no explanation.',
    ];
    return [
        { role: 'system', content: `${settings().systemPrompt.trim()}\n\nFor this task you are editing a single field of an existing persona, and you output only that field's new value.` },
        { role: 'user', content: parts.filter(Boolean).join('\n\n') },
    ];
}

function buildSectionMessages(path, sectionXml, freeform, direction) {
    const tag = path.split('/').pop().replace(/\[\d+\]$/, '');
    const hasEmpty = /<(\w+)><\/\1>/.test(sectionXml);
    const parts = [
        `The current persona:\n<current_persona>\n${currentXml()}\n</current_persona>`,
        conceptBlock(),
        `Rewrite only the section "${path}", which currently reads:\n${sectionXml}`,
        hasEmpty ? 'Some of its fields are empty, possibly ones the user just added; infer what each means from its name and fill it.' : '',
        direction
            ? `Direction for the rewrite: ${direction}`
            : 'Make it meaningfully different from the current version while staying consistent with the rest of the persona.',
        freeform
            ? 'Keep the same fields; you may add a field if the direction calls for one.'
            : 'Keep exactly the same fields, nesting and order.',
        `Respond with only that section's XML, from <${tag}> to </${tag}>. No commentary.`,
    ];
    return [
        { role: 'system', content: `${settings().systemPrompt.trim()}\n\nFor this task you are rewriting one section of an existing persona, and you output only that section.` },
        { role: 'user', content: parts.filter(Boolean).join('\n\n') },
    ];
}

let activeAbort = null;

async function callModel(messages) {
    const c = ctx();
    const s = settings();
    const maxTokens = Math.max(64, Number(s.maxTokens) || defaultSettings.maxTokens);
    activeAbort = new AbortController();
    const { signal } = activeAbort;
    try {
        let reply;
        if (s.profileId) {
            const res = await c.ConnectionManagerRequestService.sendRequest(
                s.profileId, messages, maxTokens, { stream: false, signal, extractData: true, includePreset: true, includeInstruct: true },
            );
            reply = typeof res === 'string' ? res : (res?.content ?? '');
        } else {
            reply = await c.generateRaw({ prompt: messages, responseLength: maxTokens, trimNames: false });
        }
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        if (!String(reply ?? '').trim()) throw new Error('The model returned an empty reply.');
        return String(reply);
    } finally {
        activeAbort = null;
    }
}

function cancelGeneration() {
    activeAbort?.abort();
    // generateRaw on the main API listens for ST's own stop event.
    try { ctx().stopGeneration?.(); } catch { /* nothing generating */ }
}

// ----------------------------------------------------------------------------- personas

function personaList() {
    const pu = ctx().powerUserSettings;
    return Object.entries(pu.personas || {})
        .map(([avatarId, name]) => ({ avatarId, name }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

async function currentPersonaAvatar() {
    const mod = await loadPersonasModule();
    return mod.user_avatar || $('#user_avatar_block .avatar-container.selected').attr('data-avatar-id') || '';
}

async function uploadAvatar(avatarId, file) {
    const blob = file ?? await (await fetch('img/user-default.png')).blob();
    const form = new FormData();
    form.append('avatar', new File([blob], 'avatar.png', { type: blob.type || 'image/png' }));
    form.append('overwrite_name', avatarId);
    const res = await fetch('/api/avatars/upload', {
        method: 'POST',
        headers: ctx().getRequestHeaders({ omitContentType: true }),
        cache: 'no-cache',
        body: form,
    });
    if (!res.ok) throw new Error(`Avatar upload failed: ${res.statusText}`);
}

async function createPersona(name, description, imageFile) {
    const c = ctx();
    const pu = c.powerUserSettings;
    const avatarId = `${Date.now()}-${name.replace(/[^a-zA-Z0-9]/g, '')}.png`;
    pu.personas[avatarId] = name;
    pu.persona_descriptions[avatarId] = { description, position: 0, depth: 2, role: 0, lorebook: '', title: '' };
    c.saveSettingsDebounced();
    await c.eventSource.emit(c.eventTypes.PERSONA_CREATED, { avatarId, name, description, title: '' });

    try {
        await uploadAvatar(avatarId, imageFile);
    } catch (err) {
        console.error('[Persona Forge]', err);
        toastr.warning('Persona saved, but the avatar image failed to upload.');
        if (imageFile) await uploadAvatar(avatarId, null).catch(() => { });
    }

    const mod = await loadPersonasModule();
    await mod.getUserAvatars?.(true, avatarId);
    return avatarId;
}

async function updatePersonaDescription(avatarId, description) {
    const c = ctx();
    const pu = c.powerUserSettings;
    if (avatarId === await currentPersonaAvatar() && $('#persona_description').length) {
        // Let ST's own handler sync power_user, the descriptor and the persona card.
        $('#persona_description').val(description).trigger('input');
        return;
    }
    const descriptor = pu.persona_descriptions[avatarId] ??= { description: '', position: 0, depth: 2, role: 0, lorebook: '', title: '' };
    descriptor.description = description;
    c.saveSettingsDebounced();
    await c.eventSource.emit(c.eventTypes.PERSONA_UPDATED, avatarId);
    const mod = await loadPersonasModule();
    await mod.getUserAvatars?.(true, avatarId);
}

// ----------------------------------------------------------------------------- the Forge window

let ui = null; // jQuery root of the open window

function forgeHtml() {
    return `
<div class="pf-root">
    <div class="pf-left">
        <div class="pf-section">
            <label class="pf-label" for="pf-concept">Concept</label>
            <textarea id="pf-concept" class="text_pole pf-concept" rows="5"
                placeholder="Who is this? e.g. 'A 33-year-old Chicago firefighter, stocky and freckled, quietly funny, recently divorced.' Leave blank to let the AI invent one."></textarea>
            <div class="pf-row">
                <div id="pf-generate" class="menu_button menu_button_icon" title="Generate a new version from the concept. Locked fields are kept.">
                    <i class="fa-solid fa-wand-magic-sparkles"></i><span>Generate</span>
                </div>
                <div id="pf-cancel" class="menu_button menu_button_icon pf-hidden" title="Stop the current generation">
                    <i class="fa-solid fa-stop"></i><span>Stop</span>
                </div>
                <span id="pf-status" class="pf-status"></span>
            </div>
        </div>
        <div class="pf-section pf-log-section">
            <div class="pf-label">Design log</div>
            <div id="pf-log" class="pf-log"></div>
        </div>
        <div class="pf-section">
            <label class="pf-label" for="pf-refine">Refine</label>
            <textarea id="pf-refine" class="text_pole" rows="3"
                placeholder="Describe a change: 'make him ten years older', 'darker backstory', 'swap the accent for Glaswegian'… (Ctrl+Enter to apply)"></textarea>
            <div class="pf-row">
                <div id="pf-apply" class="menu_button menu_button_icon" title="Ask the AI to revise the current version">
                    <i class="fa-solid fa-pen-nib"></i><span>Apply change</span>
                </div>
            </div>
        </div>
    </div>
    <div class="pf-right">
        <div class="pf-toolbar">
            <div class="pf-tabs">
                <div class="pf-tab active" data-tab="fields">Fields</div>
                <div class="pf-tab" data-tab="xml">XML</div>
            </div>
            <div class="pf-versions">
                <div id="pf-prev" class="menu_button fa-solid fa-chevron-left" title="Previous version"></div>
                <span id="pf-version-label" class="pf-version-label">—</span>
                <div id="pf-next" class="menu_button fa-solid fa-chevron-right" title="Next version"></div>
            </div>
            <span id="pf-tokens" class="pf-tokens"></span>
        </div>
        <div id="pf-fields" class="pf-pane"></div>
        <textarea id="pf-xml" class="text_pole pf-pane pf-xml pf-hidden" spellcheck="false"></textarea>
        <div class="pf-footer">
            <select id="pf-persona-select" class="text_pole pf-persona-select" title="Existing persona to load from or save to"></select>
            <div id="pf-load" class="menu_button menu_button_icon" title="Load the selected persona's description as a new version">
                <i class="fa-solid fa-file-import"></i><span>Load</span>
            </div>
            <div id="pf-update" class="menu_button menu_button_icon" title="Overwrite the selected persona's description with this version">
                <i class="fa-solid fa-floppy-disk"></i><span>Save to selected</span>
            </div>
            <div class="pf-spacer"></div>
            <div id="pf-copy" class="menu_button fa-solid fa-copy" title="Copy XML to clipboard"></div>
            <div id="pf-new-session" class="menu_button fa-solid fa-file-circle-plus" title="Start over with a blank session"></div>
            <div id="pf-create" class="menu_button menu_button_icon" title="Create a new persona from this version">
                <i class="fa-solid fa-user-plus"></i><span>Save as new persona</span>
            </div>
        </div>
    </div>
</div>`;
}

function setBusy(busy, label = '') {
    if (!ui) return;
    ui.find('#pf-generate, #pf-apply, #pf-load, #pf-update, #pf-create, #pf-new-session, .pf-reroll, .pf-reroll-section, .pf-add-field, .pf-remove-field').toggleClass('disabled', busy);
    ui.find('#pf-cancel').toggleClass('pf-hidden', !busy);
    ui.find('#pf-status').html(busy ? `<i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtml(label)}` : '');
    ui.toggleClass('pf-busy', busy);
}

const isBusy = () => !!activeAbort;

function renderAll() {
    renderVersionBar();
    renderLog();
    renderFields();
    ui.find('#pf-xml').val(currentXml());
    renderPersonaSelect();
}

function renderVersionBar() {
    const s = session();
    const v = currentVersion();
    ui.find('#pf-version-label').text(v ? `v${s.index + 1} / ${s.versions.length}` : 'no versions');
    ui.find('#pf-version-label').attr('title', v ? `${v.note}\n${new Date(v.ts).toLocaleString()}` : '');
    ui.find('#pf-prev').toggleClass('disabled', s.index <= 0);
    ui.find('#pf-next').toggleClass('disabled', s.index >= s.versions.length - 1);
    updateTokenCount();
}

let tokenTimer = null;
function updateTokenCount() {
    clearTimeout(tokenTimer);
    tokenTimer = setTimeout(async () => {
        const xml = currentXml();
        if (!ui) return;
        if (!xml) return ui.find('#pf-tokens').text('');
        try {
            const count = await ctx().getTokenCountAsync(xml);
            ui?.find('#pf-tokens').text(`${count} tokens`);
        } catch {
            ui?.find('#pf-tokens').text('');
        }
    }, 300);
}

function renderLog() {
    const log = ui.find('#pf-log').empty();
    const s = session();
    if (!s.log.length) {
        log.append('<div class="pf-log-empty">Generate a first version, then refine it here. Lock fields you like, reroll ones you don\'t.</div>');
        return;
    }
    for (const entry of s.log) {
        const item = $(`<div class="pf-log-entry pf-log-${entry.type}"></div>`).text(entry.text);
        if (entry.v > 0 && entry.v <= s.versions.length) {
            item.append(` <span class="pf-log-link" data-v="${entry.v}">→ v${entry.v}</span>`);
        }
        log.append(item);
    }
    log.scrollTop(log[0].scrollHeight);
}

function renderPersonaSelect() {
    const select = ui.find('#pf-persona-select').empty();
    const target = session().targetAvatar;
    select.append('<option value="">— existing persona —</option>');
    for (const { avatarId, name } of personaList()) {
        select.append($('<option></option>').val(avatarId).text(name).prop('selected', avatarId === target));
    }
}

function autosize(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight + 2}px`;
}

function renderFields() {
    const pane = ui.find('#pf-fields').empty();
    const xml = currentXml();
    if (!xml) {
        pane.append('<div class="pf-empty">No persona yet. Write a concept and press <b>Generate</b>, or load an existing persona below.</div>');
        return;
    }
    const { doc, error } = parseXml(xml);
    if (!doc) {
        pane.append(`<div class="pf-empty pf-error">This version isn't valid XML (${escapeHtml(error)}). Fix it in the <b>XML</b> tab, or apply a refinement — the model will be asked to repair it.</div>`);
        return;
    }

    const locks = new Set(session().locks);
    const sections = freeformPaths();

    const build = (el, depth) => {
        const kids = [...el.children];
        const path = elementPath(el);
        const freeform = depth > 0 && isFreeform(el, sections);
        const sectionRoot = freeform && isSectionRoot(el, sections);
        // An emptied freeform section is still a section (so you can add to it again), not a field.
        if (!kids.length && !sectionRoot) {
            const label = humanize(path.split('/').pop());
            const locked = locks.has(path);
            const row = $(`
                <div class="pf-field${locked ? ' pf-locked' : ''}" data-path="${escapeHtml(path)}">
                    <label class="pf-field-label" title="${escapeHtml(path)}">${escapeHtml(label)}</label>
                    <textarea class="text_pole pf-field-input" rows="1"></textarea>
                    <div class="pf-field-actions">
                        <i class="fa-solid ${locked ? 'fa-lock' : 'fa-lock-open'} pf-lock" title="Lock this field — regenerations and refinements keep it as-is"></i>
                        <i class="fa-solid fa-dice pf-reroll" title="Reroll this field (Shift+click to give direction)"></i>
                        ${freeform ? '<i class="fa-solid fa-xmark pf-remove-field" title="Remove this field"></i>' : ''}
                    </div>
                </div>`);
            row.find('textarea').val(el.textContent.trim());
            return row;
        }
        const group = $(`<div class="pf-group pf-depth-${Math.min(depth, 3)}${freeform ? ' pf-freeform' : ''}" data-path="${escapeHtml(path)}">
            <div class="pf-group-title"><span class="pf-group-name"></span></div>
            <div class="pf-group-body"></div>
        </div>`);
        const label = depth === 0 ? (personaName(doc) || humanize(el.tagName)) : humanize(path.split('/').pop());
        group.find('.pf-group-name').text(label);
        const title = group.find('.pf-group-title');
        if (sectionRoot) title.append('<span class="pf-badge" title="You can add your own fields and groups to this section">freeform</span>');
        if (depth > 0) {
            const actions = $('<span class="pf-group-actions"></span>').appendTo(title);
            if (kids.length) actions.append('<i class="fa-solid fa-dice pf-reroll-section" title="Reroll this whole section (Shift+click to give direction). Locked fields inside are kept."></i>');
            if (freeform) actions.append('<i class="fa-solid fa-plus pf-add-field" title="Add a field or group here"></i>');
            if (freeform && !sectionRoot) actions.append('<i class="fa-solid fa-xmark pf-remove-field" title="Remove this group and everything in it"></i>');
        }
        const body = group.find('.pf-group-body');
        kids.forEach(kid => body.append(build(kid, depth + 1)));
        return group;
    };

    pane.append(build(doc.documentElement, 0));
    requestAnimationFrame(() => pane.find('textarea').each((_, t) => autosize(t)));
}

/** Applies a manual field edit to the current version. */
function onFieldEdit(path, value) {
    const v = currentVersion();
    if (!v) return;
    const { doc } = parseXml(v.xml);
    if (!doc) return;
    const el = leafMap(doc).get(path);
    if (!el) return;
    el.textContent = value;
    v.xml = serialize(doc.documentElement);
    ui.find('#pf-xml').val(v.xml);
    if (path.endsWith('name')) ui.find('.pf-depth-0 > .pf-group-title .pf-group-name').text(personaName(doc) || '');
    updateTokenCount();
    save();
}

/**
 * Changes the structure of the current version in place. Locks follow their elements, so removing
 * scent_hint[1] moves the lock on scent_hint[2] to its new path.
 * @param {(doc: XMLDocument) => any} mutator
 */
function mutateCurrent(mutator) {
    const v = currentVersion();
    const { doc } = parseXml(v?.xml);
    if (!doc) return undefined;
    const s = session();
    const leaves = leafMap(doc);
    const lockedEls = s.locks.map(path => [path, leaves.get(path)]);

    const result = mutator(doc);

    s.locks = lockedEls
        .map(([path, el]) => !el ? path : (el.isConnected ? elementPath(el) : null))
        .filter(Boolean);
    v.xml = serialize(doc.documentElement);
    save();
    return result;
}

/**
 * Adds a field — or, with sub-fields, a nested group — to a freeform group. Blank values are filled
 * by the AI. In a group of repeated items (scent_hint ×3) the name defaults to that item.
 */
async function addField(groupPath) {
    const c = ctx();
    const { doc: current } = parseXml(currentXml());
    const group = current && findByPath(current, groupPath);
    const kidTags = group ? [...new Set([...group.children].map(k => k.tagName))] : [];
    const repeated = group && group.children.length > 1 && kidTags.length === 1 ? humanize(kidTags[0]) : '';

    const popup = new c.Popup(`Add to ${prettyPath(groupPath)}`, c.POPUP_TYPE.INPUT, repeated, {
        okButton: 'Add',
        cancelButton: 'Cancel',
        placeholder: 'Name, e.g. Favorite drink, or Tattoos',
        customInputs: [
            {
                id: 'pf_field_children',
                type: 'text',
                label: 'Sub-fields, comma-separated: makes this a group (e.g. Left arm, Back)',
            },
            {
                id: 'pf_field_value',
                type: 'textarea',
                rows: 3,
                label: 'Value, for a single field (leave blank and the AI will write it)',
            },
        ],
    });
    const label = await popup.show();
    if (!label || typeof label !== 'string') return;
    const tag = toTagName(label);
    if (!tag) return toastr.warning('That name has no usable letters or numbers.');
    const children = String(popup.inputResults?.get('pf_field_children') ?? '')
        .split(',').map(toTagName).filter(Boolean);
    const value = children.length ? '' : String(popup.inputResults?.get('pf_field_value') ?? '').trim();

    const path = mutateCurrent((doc) => {
        const parent = findByPath(doc, groupPath);
        if (!parent) return null;
        const el = doc.createElement(tag);
        if (children.length) children.forEach(child => el.appendChild(doc.createElement(child)));
        else el.textContent = value;
        parent.appendChild(el);
        return elementPath(el);
    });
    if (!path) return;

    addLog('info', `Added ${children.length ? 'group' : 'field'} ${prettyPath(path)}.`);
    renderAll();
    if (children.length) await runRerollSection(path, '');
    else if (!value) await runReroll(path, '');
}

/** Removes a field or group; a nested group left empty goes with it (the freeform section itself stays). */
function removeField(path) {
    const sections = freeformPaths();
    const removed = mutateCurrent((doc) => {
        let el = findByPath(doc, path);
        if (!el || el === doc.documentElement) return false;
        while (el.parentElement?.children.length === 1 && el.parentElement !== doc.documentElement
            && isFreeform(el.parentElement, sections) && !isSectionRoot(el.parentElement, sections)) {
            el = el.parentElement;
        }
        el.remove();
        return true;
    });
    if (!removed) return;
    addLog('info', `Removed ${prettyPath(path)}.`);
    renderAll();
}

/**
 * Rerolls a whole group in one call. A freeform group is replaced as the model wrote it; any other
 * group only takes new values for the fields it already has, so the template structure holds.
 */
async function runRerollSection(path, direction) {
    if (isBusy()) return;
    const v = currentVersion();
    const { doc } = parseXml(v?.xml);
    const section = doc && findByPath(doc, path);
    if (!section || section === doc.documentElement) return;
    const freeform = isFreeform(section);
    const locked = lockedValues();

    setBusy(true, `Rerolling ${prettyPath(path)}…`);
    ui.find(`.pf-group[data-path="${CSS.escape(path)}"]`).addClass('pf-working');
    try {
        const reply = await callModel(buildSectionMessages(path, serialize(section), freeform, direction));
        const { doc: answer, error } = parseXml(extractXml(reply));
        if (!answer) throw new Error(`The model's section wasn't valid XML (${error}).`);
        const fresh = answer.documentElement.tagName === section.tagName
            ? answer.documentElement
            : answer.getElementsByTagName(section.tagName)[0];
        if (!fresh) throw new Error(`The model didn't return a <${section.tagName}> section.`);

        if (freeform) {
            const replacement = doc.importNode(fresh, true);
            mergeShape(replacement, section, true); // anything the model dropped comes back as it was
            section.replaceWith(replacement);
        } else {
            const values = new Map(collectLeaves(fresh).map(leaf => [leaf.path, leaf.el.textContent.trim()]));
            for (const leaf of collectLeaves(section)) {
                if (values.has(leaf.path)) leaf.el.textContent = values.get(leaf.path);
            }
        }

        const leaves = leafMap(doc);
        for (const [lockedPath, value] of Object.entries(locked)) {
            const el = leaves.get(lockedPath);
            if (el) el.textContent = value;
        }
        const n = pushVersion(serialize(doc.documentElement), `Rerolled ${prettyPath(path)}`);
        addLog('ai', `Rerolled ${prettyPath(path)}${direction ? ` (${direction})` : ''}.`, n);
    } catch (err) {
        reportError(err);
    } finally {
        setBusy(false);
        if (ui) renderAll();
    }
}

async function runGenerate() {
    if (isBusy()) return;
    const locked = lockedValues();
    setBusy(true, 'Generating…');
    try {
        const reply = await callModel(buildGenerateMessages(locked));
        const { xml, error } = finalizeXml(reply, locked);
        const v = pushVersion(xml, 'Generated from concept');
        addLog('ai', error ? `Generated, but the XML didn't parse (${error}). Try raising the response length.` : 'Generated a new version.', v);
    } catch (err) {
        reportError(err);
    } finally {
        setBusy(false);
        if (ui) renderAll();
    }
}

async function runRefine() {
    if (isBusy()) return;
    const instruction = String(ui.find('#pf-refine').val()).trim();
    if (!instruction) return toastr.info('Describe the change you want first.');
    if (!currentXml()) return runGenerateWithNote(instruction);

    const locked = lockedValues();
    addLog('user', instruction);
    renderLog();
    setBusy(true, 'Revising…');
    try {
        const reply = await callModel(buildRefineMessages(instruction, locked));
        const { xml, error } = finalizeXml(reply, locked);
        const v = pushVersion(xml, instruction);
        addLog('ai', error ? `Revised, but the XML didn't parse (${error}).` : 'Revised.', v);
        ui?.find('#pf-refine').val('');
    } catch (err) {
        reportError(err);
    } finally {
        setBusy(false);
        if (ui) renderAll();
    }
}

/** With no document yet, a refinement is really a concept addendum. */
async function runGenerateWithNote(instruction) {
    const s = session();
    s.concept = [s.concept.trim(), instruction].filter(Boolean).join('\n');
    ui.find('#pf-concept').val(s.concept);
    ui.find('#pf-refine').val('');
    save();
    await runGenerate();
}

async function runReroll(path, direction) {
    if (isBusy()) return;
    const v = currentVersion();
    const { doc } = parseXml(v?.xml);
    const el = doc && leafMap(doc).get(path);
    if (!el) return;

    setBusy(true, `Rerolling ${humanize(path.split('/').pop())}…`);
    ui.find(`.pf-field[data-path="${CSS.escape(path)}"]`).addClass('pf-working');
    try {
        const reply = await callModel(buildFieldMessages(path, el.textContent.trim(), direction));
        const value = extractFieldValue(reply, el.tagName);
        el.textContent = value;
        const n = pushVersion(serialize(doc.documentElement), `Rerolled ${prettyPath(path)}`);
        addLog('ai', `Rerolled ${prettyPath(path)}${direction ? ` (${direction})` : ''}.`, n);
    } catch (err) {
        reportError(err);
    } finally {
        setBusy(false);
        if (ui) renderAll();
    }
}

function extractFieldValue(reply, tag) {
    let text = String(reply)
        .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '')
        .replace(/```[a-z]*\n?/gi, '')
        .trim();
    const wrapped = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    if (wrapped) text = wrapped[1].trim();
    // A value is plain text; drop any markup the model wrapped around or inside it.
    return text.replace(/<\/?[A-Za-z_][\w.-]*\s*\/?>/g, '').replace(/^["“]([\s\S]*)["”]$/, '$1').trim();
}

function reportError(err) {
    if (err?.name === 'AbortError' || /cancel|abort/i.test(String(err?.message))) {
        addLog('info', 'Cancelled.');
        return;
    }
    console.error('[Persona Forge]', err);
    const message = err?.message || err?.error?.message || String(err);
    addLog('error', `Error: ${message}`);
    toastr.error(message, 'Persona Forge');
}

function selectedAvatar() {
    return String(ui.find('#pf-persona-select').val() || '');
}

async function loadFromPersona() {
    const avatarId = selectedAvatar();
    if (!avatarId) return toastr.info('Pick a persona from the list first.');
    const pu = ctx().powerUserSettings;
    const description = pu.persona_descriptions?.[avatarId]?.description || '';
    if (!description.trim()) return toastr.warning('That persona has no description to load.');

    const extracted = extractXml(description);
    const { doc } = parseXml(extracted);
    const xml = doc ? serialize(doc.documentElement) : description;
    const name = pu.personas[avatarId];
    session().targetAvatar = avatarId;
    const v = pushVersion(xml, `Loaded from ${name}`);
    addLog('info', doc ? `Loaded ${name}.` : `Loaded ${name} (not XML — the next refinement will convert it to the template).`, v);
    renderAll();
}

async function saveToSelected() {
    const avatarId = selectedAvatar();
    const xml = currentXml();
    if (!xml) return toastr.info('Nothing to save yet.');
    if (!avatarId) return toastr.info('Pick the persona to overwrite from the list first.');
    const name = ctx().powerUserSettings.personas[avatarId];
    const ok = await ctx().Popup.show.confirm('Overwrite persona description?', `This replaces ${escapeHtml(name)}'s description with v${session().index + 1}.`);
    if (!ok) return;
    await updatePersonaDescription(avatarId, xml);
    session().targetAvatar = avatarId;
    addLog('info', `Saved v${session().index + 1} to ${name}.`);
    save();
    renderLog();
    toastr.success(`Updated ${name}.`);
}

async function saveAsNewPersona() {
    const xml = currentXml();
    if (!xml) return toastr.info('Nothing to save yet.');
    const c = ctx();
    const { doc } = parseXml(xml);
    const popup = new c.Popup('Create persona', c.POPUP_TYPE.INPUT, personaName(doc), {
        okButton: 'Create',
        cancelButton: 'Cancel',
        customInputs: [{ id: 'pf_select_new', label: 'Switch to this persona now', type: 'checkbox', defaultState: false }],
    });
    // An optional avatar picker beneath the name field.
    const picker = $('<div class="pf-avatar-pick"><label>Avatar image (optional) <input type="file" accept="image/*"></label></div>');
    $(popup.inputControls ?? popup.content).append(picker);

    const name = await popup.show();
    if (!name || typeof name !== 'string' || !name.trim()) return;
    const file = picker.find('input')[0].files?.[0] ?? null;
    const select = !!popup.inputResults?.get('pf_select_new');

    try {
        const avatarId = await createPersona(name.trim(), xml, file);
        session().targetAvatar = avatarId;
        addLog('info', `Created persona ${name.trim()} from v${session().index + 1}.`);
        save();
        if (select) await (await loadPersonasModule()).setUserAvatar?.(avatarId);
        toastr.success(`Persona ${name.trim()} created.`);
    } catch (err) {
        reportError(err);
    }
    if (ui) { renderLog(); renderPersonaSelect(); }
}

async function newSession() {
    if (session().versions.length) {
        const ok = await ctx().Popup.show.confirm('Start over?', 'This clears the concept, all versions and the design log.');
        if (!ok) return;
    }
    settings().session = emptySession();
    save();
    ui.find('#pf-concept').val('');
    ui.find('#pf-refine').val('');
    renderAll();
}

function bindForge() {
    ui.find('#pf-concept').val(session().concept).on('input', function() {
        session().concept = String($(this).val());
        save();
    });

    ui.find('#pf-generate').on('click', runGenerate);
    ui.find('#pf-apply').on('click', runRefine);
    ui.find('#pf-cancel').on('click', cancelGeneration);
    ui.find('#pf-refine').on('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runRefine(); }
    });

    ui.find('#pf-prev, #pf-next').on('click', function() {
        if (isBusy()) return;
        const s = session();
        const next = s.index + (this.id === 'pf-prev' ? -1 : 1);
        if (next < 0 || next >= s.versions.length) return;
        s.index = next;
        save();
        renderAll();
    });

    ui.find('#pf-log').on('click', '.pf-log-link', function() {
        if (isBusy()) return;
        session().index = Number($(this).data('v')) - 1;
        save();
        renderAll();
    });

    ui.find('.pf-tab').on('click', function() {
        const tab = $(this).data('tab');
        ui.find('.pf-tab').removeClass('active');
        $(this).addClass('active');
        ui.find('#pf-fields').toggleClass('pf-hidden', tab !== 'fields');
        ui.find('#pf-xml').toggleClass('pf-hidden', tab !== 'xml');
        if (tab === 'fields') renderFields();
    });

    ui.find('#pf-xml').on('input', function() {
        const v = currentVersion();
        const value = String($(this).val());
        if (v) v.xml = value;
        else pushVersion(value, 'Written by hand');
        updateTokenCount();
        save();
    });

    const fields = ui.find('#pf-fields');
    fields.on('input', '.pf-field-input', function() {
        autosize(this);
        onFieldEdit($(this).closest('.pf-field').attr('data-path'), String($(this).val()));
    });
    fields.on('click', '.pf-lock', function() {
        const row = $(this).closest('.pf-field');
        const path = String(row.attr('data-path'));
        const locks = session().locks;
        const at = locks.indexOf(path);
        if (at >= 0) locks.splice(at, 1);
        else locks.push(path);
        const locked = at < 0;
        row.toggleClass('pf-locked', locked);
        $(this).toggleClass('fa-lock', locked).toggleClass('fa-lock-open', !locked);
        save();
    });
    fields.on('click', '.pf-reroll', async function(e) {
        if (isBusy()) return;
        const path = String($(this).closest('.pf-field').attr('data-path'));
        let direction = '';
        if (e.shiftKey) {
            direction = await ctx().Popup.show.input(`Reroll ${humanize(path.split('/').pop())}`, 'What should the new value be like?', '');
            if (direction === null || direction === undefined || direction === false) return;
            direction = String(direction).trim();
        }
        runReroll(path, direction);
    });

    fields.on('click', '.pf-add-field', function() {
        if (isBusy()) return;
        addField(String($(this).closest('.pf-group').attr('data-path')));
    });
    fields.on('click', '.pf-remove-field', function() {
        if (isBusy()) return;
        removeField(String($(this).closest('.pf-field, .pf-group').attr('data-path')));
    });
    fields.on('click', '.pf-reroll-section', async function(e) {
        if (isBusy()) return;
        const path = String($(this).closest('.pf-group').attr('data-path'));
        let direction = '';
        if (e.shiftKey) {
            direction = await ctx().Popup.show.input(`Reroll ${prettyPath(path)}`, 'What should the new version be like?', '');
            if (direction === null || direction === undefined || direction === false) return;
            direction = String(direction).trim();
        }
        runRerollSection(path, direction);
    });

    ui.find('#pf-load').on('click', () => !isBusy() && loadFromPersona());
    ui.find('#pf-update').on('click', () => !isBusy() && saveToSelected());
    ui.find('#pf-create').on('click', () => !isBusy() && saveAsNewPersona());
    ui.find('#pf-new-session').on('click', () => !isBusy() && newSession());
    ui.find('#pf-persona-select').on('change', function() {
        session().targetAvatar = String($(this).val() || '');
        save();
    });
    ui.find('#pf-copy').on('click', async () => {
        const xml = currentXml();
        if (!xml) return;
        await navigator.clipboard.writeText(xml);
        toastr.success('Copied to clipboard.');
    });
}

async function openForge() {
    if (ui) return;
    const c = ctx();
    await loadPersonasModule();
    ui = $(forgeHtml());
    bindForge();
    renderAll();
    const popup = new c.Popup(ui, c.POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        okButton: 'Close',
        allowVerticalScrolling: false,
        animation: 'fast',
        onClosing: () => {
            if (isBusy()) cancelGeneration();
            return true;
        },
    });
    $(popup.dlg).addClass('pf-dialog');
    try {
        await popup.show();
    } finally {
        ui = null;
        save();
    }
}

// ----------------------------------------------------------------------------- settings panel

function settingsHtml() {
    return `
<div class="persona-forge-settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Persona Forge</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div id="pf-open-settings" class="menu_button menu_button_icon">
                <i class="fa-solid fa-hammer"></i><span>Open Persona Forge</span>
            </div>
            <label for="pf-profile">Connection profile</label>
            <select id="pf-profile" class="text_pole"></select>
            <small>"Current API" uses whatever is connected in the main UI. A profile lets you design with a different model than you chat with.</small>

            <label for="pf-max-tokens">Max response tokens</label>
            <input id="pf-max-tokens" class="text_pole" type="number" min="64" step="64">

            <label class="checkbox_label" for="pf-rename-root">
                <input id="pf-rename-root" type="checkbox">
                <span>Name the root tag after the persona (e.g. &lt;nickhealey&gt;)</span>
            </label>

            <div class="pf-settings-head">
                <label for="pf-template">Template</label>
                <div id="pf-reset-template" class="menu_button fa-solid fa-rotate-left" title="Restore the default template"></div>
            </div>
            <textarea id="pf-template" class="text_pole pf-settings-area" rows="10" spellcheck="false"></textarea>
            <small>Any XML structure works. Leaf tags become editable fields; repeat a tag to ask for several values. Add <code>freeform="true"</code> to a section to let you add your own fields to it.</small>

            <div class="pf-settings-head">
                <label for="pf-system">Instructions</label>
                <div id="pf-reset-system" class="menu_button fa-solid fa-rotate-left" title="Restore the default instructions"></div>
            </div>
            <textarea id="pf-system" class="text_pole pf-settings-area" rows="8"></textarea>

            <label for="pf-example">Example persona (optional)</label>
            <textarea id="pf-example" class="text_pole pf-settings-area" rows="6" spellcheck="false"
                placeholder="Paste a finished persona to show the model the depth and tone you want."></textarea>
        </div>
    </div>
</div>`;
}

function renderProfileOptions() {
    const select = $('#pf-profile').empty();
    select.append('<option value="">Current API</option>');
    const profiles = ctx().extensionSettings.connectionManager?.profiles ?? [];
    for (const profile of profiles) {
        select.append($('<option></option>').val(profile.id).text(profile.name));
    }
    const s = settings();
    if (s.profileId && !profiles.some(p => p.id === s.profileId)) s.profileId = '';
    select.val(s.profileId);
}

function bindSettings() {
    const s = settings();
    renderProfileOptions();
    $('#pf-profile').on('focus', renderProfileOptions).on('change', function() {
        s.profileId = String($(this).val() || '');
        save();
    });
    $('#pf-max-tokens').val(s.maxTokens).on('input', function() {
        s.maxTokens = Number($(this).val()) || defaultSettings.maxTokens;
        save();
    });
    $('#pf-rename-root').prop('checked', s.renameRoot).on('change', function() {
        s.renameRoot = $(this).prop('checked');
        save();
    });

    const bindArea = (selector, key) => $(selector).val(s[key]).on('input', function() {
        s[key] = String($(this).val());
        save();
    });
    bindArea('#pf-template', 'template');
    bindArea('#pf-system', 'systemPrompt');
    bindArea('#pf-example', 'example');

    $('#pf-reset-template').on('click', () => { s.template = DEFAULT_TEMPLATE; $('#pf-template').val(s.template); save(); });
    $('#pf-reset-system').on('click', () => { s.systemPrompt = DEFAULT_SYSTEM_PROMPT; $('#pf-system').val(s.systemPrompt); save(); });
    $('#pf-open-settings').on('click', openForge);
}

// ----------------------------------------------------------------------------- entry points

function addMenuButtons() {
    const wand = $(`
        <div id="pf-wand-button" class="list-group-item flex-container flexGap5 interactable" tabindex="0" title="Design a persona with the AI">
            <div class="fa-solid fa-hammer extensionsMenuExtensionButton"></div>
            <span>Persona Forge</span>
        </div>`);
    wand.on('click', openForge);
    $('#extensionsMenu').append(wand);

    // Next to "Create a dummy persona" in Persona Management.
    const personaButton = $('<div id="pf-persona-button" class="menu_button menu_button_icon" title="Design a persona with Persona Forge"><i class="fa-solid fa-hammer"></i></div>');
    personaButton.on('click', openForge);
    $('#create_dummy_persona').after(personaButton);
}

function registerSlashCommand() {
    const c = ctx();
    if (!c.SlashCommandParser || !c.SlashCommand) return;
    c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps({
        name: 'persona-forge',
        callback: async () => { openForge(); return ''; },
        helpString: 'Opens Persona Forge, the AI persona designer.',
    }));
}

jQuery(async () => {
    settings();
    $('#extensions_settings2').append(settingsHtml());
    bindSettings();
    addMenuButtons();
    registerSlashCommand();
});
