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

// Field styles shape how a value is written (its length and register), not what it says.
const LENGTH_PRESETS = {
    terse: { label: 'Terse — 1 to 4 words', guide: '1 to 4 words, a label rather than a sentence' },
    short: { label: 'Short phrase', guide: 'a short phrase, a dozen words at most' },
    concise: { label: 'One or two sentences', guide: 'one or two plain sentences' },
    detailed: { label: 'Detailed', guide: 'rich and specific, several sentences' },
};

// Keyed by plain path (no [n] suffixes), so one style covers every repeated item. A group's style covers its fields.
const DEFAULT_FIELD_STYLES = {
    'misc_attributes/scent/scent_hint': { length: 'terse', note: 'Like a candle scent name, e.g. "smoky vanilla", "black cardamom".' },
};

// Avatar prompt shot settings. Values are phrases handed to the model; the first choice of each is "AI's choice".
// Choices flagged nsfw only appear with the NSFW toggle on.
const AVATAR_FIELDS = [
    { key: 'framing', label: 'Framing', choices: [
        ['close-up of the face', 'Close-up (face)'],
        ['head-and-shoulders portrait', 'Portrait (head and shoulders)'],
        ['upper body, from the waist up', 'Upper body'],
        ['from the thighs up (cowboy shot)', 'Thighs up (cowboy shot)'],
        ['full body, head to toe', 'Full body'],
    ] },
    { key: 'angle', label: 'Camera angle', choices: [
        ['eye level, facing the camera', 'Eye level'],
        ['three-quarter view', 'Three-quarter view'],
        ['side profile', 'Side profile'],
        ['slightly from above', 'From above'],
        ['from below, low angle', 'From below'],
        ['from behind, looking back over the shoulder', 'From behind, looking back'],
        ['point of view, as if the viewer is with them', 'POV'],
    ] },
    { key: 'pose', label: 'Pose / activity', choices: [
        ['standing relaxed', 'Standing, relaxed'],
        ['standing with arms crossed', 'Arms crossed'],
        ['hand on hip', 'Hand on hip'],
        ['leaning against a wall', 'Leaning against a wall'],
        ['sitting in a chair', 'Sitting in a chair'],
        ['sitting on the floor', 'Sitting on the floor'],
        ['walking toward the camera', 'Walking'],
        ['lying on a bed', 'Lying on a bed'],
        ['taking a mirror selfie', 'Mirror selfie'],
        ['holding a drink', 'Holding a drink'],
        ['at work, doing their job', 'At work'],
        ['stretching', 'Stretching'],
        ['posing seductively', 'Posing seductively', true],
        ['kneeling on a bed', 'Kneeling on a bed', true],
        ['lying back on a bed, inviting', 'Lying back, inviting', true],
    ] },
    { key: 'expression', label: 'Expression', choices: [
        ['neutral expression', 'Neutral'],
        ['warm smile', 'Smiling'],
        ['laughing', 'Laughing'],
        ['smirking', 'Smirking'],
        ['serious, intense look', 'Serious'],
        ['shy, blushing', 'Shy / blushing'],
        ['flirty look', 'Flirty'],
        ['tired', 'Tired'],
        ['surprised', 'Surprised'],
        ['aroused, flushed, lips parted', 'Aroused', true],
    ] },
    { key: 'outfit', label: 'Outfit', choices: [
        ['what this character typically wears day to day', 'Their usual clothes'],
        ['casual clothes', 'Casual'],
        ['work clothes or uniform', 'Work clothes / uniform'],
        ['formal wear', 'Formal'],
        ['athletic wear', 'Athletic'],
        ['loungewear or pajamas', 'Loungewear / pajamas'],
        ['swimwear', 'Swimwear'],
        ['lingerie or underwear', 'Lingerie / underwear', true],
        ['partially undressed', 'Partially undressed', true],
        ['topless', 'Topless', true],
        ['fully nude', 'Nude', true],
    ] },
    { key: 'setting', label: 'Setting', choices: [
        ['plain studio backdrop', 'Studio backdrop'],
        ['simple solid-colour background', 'Simple background'],
        ['their bedroom', 'Bedroom'],
        ['their home', 'At home'],
        ['their workplace', 'Workplace'],
        ['a city street', 'City street'],
        ['a café or bar', 'Café / bar'],
        ['a nightclub', 'Nightclub'],
        ['a park or the countryside', 'Park / nature'],
        ['a beach', 'Beach'],
        ['a gym', 'Gym'],
        ['inside a car', 'In a car'],
    ] },
    { key: 'lighting', label: 'Lighting', choices: [
        ['soft natural daylight', 'Natural daylight'],
        ['golden hour sunlight', 'Golden hour'],
        ['soft studio lighting', 'Studio'],
        ['dramatic low-key lighting', 'Dramatic'],
        ['neon city lights at night', 'Neon night'],
        ['warm lamplight or candlelight', 'Lamplight / candlelight'],
        ['harsh on-camera flash', 'Camera flash'],
    ] },
    { key: 'photoStyle', label: 'Photo style (Krea)', choices: [
        ['photorealistic portrait photography', 'Photorealistic'],
        ['cinematic film still', 'Cinematic still'],
        ['candid amateur phone photo', 'Candid phone photo'],
        ['editorial fashion photograph', 'Editorial / fashion'],
        ['vintage 35mm film photograph', 'Vintage 35mm film'],
    ] },
];

const DEFAULT_AVATAR_OPTIONS = Object.freeze({
    krea: true,
    booru: true,
    nsfw: false,
    notes: '',
    ...Object.fromEntries(AVATAR_FIELDS.map(f => [f.key, ''])), // '' = AI's choice
});

const DEFAULT_BOORU_NEGATIVE = 'low_quality, worst_quality, bad_anatomy, bad_hands, text, error, missing_fingers, extra_digit, fewer_digits, cropped, jpeg_artifacts, signature, watermark, username, blurry, artist_name, out_of_focus, ugly, duplicate, morbid, mutilated, extra_fingers, mutated_hands, poorly_drawn_hands, poorly_drawn_face, mutation, deformed, bad_proportions, gross_proportions';
const DEFAULT_KREA_NEGATIVE = 'blurry, out of focus, low quality, jpeg artifacts, deformed hands, extra fingers, missing fingers, distorted face, bad anatomy, watermark, text, signature, cartoon, 3d render, plastic-looking skin';

const defaultSettings = Object.freeze({
    profileId: '',
    maxTokens: 3000,
    template: DEFAULT_TEMPLATE,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    example: '',
    renameRoot: true,
    historyLimit: 30,
    fieldStyles: DEFAULT_FIELD_STYLES,
    avatarOptions: DEFAULT_AVATAR_OPTIONS,
    booruUnderscores: true,
    booruQuality: 'masterpiece, best_quality, high_resolution',
    booruNegative: DEFAULT_BOORU_NEGATIVE,
    kreaNegative: DEFAULT_KREA_NEGATIVE,
    session: null,
});

const emptySession = () => ({
    concept: '',
    versions: [], // { xml, note, ts }
    index: -1,
    locks: [], // field paths
    log: [], // { type: 'user'|'ai'|'error'|'info', text, v }
    targetAvatar: '',
    avatarPrompts: null, // { krea?: { positive, negative }, booru?: { positive, negative }, v }
    card: null, // { options, name, draft }
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

// ----------------------------------------------------------------------------- field styles

/** The style that governs a plain path: its own, else the nearest styled group above it. */
function styleFor(plainPath) {
    const styles = settings().fieldStyles;
    const segments = plainPath.split('/');
    for (let i = segments.length; i > 0; i--) {
        const path = segments.slice(0, i).join('/');
        if (styles[path]) return { path, style: styles[path], inherited: i < segments.length };
    }
    return null;
}

function styleText(style) {
    return [LENGTH_PRESETS[style?.length]?.guide, style?.note?.trim()].filter(Boolean).join('. ');
}

/** Style guide lines for every style that touches the subtree at `scope` (all styles when scope is empty). */
function styleGuideBlock(scope = '') {
    const lines = Object.entries(settings().fieldStyles)
        .filter(([path]) => !scope || path === scope || path.startsWith(`${scope}/`) || scope.startsWith(`${path}/`))
        .map(([path, style]) => [path, styleText(style)])
        .filter(([, text]) => text)
        .map(([path, text]) => `- ${path}: ${text}`);
    if (!lines.length) return '';
    return 'Style guide for specific fields. A group\'s guide covers every field inside it; repeated fields share one guide. '
        + 'Follow it for length and phrasing:\n' + lines.join('\n');
}

const plainOf = (path) => path.replace(/\[\d+\]/g, '');

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
        styleGuideBlock(),
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
        styleGuideBlock(),
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
        styleFor(plainOf(path)) ? `Style for this field: ${styleText(styleFor(plainOf(path)).style)}.` : '',
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
        styleGuideBlock(plainOf(path)),
        `Respond with only that section's XML, from <${tag}> to </${tag}>. No commentary.`,
    ];
    return [
        { role: 'system', content: `${settings().systemPrompt.trim()}\n\nFor this task you are rewriting one section of an existing persona, and you output only that section.` },
        { role: 'user', content: parts.filter(Boolean).join('\n\n') },
    ];
}

/** @param {{path: string, value: string, style: string}[]} targets */
function buildRestyleMessages(targets) {
    const fields = targets
        .map(t => `<field path="${t.path}" style="${t.style.replace(/"/g, '\'')}">${t.value}</field>`)
        .join('\n');
    const parts = [
        'Rewrite each field value below so it follows its style. Keep what it says: the same facts, details and meaning. '
            + 'Change only the length and phrasing, trimming flourishes rather than inventing new content. If a value already fits its style, return it unchanged.',
        fields,
        'Return every field in the same format, one per line: <field path="...">new value</field>. No style attribute, no commentary.',
    ];
    return [
        { role: 'system', content: 'You are a copy editor for character profiles. You reshape the wording of field values to fit a style guide without changing their content.' },
        { role: 'user', content: parts.join('\n\n') },
    ];
}

// ----------------------------------------------------------------------------- avatar prompts

/** The saved shot options, with any newly added keys filled in place (the Avatar form holds this same object). */
function avatarOptions() {
    const options = settings().avatarOptions;
    for (const [key, value] of Object.entries(DEFAULT_AVATAR_OPTIONS)) {
        if (options[key] === undefined) options[key] = value;
    }
    return options;
}

function buildAvatarMessages(opts) {
    const underscores = settings().booruUnderscores;
    const rating = opts.nsfw
        ? 'This image may be NSFW. Nudity and sexual content are allowed where the outfit, pose or notes call for it; describe the body and anatomy plainly and faithfully to the profile. If nothing calls for it, keep it tasteful.'
        : 'This image must be safe for work: the character is clothed, with no nudity and nothing sexual.';
    const shot = AVATAR_FIELDS
        .filter(f => f.key !== 'photoStyle' || opts.krea)
        .map(f => `- ${f.label.replace(/ \(Krea\)$/, '')}: ${opts[f.key] || "AI's choice"}`);
    if (opts.notes.trim()) shot.push(`- Extra notes: ${opts.notes.trim()}`);

    const specs = [];
    const blocks = [];
    if (opts.krea) {
        specs.push('Krea 2 prompt, in <krea_positive>: one flowing paragraph of natural language, about 120 to 200 words, in this order: '
            + 'the subject (apparent age, ethnicity, build) and the framing; pose and placement in the frame; outfit; hair, face and distinguishing features; '
            + 'expression and gaze; setting and background; lighting; camera and lens; photographic style and colour grading. '
            + 'Concrete visual words, no metaphors, no names, no lists.');
        specs.push('Krea 2 negative, in <krea_negative>: a short comma-separated list of things that would be wrong for this particular image '
            + '(for example the wrong hair length or colour, a beard on a clean-shaven face, tattoos the character does not have). '
            + 'Leave out generic quality terms; those are added separately.');
        blocks.push('<krea_positive>…</krea_positive>', '<krea_negative>…</krea_negative>');
    }
    if (opts.booru) {
        const form = underscores ? 'with words joined by underscores (long_hair, blue_eyes)' : 'with words separated by spaces (long hair, blue eyes)';
        specs.push(`Booru tags, in <booru_positive>: 25 to 45 comma-separated Danbooru tags ${form}, in this order: `
            + 'subject count (1girl, 1boy or 1other); hair; eyes; skin and body; distinguishing features; outfit; expression; pose; framing and angle; background; lighting. '
            + 'Real Danbooru tags only. No sentences, and no quality or score tags; those are added separately.');
        specs.push('Booru negative, in <booru_negative>: Danbooru tags for things that would be wrong for this particular image '
            + `(for example ${underscores ? 'long_hair' : 'long hair'} for a crew cut, ${underscores ? 'facial_hair' : 'facial hair'} for a clean-shaven face). No generic quality tags.`);
        blocks.push('<booru_positive>…</booru_positive>', '<booru_negative>…</booru_negative>');
    }

    const system = [
        'You write prompts for image generation models from a character profile.',
        '- Describe only what a camera would see. Turn the profile into appearance: apparent age, ethnicity and skin tone, build, hair, eyes, face and distinguishing marks; let personality show only through expression and posture. Leave out names, backstory, scent, voice and anything invisible.',
        '- Keep every physical detail faithful to the profile.',
        '- Follow each shot setting exactly. Where a setting is "AI\'s choice", pick what best suits the character.',
        `- ${rating}`,
    ].join('\n');
    const user = [
        `<character_profile>\n${currentXml()}\n</character_profile>`,
        `Shot settings:\n${shot.join('\n')}`,
        `Write:\n${specs.map(s => `- ${s}`).join('\n')}`,
        `Output exactly these blocks and nothing else:\n${blocks.join('\n')}`,
    ].join('\n\n');
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

const splitList = (text) => String(text ?? '').split(/[,\n]/).map(t => t.trim()).filter(Boolean);

/** Joins comma lists, dropping repeats (long_hair and long hair count as the same tag). */
function mergeList(lists, formatTag = t => t) {
    const seen = new Set();
    const out = [];
    for (const item of lists.flatMap(splitList).map(formatTag)) {
        const key = item.toLowerCase().replace(/[_\s]+/g, ' ');
        if (!seen.has(key)) {
            seen.add(key);
            out.push(item);
        }
    }
    return out.join(', ');
}

function booruTag(tag) {
    // Leave weighted or escaped tags like (smile:1.2) alone apart from the separator.
    return settings().booruUnderscores ? tag.replace(/\s+/g, '_') : tag.replace(/_/g, ' ');
}

const SFW_BOORU_NEGATIVE = 'nsfw, nude, nipples, pussy, penis, sex';
const SFW_KREA_NEGATIVE = 'nudity, nsfw, exposed breasts, genitals';

/** Turns the model's reply into final prompts: the model's part merged with the fixed parts from settings. */
function finalizeAvatarPrompts(reply, opts) {
    const s = settings();
    const text = String(reply).replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '');
    const block = (name) => text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1].trim() ?? null;
    const result = {};
    const missing = [];

    if (opts.krea) {
        const positive = block('krea_positive');
        if (!positive) missing.push('Krea 2');
        else {
            result.krea = {
                positive: positive.replace(/\s*\n+\s*/g, ' '),
                negative: mergeList([block('krea_negative'), s.kreaNegative, opts.nsfw ? '' : SFW_KREA_NEGATIVE]),
            };
        }
    }
    if (opts.booru) {
        const positive = block('booru_positive');
        if (!positive) missing.push('booru');
        else {
            result.booru = {
                positive: mergeList([s.booruQuality, positive], booruTag),
                negative: mergeList([block('booru_negative'), s.booruNegative, opts.nsfw ? '' : SFW_BOORU_NEGATIVE], booruTag),
            };
        }
    }
    return { result, missing };
}

// ----------------------------------------------------------------------------- character cards

const CARD_ERAS = [
    ['present day', 'Present day'],
    ['the near future', 'Near future'],
    ['the far future', 'Far future'],
    ['the 1950s', '1950s'],
    ['the 1970s', '1970s'],
    ['the 1980s', '1980s'],
    ['the 1990s', '1990s'],
    ['the 2000s', '2000s'],
    ['the Victorian era', 'Victorian era'],
    ['the Middle Ages', 'Middle Ages'],
    ['a fantasy world', 'Fantasy world'],
    ['a science-fiction setting', 'Science fiction'],
    ['a post-apocalyptic world', 'Post-apocalyptic'],
];

const CARD_NARRATION = [
    ['third person, past tense', 'Third person, past tense'],
    ['third person, present tense', 'Third person, present tense'],
    ['second person, addressing {{user}} as "you"', 'Second person ("you")'],
    ['first person, as {{char}}', 'First person, as the character'],
];

const CARD_LENGTHS = {
    short: ['one paragraph', 'Short: one paragraph'],
    medium: ['two or three paragraphs', 'Medium: 2 or 3 paragraphs'],
    long: ['four to six paragraphs', 'Long: 4 to 6 paragraphs'],
};

const CARD_FORMATS = {
    asterisks: ['narration and actions in *asterisks*, speech in "quotes"', '*Actions* and "speech"'],
    prose: ['plain novel-style prose, speech in "quotes"', 'Novel-style prose'],
};

const DEFAULT_CARD_OPTIONS = Object.freeze({
    era: 'present day', // '' = AI's choice
    year: '',
    location: '',
    premise: '',
    opening: '',
    narration: CARD_NARRATION[0][0],
    length: 'medium',
    format: 'asterisks',
    greetings: [], // one scene prompt per alternate greeting ('' = AI's choice)
    exampleDialogue: true,
});

function cardState() {
    const s = session();
    s.card ??= { options: structuredClone(DEFAULT_CARD_OPTIONS), name: '', draft: null };
    for (const [key, value] of Object.entries(DEFAULT_CARD_OPTIONS)) {
        if (s.card.options[key] === undefined) s.card.options[key] = structuredClone(value);
    }
    return s.card;
}

const CARD_SYSTEM = 'You turn a character profile into a SillyTavern character card for roleplay. '
    + 'Write in character, vividly and concretely, consistent with every detail of the profile. '
    + 'Refer to the character as {{char}} and to the person chatting with them as {{user}}. '
    + 'Never decide what {{user}} looks like, says, does, thinks or feels.';

function cardStyle(opts) {
    return `${opts.narration}, ${CARD_LENGTHS[opts.length]?.[0] ?? CARD_LENGTHS.medium[0]}, with ${CARD_FORMATS[opts.format]?.[0] ?? CARD_FORMATS.asterisks[0]}`;
}

function buildCardMessages(opts, name) {
    const settingsLines = [
        `- Name: ${name}`,
        `- Era: ${opts.era || "AI's choice"}`,
        `- Starting year: ${opts.year.trim() || "AI's choice, fitting the era"}`,
        `- Location: ${opts.location.trim() || "AI's choice"}`,
        `- Premise: ${opts.premise.trim() || "AI's choice: an interesting reason for {{char}} and {{user}} to be together"}`,
        `- Opening scene: ${opts.opening.trim() || "AI's choice, fitting the premise"}`,
        `- Opening message style: ${cardStyle(opts)}`,
    ];
    const blocks = [
        '- <scenario>: two to four sentences of background: when and where this takes place (including the era and year) and the situation between {{char}} and {{user}} as the chat begins. Background, not narration.',
        '- <personality>: a 40 to 80 word summary of {{char}}\'s personality.',
        `- <first_mes>: the chat's opening message, written as ${cardStyle(opts)}. Set the opening scene through narration and {{char}}'s words and actions, and end on a moment {{user}} can respond to.`,
        opts.exampleDialogue
            ? '- <mes_example>: two short example exchanges showing how {{char}} talks and acts. Start each with <START> on its own line, followed by alternating lines that begin "{{user}}:" and "{{char}}:".'
            : '',
        '- <tags>: 4 to 8 comma-separated lowercase tags (genre, setting, notable traits).',
        '- <creator_notes>: one or two sentences describing the card for someone browsing a character list.',
    ].filter(Boolean);
    const user = [
        `<character_profile>\n${currentXml()}\n</character_profile>`,
        `Card settings:\n${settingsLines.join('\n')}`,
        `Write these blocks:\n${blocks.join('\n')}`,
        'Output exactly these blocks, each wrapped in its tags, and nothing else.',
    ].join('\n\n');
    return [{ role: 'system', content: CARD_SYSTEM }, { role: 'user', content: user }];
}

function buildGreetingMessages(opts, draft, scene) {
    const earlier = [draft.first_mes, ...draft.alternate_greetings];
    const user = [
        `<character_profile>\n${currentXml()}\n</character_profile>`,
        `<scenario>\n${draft.scenario}\n</scenario>`,
        `The card's existing opening messages, for contrast only. Do not repeat their scenes or wording:\n${earlier.map(text => `<greeting>\n${text}\n</greeting>`).join('\n')}`,
        `Write an alternate opening message for this starting scene:\n<scene>\n${scene.trim() || "AI's choice: a different starting scene that fits the scenario"}\n</scene>`,
        `Write it as ${cardStyle(opts)}. The time and place may shift if the scene calls for it, but {{char}} is the same person. End on a moment {{user}} can respond to.`,
        'Output only the new message, wrapped in <greeting></greeting>.',
    ].join('\n\n');
    return [{ role: 'system', content: CARD_SYSTEM }, { role: 'user', content: user }];
}

/** Pulls one tagged block out of a reply; reasoning blocks are ignored. */
function replyBlock(reply, name) {
    const text = String(reply).replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '');
    return text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1].trim() ?? null;
}

function parseCardReply(reply, opts, name) {
    const scenario = replyBlock(reply, 'scenario');
    const firstMes = replyBlock(reply, 'first_mes');
    if (!scenario || !firstMes) {
        throw new Error('The reply was missing the scenario or the opening message. Try again, or raise Max response tokens.');
    }
    let example = opts.exampleDialogue ? (replyBlock(reply, 'mes_example') ?? '') : '';
    if (example && !/^<START>/i.test(example)) example = `<START>\n${example}`;
    return {
        name,
        description: currentXml(),
        scenario,
        personality: replyBlock(reply, 'personality') ?? '',
        first_mes: firstMes,
        mes_example: example,
        tags: splitList(replyBlock(reply, 'tags') ?? '').map(t => t.toLowerCase()).join(', '),
        creator_notes: replyBlock(reply, 'creator_notes') ?? '',
        alternate_greetings: [],
        vts: currentVersion()?.ts,
    };
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
                <div id="pf-restyle" class="menu_button menu_button_icon" title="Rewrite every field that has a style so it fits it, without changing what it says. Set styles with the sliders button on a field or group.">
                    <i class="fa-solid fa-sliders"></i><span>Restyle</span>
                </div>
            </div>
        </div>
    </div>
    <div class="pf-right">
        <div class="pf-toolbar">
            <div class="pf-tabs">
                <div class="pf-tab pf-tab-design" data-tab="design" title="Concept, design log and refinements">Design</div>
                <div class="pf-tab active" data-tab="fields">Fields</div>
                <div class="pf-tab" data-tab="xml">XML</div>
                <div class="pf-tab" data-tab="avatar" title="Write image-generation prompts for this persona">Avatar</div>
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
        <div id="pf-avatar" class="pf-pane pf-avatar pf-hidden"></div>
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
            <div id="pf-card" class="menu_button menu_button_icon" title="Turn this persona into a character card, with a scenario and greetings written by the AI">
                <i class="fa-solid fa-id-card"></i><span>Make card</span>
            </div>
        </div>
    </div>
</div>`;
}

// Phones and narrow windows (SillyTavern's own mobile breakpoint) show one pane at a time, with the
// left column as a "Design" tab. The CSS keys off the same query.
const mobileQuery = window.matchMedia('(max-width: 1000px)');
let currentTab = 'fields';

function setTab(tab) {
    if (!ui) return;
    if (tab === 'design' && !mobileQuery.matches) tab = 'fields';
    currentTab = tab;
    ui.attr('data-tab', tab);
    ui.find('.pf-tab').removeClass('active').filter(`[data-tab="${tab}"]`).addClass('active');
    ui.find('#pf-fields').toggleClass('pf-hidden', tab !== 'fields');
    ui.find('#pf-xml').toggleClass('pf-hidden', tab !== 'xml');
    ui.find('#pf-avatar').toggleClass('pf-hidden', tab !== 'avatar');
    if (tab === 'fields') renderFields();
    if (tab === 'avatar') renderAvatarResults();
}

function onViewportChange() {
    if (ui && currentTab === 'design' && !mobileQuery.matches) setTab('fields');
}

function setBusy(busy, label = '') {
    if (!ui) return;
    ui.find('#pf-generate, #pf-apply, #pf-load, #pf-update, #pf-create, #pf-new-session, #pf-card, .pf-reroll, .pf-reroll-section, .pf-add-field, .pf-remove-field, #pf-restyle, .pf-style, #pf-avatar-generate').toggleClass('disabled', busy);
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
    renderAvatarResults();
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

const KREA_CFG_NOTE = 'Krea 2 Turbo runs at CFG 1, where ComfyUI ignores the negative prompt. It only applies if you raise CFG.';

/** Builds the Avatar tab's form (once per window) and binds it to the saved options. */
function buildAvatarPane() {
    const opts = avatarOptions();
    const pane = ui.find('#pf-avatar').empty();
    const form = $(`
        <div class="pf-avatar-form">
            <div class="pf-avatar-toggles">
                <label class="checkbox_label"><input type="checkbox" data-opt="krea"> Krea 2 (natural language)</label>
                <label class="checkbox_label"><input type="checkbox" data-opt="booru"> Booru tags</label>
                <label class="checkbox_label pf-nsfw-toggle" title="Allows nudity and sexual content, and unlocks the NSFW choices below"><input type="checkbox" data-opt="nsfw"> NSFW</label>
            </div>
            <div class="pf-avatar-grid"></div>
            <label class="pf-avatar-notes">Extra details (optional)
                <input type="text" class="text_pole" data-opt="notes" placeholder="e.g. holding a coffee, rain on the window, wearing his old firefighter jacket">
            </label>
            <div class="pf-row">
                <div id="pf-avatar-generate" class="menu_button menu_button_icon" title="Write image prompts for the version you're viewing">
                    <i class="fa-solid fa-camera"></i><span>Write prompts</span>
                </div>
                <small class="pf-avatar-hint">Uses the version you're viewing. Fixed tags and base negatives are in the extension settings.</small>
            </div>
        </div>
        <div class="pf-avatar-results"></div>`);

    const grid = form.find('.pf-avatar-grid');
    for (const field of AVATAR_FIELDS) {
        const select = $(`<select class="text_pole" data-opt="${field.key}"><option value="">AI's choice</option></select>`);
        for (const [value, label, nsfw] of field.choices) {
            select.append($('<option></option>').val(value).text(nsfw ? `${label} (NSFW)` : label).attr('data-nsfw', nsfw ? '1' : null));
        }
        grid.append($('<label class="pf-avatar-field"></label>').text(field.label).append(select));
    }
    pane.append(form);

    const syncNsfw = () => {
        form.find('option[data-nsfw]').prop('hidden', !opts.nsfw).prop('disabled', !opts.nsfw);
        for (const field of AVATAR_FIELDS) {
            const chosen = field.choices.find(([value]) => value === opts[field.key]);
            if (chosen?.[2] && !opts.nsfw) opts[field.key] = '';
        }
        form.find('[data-opt="photoStyle"]').prop('disabled', !opts.krea);
        form.find('[data-opt]').each(function() {
            const key = $(this).attr('data-opt');
            if (this.type === 'checkbox') $(this).prop('checked', !!opts[key]);
            else $(this).val(opts[key] ?? '');
        });
    };
    syncNsfw();

    form.on('change input', '[data-opt]', function(e) {
        const key = $(this).attr('data-opt');
        if (this.type === 'checkbox') {
            if (e.type !== 'change') return;
            opts[key] = $(this).prop('checked');
            if ((key === 'krea' || key === 'booru') && !opts.krea && !opts.booru) {
                opts[key] = true;
                toastr.info('Pick at least one prompt format.');
            }
        } else {
            opts[key] = String($(this).val() ?? '');
        }
        if (this.type === 'checkbox') syncNsfw();
        save();
    });
    form.find('#pf-avatar-generate').on('click', runAvatarPrompts);

    const results = pane.find('.pf-avatar-results');
    results.on('click', '.pf-copy-out', async function() {
        const text = String($(this).closest('.pf-avatar-out').find('textarea').val() || '');
        if (!text) return;
        await navigator.clipboard.writeText(text);
        toastr.success('Copied to clipboard.');
    });
    results.on('input', 'textarea', function() {
        const format = $(this).closest('.pf-avatar-result').attr('data-format');
        const part = $(this).attr('data-part');
        const prompts = session().avatarPrompts;
        if (prompts?.[format]) {
            prompts[format][part] = String($(this).val());
            save();
        }
    });
}

function renderAvatarResults() {
    const box = ui?.find('.pf-avatar-results').empty();
    if (!box?.length) return;
    const prompts = session().avatarPrompts;
    if (!prompts || (!prompts.krea && !prompts.booru)) {
        box.append('<div class="pf-empty">Pick the shot, then <b>Write prompts</b>. The AI turns the persona\'s looks into prompts for Krea 2 and booru-tag models.</div>');
        return;
    }
    if (prompts.vts && prompts.vts !== currentVersion()?.ts) {
        box.append('<div class="pf-avatar-stale"><i class="fa-solid fa-circle-info"></i> These prompts were written for a different version than the one you\'re viewing.</div>');
    }
    const formats = [['krea', 'Krea 2', KREA_CFG_NOTE], ['booru', 'Booru tags', '']];
    for (const [format, title, negativeNote] of formats) {
        const data = prompts[format];
        if (!data) continue;
        const block = $(`
            <div class="pf-avatar-result" data-format="${format}">
                <div class="pf-avatar-result-head">${escapeHtml(title)}</div>
                <div class="pf-avatar-out">
                    <div class="pf-avatar-out-head"><span>Positive</span><i class="fa-solid fa-copy pf-copy-out" title="Copy"></i></div>
                    <textarea class="text_pole" data-part="positive" rows="${format === 'krea' ? 7 : 5}"></textarea>
                </div>
                <div class="pf-avatar-out">
                    <div class="pf-avatar-out-head"><span>Negative</span><i class="fa-solid fa-copy pf-copy-out" title="Copy"></i></div>
                    <textarea class="text_pole" data-part="negative" rows="3"></textarea>
                    ${negativeNote ? `<small class="pf-avatar-note">${escapeHtml(negativeNote)}</small>` : ''}
                </div>
            </div>`);
        block.find('[data-part="positive"]').val(data.positive);
        block.find('[data-part="negative"]').val(data.negative);
        box.append(block);
    }
}

async function runAvatarPrompts() {
    if (isBusy()) return;
    if (!currentXml()) return toastr.info('Generate or load a persona first.');
    const opts = avatarOptions();
    if (!opts.krea && !opts.booru) return toastr.info('Pick at least one prompt format.');

    setBusy(true, 'Writing image prompts…');
    try {
        const reply = await callModel(buildAvatarMessages(opts));
        const { result, missing } = finalizeAvatarPrompts(reply, opts);
        if (!result.krea && !result.booru) {
            throw new Error('The reply didn\'t contain the prompt blocks. Try again, or raise Max response tokens.');
        }
        const s = session();
        s.avatarPrompts = { ...result, vts: currentVersion()?.ts };
        save();
        const names = [result.krea && 'Krea 2', result.booru && 'booru'].filter(Boolean).join(' and ');
        addLog('ai', `Wrote ${names} avatar prompts for v${s.index + 1}.${missing.length ? ` The ${missing.join(' and ')} prompt was missing from the reply.` : ''}`);
    } catch (err) {
        reportError(err);
    } finally {
        setBusy(false);
        if (ui) {
            renderLog();
            renderAvatarResults();
        }
    }
}

// ----------------------------------------------------------------------------- character card dialogs

const selectOptions = (pairs, selected) => pairs
    .map(([value, label]) => `<option value="${escapeHtml(value)}"${value === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`)
    .join('');

/** Step 1: ask for the scenario, the opening and any alternate greetings, then write the card. */
async function openCardDialog() {
    if (isBusy()) return;
    if (!currentXml()) return toastr.info('Generate or load a persona first.');
    const c = ctx();
    const state = cardState();
    const opts = state.options;
    const { doc } = parseXml(currentXml());
    const name = state.name || personaName(doc);

    const form = $(`
        <div class="pf-card-form">
            <h3>Make a character card</h3>
            <p class="pf-card-intro">Turns this persona into a standalone character. The AI writes the scenario, opening message and other card fields from your answers. You can review and edit everything before the card is created.</p>
            <label>Card name <input class="text_pole" data-card="name" type="text"></label>
            <fieldset>
                <legend>Scenario</legend>
                <div class="pf-card-grid">
                    <label>Era <select class="text_pole" data-card="era"><option value="">AI's choice</option>${selectOptions(CARD_ERAS, opts.era)}</select></label>
                    <label>Starting year <input class="text_pole" data-card="year" type="text" inputmode="numeric" placeholder="AI's choice"></label>
                    <label>Location <input class="text_pole" data-card="location" type="text" placeholder="e.g. Chicago, Bridgeport"></label>
                </div>
                <label>Premise
                    <textarea class="text_pole" data-card="premise" rows="3" placeholder="How do {{char}} and {{user}} know each other, and what's going on? e.g. {{user}} just moved into the apartment across the hall."></textarea>
                </label>
            </fieldset>
            <fieldset>
                <legend>Opening message</legend>
                <label>Opening scene
                    <textarea class="text_pole" data-card="opening" rows="3" placeholder="What's happening when the chat starts? e.g. {{char}} knocks on {{user}}'s door to borrow a ladder. Leave blank for the AI's choice."></textarea>
                </label>
                <div class="pf-card-grid">
                    <label>Narration <select class="text_pole" data-card="narration">${selectOptions(CARD_NARRATION, opts.narration)}</select></label>
                    <label>Length <select class="text_pole" data-card="length">${selectOptions(Object.entries(CARD_LENGTHS).map(([k, v]) => [k, v[1]]), opts.length)}</select></label>
                    <label>Formatting <select class="text_pole" data-card="format">${selectOptions(Object.entries(CARD_FORMATS).map(([k, v]) => [k, v[1]]), opts.format)}</select></label>
                </div>
            </fieldset>
            <fieldset>
                <legend>Alternate greetings</legend>
                <p class="pf-card-note"><i class="fa-solid fa-clock"></i> Each alternate greeting is written in its own request, so every one you add makes the card take longer to generate.</p>
                <div class="pf-card-greetings"></div>
                <div class="menu_button menu_button_icon pf-card-add-greeting"><i class="fa-solid fa-plus"></i><span>Add alternate greeting</span></div>
            </fieldset>
            <label class="checkbox_label"><input type="checkbox" data-card="exampleDialogue"> Write example dialogue</label>
            <p class="pf-card-estimate"></p>
        </div>`);

    form.find('[data-card="name"]').val(name);
    for (const key of ['year', 'location', 'premise', 'opening']) form.find(`[data-card="${key}"]`).val(opts[key]);
    form.find('[data-card="era"]').val(opts.era);
    form.find('[data-card="exampleDialogue"]').prop('checked', opts.exampleDialogue);

    const renderGreetings = () => {
        const list = form.find('.pf-card-greetings').empty();
        opts.greetings.forEach((scene, i) => {
            const row = $(`<div class="pf-card-greeting">
                <span class="pf-card-greeting-num">${i + 2}</span>
                <textarea class="text_pole" rows="2" placeholder="Starting scene for this greeting, or leave blank for the AI's choice"></textarea>
                <i class="fa-solid fa-xmark pf-card-remove-greeting" title="Remove this greeting"></i>
            </div>`);
            row.find('textarea').val(scene).on('input', function() { opts.greetings[i] = String($(this).val()); save(); });
            row.find('.pf-card-remove-greeting').on('click', () => { opts.greetings.splice(i, 1); save(); renderGreetings(); });
            list.append(row);
        });
        const requests = 1 + opts.greetings.length;
        form.find('.pf-card-estimate').text(opts.greetings.length
            ? `Greeting 1 is the opening message above. This card takes ${requests} requests: one for the card, plus one per alternate greeting.`
            : 'This card takes one request.');
    };
    renderGreetings();
    form.find('.pf-card-add-greeting').on('click', () => { opts.greetings.push(''); save(); renderGreetings(); form.find('.pf-card-greeting textarea').last().trigger('focus'); });

    let cardName = name;
    form.on('input change', '[data-card]', function() {
        const key = $(this).attr('data-card');
        const value = this.type === 'checkbox' ? $(this).prop('checked') : String($(this).val());
        if (key === 'name') cardName = String(value).trim();
        else opts[key] = value;
        save();
    });

    const REVIEW = c.POPUP_RESULT?.CUSTOM1 ?? 1001;
    const popup = new c.Popup(form, c.POPUP_TYPE.CONFIRM, '', {
        okButton: 'Write card',
        cancelButton: 'Cancel',
        wide: true,
        allowVerticalScrolling: true,
        customButtons: state.draft ? [{ text: 'Review last draft', result: REVIEW }] : null,
        onClosing: (p) => {
            if (p.result === (c.POPUP_RESULT?.AFFIRMATIVE ?? 1) && !cardName) {
                toastr.warning('Give the card a name.');
                return false;
            }
            return true;
        },
    });
    $(popup.dlg).addClass('pf-card-dialog');
    const result = await popup.show();
    state.name = cardName;
    save();

    if (result === REVIEW) return openCardReview();
    if (result === (c.POPUP_RESULT?.AFFIRMATIVE ?? 1)) await runCardGeneration(cardName);
}

/** Step 2: one request for the card, then one per alternate greeting. */
async function runCardGeneration(name) {
    if (isBusy()) return;
    const state = cardState();
    const opts = state.options;
    const total = 1 + opts.greetings.length;
    let draft = null;

    setBusy(true, total > 1 ? `Writing the card (1 of ${total})…` : 'Writing the card…');
    try {
        draft = parseCardReply(await callModel(buildCardMessages(opts, name)), opts, name);
        for (const [i, scene] of opts.greetings.entries()) {
            setBusy(true, `Writing alternate greeting ${i + 1} of ${opts.greetings.length} (${i + 2} of ${total})…`);
            const reply = await callModel(buildGreetingMessages(opts, draft, scene));
            const greeting = replyBlock(reply, 'greeting') ?? extractFieldValue(reply, 'greeting');
            if (greeting) draft.alternate_greetings.push(greeting);
        }
        addLog('ai', `Wrote a character card for ${name}${draft.alternate_greetings.length ? ` with ${draft.alternate_greetings.length} alternate greeting${draft.alternate_greetings.length === 1 ? '' : 's'}` : ''}.`);
    } catch (err) {
        reportError(err);
        // Keep whatever finished, so the work isn't lost; it can be reviewed from the Make card dialog.
        if (draft) addLog('info', 'The card draft was saved as far as it got. Open Make card → Review last draft to see it.');
    } finally {
        if (draft) {
            state.draft = draft;
            save();
        }
        setBusy(false);
        if (ui) renderLog();
    }
    const complete = draft && draft.alternate_greetings.length === opts.greetings.length;
    if (complete) await openCardReview();
}

/** Step 3: review and edit the draft, choose the avatar, then create the character. */
async function openCardReview() {
    const c = ctx();
    const state = cardState();
    const draft = state.draft;
    if (!draft) return;

    const personaAvatar = session().targetAvatar && c.powerUserSettings.personas?.[session().targetAvatar] ? session().targetAvatar : '';
    const personaLabel = personaAvatar ? c.powerUserSettings.personas[personaAvatar] : '';
    const form = $(`
        <div class="pf-card-form pf-card-review">
            <h3>Review the card</h3>
            <p class="pf-card-intro">Edit anything you like. Nothing is created until you press <b>Create character</b>.</p>
            ${draft.vts && draft.vts !== currentVersion()?.ts ? '<p class="pf-card-note"><i class="fa-solid fa-circle-info"></i> This draft was written from a different persona version than the one you\'re viewing. Its description is the version it was written from.</p>' : ''}
            <label>Name <input class="text_pole" data-draft="name" type="text"></label>
            <label>Scenario <textarea class="text_pole" data-draft="scenario" rows="4"></textarea></label>
            <label>Personality summary <textarea class="text_pole" data-draft="personality" rows="3"></textarea></label>
            <label>First message <textarea class="text_pole" data-draft="first_mes" rows="9"></textarea></label>
            <div class="pf-card-alts"></div>
            <label>Example dialogue <textarea class="text_pole" data-draft="mes_example" rows="6" placeholder="(none)"></textarea></label>
            <label>Tags <input class="text_pole" data-draft="tags" type="text"></label>
            <label>Creator notes <textarea class="text_pole" data-draft="creator_notes" rows="2"></textarea></label>
            <details class="pf-card-description">
                <summary>Description (the persona)</summary>
                <textarea class="text_pole" data-draft="description" rows="10" spellcheck="false"></textarea>
            </details>
            <fieldset>
                <legend>Avatar</legend>
                <select class="text_pole pf-card-avatar-source">
                    ${personaAvatar ? `<option value="persona">Use ${escapeHtml(personaLabel)}'s persona avatar</option>` : ''}
                    <option value="file">Choose an image…</option>
                    <option value="default"${personaAvatar ? '' : ' selected'}>Default avatar</option>
                </select>
                <input type="file" accept="image/*" class="pf-card-avatar-file pf-hidden">
            </fieldset>
            <label class="checkbox_label"><input type="checkbox" class="pf-card-open" checked> Open the character when it's created</label>
        </div>`);

    for (const key of ['name', 'scenario', 'personality', 'first_mes', 'mes_example', 'tags', 'creator_notes', 'description']) {
        form.find(`[data-draft="${key}"]`).val(draft[key] ?? '');
    }
    form.on('input', '[data-draft]', function() {
        draft[$(this).attr('data-draft')] = String($(this).val());
        save();
    });

    const renderAlts = () => {
        const box = form.find('.pf-card-alts').empty();
        draft.alternate_greetings.forEach((text, i) => {
            const block = $(`<label class="pf-card-alt">
                <span class="pf-card-alt-head">Alternate greeting ${i + 1} <i class="fa-solid fa-xmark pf-card-remove-alt" title="Remove this greeting"></i></span>
                <textarea class="text_pole" rows="7"></textarea>
            </label>`);
            block.find('textarea').val(text).on('input', function() { draft.alternate_greetings[i] = String($(this).val()); save(); });
            block.find('.pf-card-remove-alt').on('click', (e) => { e.preventDefault(); draft.alternate_greetings.splice(i, 1); save(); renderAlts(); });
            box.append(block);
        });
    };
    renderAlts();

    const fileInput = form.find('.pf-card-avatar-file');
    form.find('.pf-card-avatar-source').on('change', function() {
        fileInput.toggleClass('pf-hidden', $(this).val() !== 'file');
    });

    let choice = null;
    const popup = new c.Popup(form, c.POPUP_TYPE.CONFIRM, '', {
        okButton: 'Create character',
        cancelButton: 'Not now',
        wide: true,
        allowVerticalScrolling: true,
        onClosing: (p) => {
            if (p.result !== (c.POPUP_RESULT?.AFFIRMATIVE ?? 1)) return true;
            if (!String(draft.name ?? '').trim()) {
                toastr.warning('Give the character a name.');
                return false;
            }
            const source = String(form.find('.pf-card-avatar-source').val());
            const file = fileInput[0].files?.[0] ?? null;
            if (source === 'file' && !file) {
                toastr.warning('Choose an image, or pick another avatar option.');
                return false;
            }
            choice = { source, file, open: form.find('.pf-card-open').prop('checked'), personaAvatar };
            return true;
        },
    });
    $(popup.dlg).addClass('pf-card-dialog');
    await popup.show();
    if (choice) await createCharacterCard(draft, choice);
}

/** Loads the chosen avatar image (cropped to the card's 2:3 shape unless the user never resizes avatars). */
async function cardAvatarBlob(choice) {
    const c = ctx();
    let url = null;
    if (choice.source === 'file' && choice.file) url = URL.createObjectURL(choice.file);
    else if (choice.source === 'persona' && choice.personaAvatar) {
        const mod = await loadPersonasModule();
        url = mod.getUserAvatar?.(choice.personaAvatar) ?? `User Avatars/${choice.personaAvatar}`;
    }
    if (!url) return null;

    const original = await (await fetch(url, { cache: 'no-cache' })).blob();
    if (c.powerUserSettings.never_resize_avatars || c.POPUP_TYPE?.CROP === undefined) return original;

    const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = reject;
        reader.readAsDataURL(original);
    });
    const cropped = await new c.Popup('Crop the character avatar', c.POPUP_TYPE.CROP, '', { cropImage: dataUrl, cropAspect: 2 / 3 }).show();
    return cropped ? await (await fetch(String(cropped))).blob() : original;
}

async function createCharacterCard(draft, choice) {
    const c = ctx();
    try {
        const form = new FormData();
        const fields = {
            ch_name: draft.name.trim(),
            description: draft.description,
            personality: draft.personality,
            scenario: draft.scenario,
            first_mes: draft.first_mes,
            mes_example: draft.mes_example,
            creator_notes: draft.creator_notes,
            tags: draft.tags,
            creator: '',
            character_version: '',
            talkativeness: '0.5',
            fav: 'false',
            extensions: '{}',
        };
        for (const [key, value] of Object.entries(fields)) form.append(key, value ?? '');
        for (const greeting of draft.alternate_greetings.filter(g => g.trim())) form.append('alternate_greetings', greeting);

        const avatar = await cardAvatarBlob(choice);
        if (avatar) form.append('avatar', new File([avatar], 'avatar.png', { type: avatar.type || 'image/png' }));

        const res = await fetch('/api/characters/create', {
            method: 'POST',
            headers: c.getRequestHeaders({ omitContentType: true }),
            body: form,
            cache: 'no-cache',
        });
        if (!res.ok) throw new Error(`SillyTavern couldn't create the character (${res.status} ${res.statusText}).`);
        const avatarId = (await res.text()).trim();

        await c.getCharacters?.();
        addLog('info', `Created character ${fields.ch_name}.`);
        toastr.success(`Character ${fields.ch_name} created.`);
        if (choice.open) {
            const index = c.characters?.findIndex(ch => ch.avatar === avatarId) ?? -1;
            if (index >= 0) await c.selectCharacterById(index);
        }
    } catch (err) {
        reportError(err);
    }
    if (ui) renderLog();
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

    const styleIcon = (plainPath) => {
        const found = styleFor(plainPath);
        const state = !found ? '' : (found.inherited ? ' pf-style-inherited' : ' pf-styled');
        const tip = !found
            ? 'Set a style (length and phrasing) for this'
            : `${found.inherited ? `Style from ${prettyPath(found.path)}` : 'Style'}: ${styleText(found.style)}
Click to change`;
        return `<i class="fa-solid fa-sliders pf-style${state}" data-plain="${escapeHtml(plainPath)}" title="${escapeHtml(tip)}"></i>`;
    };

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
                        ${styleIcon(elementPath(el, true))}
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
            actions.append(styleIcon(elementPath(el, true)));
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
        if (ui && currentTab === 'design') setTab('fields');
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

/** Edits the style for a plain path (a field, all its repeats, or a whole group). */
async function editStyle(plainPath, isGroup) {
    const c = ctx();
    const styles = settings().fieldStyles;
    const own = styles[plainPath] ?? { length: '', note: '' };
    const found = styleFor(plainPath);
    const inherited = found?.inherited ? found : null;

    const form = $(`
        <div class="pf-style-form">
            <h3>Style for ${escapeHtml(prettyPath(plainPath))}</h3>
            <p class="pf-style-scope">${isGroup ? 'Applies to every field in this group, unless a field has its own style.' : 'Applies to this field, and to every repeat of it.'}
                Styles shape the wording and length, not the content.</p>
            ${inherited ? `<p class="pf-style-scope">Currently inherits from ${escapeHtml(prettyPath(inherited.path))}: <i>${escapeHtml(styleText(inherited.style))}</i></p>` : ''}
            <label>Length
                <select class="text_pole pf-style-length">
                    <option value="">No preference</option>
                    ${Object.entries(LENGTH_PRESETS).map(([key, p]) => `<option value="${key}">${escapeHtml(p.label)}</option>`).join('')}
                </select>
            </label>
            <label>Style note
                <textarea class="text_pole pf-style-note" rows="2" placeholder='e.g. Like a candle scent name: "smoky vanilla". Or: plain and clinical, no metaphors.'></textarea>
            </label>
            <label class="checkbox_label"><input type="checkbox" class="pf-style-apply" checked> Restyle the current ${isGroup ? 'values' : 'value'} now</label>
        </div>`);
    form.find('.pf-style-length').val(own.length || '');
    form.find('.pf-style-note').val(own.note || '');

    let captured = null;
    const CLEAR = c.POPUP_RESULT?.CUSTOM1 ?? 1001;
    const popup = new c.Popup(form, c.POPUP_TYPE.CONFIRM, '', {
        okButton: 'Save',
        cancelButton: 'Cancel',
        customButtons: styles[plainPath] ? [{ text: 'Clear style', result: CLEAR, classes: ['pf-style-clear'] }] : null,
        onClosing: () => {
            captured = {
                length: String(form.find('.pf-style-length').val() || ''),
                note: String(form.find('.pf-style-note').val() || '').trim(),
                apply: form.find('.pf-style-apply').prop('checked'),
            };
            return true;
        },
    });
    const result = await popup.show();

    if (result === CLEAR) {
        delete styles[plainPath];
        addLog('info', `Cleared the style for ${prettyPath(plainPath)}.`);
    } else if (result === (c.POPUP_RESULT?.AFFIRMATIVE ?? 1) && captured) {
        if (!captured.length && !captured.note) delete styles[plainPath];
        else styles[plainPath] = { length: captured.length, note: captured.note };
        addLog('info', `Set the style for ${prettyPath(plainPath)}${styleText(styles[plainPath]) ? `: ${styleText(styles[plainPath])}` : ' (cleared)'}.`);
    } else {
        return;
    }
    save();
    renderStyleList();
    if (ui) renderAll();
    if (result !== CLEAR && captured?.apply && styles[plainPath]) await runRestyle(plainPath);
}

/**
 * Rewrites styled field values to fit their style, keeping their content. Locked and empty fields
 * are left alone. `scope` limits it to one plain path (a field or group); without it, every styled field.
 */
async function runRestyle(scope = '') {
    if (isBusy()) return;
    const v = currentVersion();
    const { doc } = parseXml(v?.xml);
    if (!doc) return toastr.info('Nothing to restyle yet.');
    const locks = new Set(session().locks);
    const targets = collectLeaves(doc.documentElement)
        .map(leaf => ({ ...leaf, plain: plainOf(leaf.path), value: leaf.el.textContent.trim() }))
        .filter(t => t.value && !locks.has(t.path))
        .filter(t => !scope || t.plain === scope || t.plain.startsWith(`${scope}/`))
        .map(t => ({ ...t, style: styleText(styleFor(t.plain)?.style) }))
        .filter(t => t.style);
    if (!targets.length) return toastr.info(scope ? 'No unlocked, filled-in fields to restyle there.' : 'No fields have a style yet. Use the sliders button on a field or group to set one.');

    setBusy(true, `Restyling ${targets.length} field${targets.length === 1 ? '' : 's'}…`);
    try {
        const reply = await callModel(buildRestyleMessages(targets));
        const byPath = new Map(targets.map(t => [t.path, t]));
        let changed = 0;
        for (const [, path, value] of String(reply).matchAll(/<field path="([^"]+)"[^>]*>([\s\S]*?)<\/field>/g)) {
            const target = byPath.get(path);
            const clean = extractFieldValue(value, target?.el.tagName ?? 'field');
            if (!target || !clean || clean === target.value) continue;
            target.el.textContent = clean;
            changed++;
        }
        if (!changed) {
            addLog('ai', 'Restyle: everything already fits its style.');
        } else {
            const n = pushVersion(serialize(doc.documentElement), `Restyled ${changed} field${changed === 1 ? '' : 's'}`);
            addLog('ai', `Restyled ${changed} field${changed === 1 ? '' : 's'}${scope ? ` in ${prettyPath(scope)}` : ''}.`, n);
        }
    } catch (err) {
        reportError(err);
    } finally {
        setBusy(false);
        if (ui) renderAll();
    }
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
    ui.find('#pf-restyle').on('click', () => runRestyle());
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
        if (currentTab === 'design') setTab('fields'); // on phones the log and the fields are separate tabs
    });

    ui.find('.pf-tab').on('click', function() {
        setTab(String($(this).attr('data-tab')));
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
    fields.on('click', '.pf-style', function() {
        if (isBusy()) return;
        editStyle(String($(this).attr('data-plain')), $(this).closest('.pf-group-title').length > 0);
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
    ui.find('#pf-card').on('click', () => !isBusy() && openCardDialog());
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
    buildAvatarPane();
    renderAll();
    // On a phone, start where the work is: the fields if there's a persona, otherwise the concept.
    setTab(mobileQuery.matches && !currentXml() ? 'design' : 'fields');
    mobileQuery.addEventListener('change', onViewportChange);
    window.addEventListener('resize', onViewportChange);
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
        mobileQuery.removeEventListener('change', onViewportChange);
        window.removeEventListener('resize', onViewportChange);
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

            <div class="pf-settings-head">
                <label>Field styles</label>
                <div id="pf-reset-styles" class="menu_button fa-solid fa-rotate-left" title="Restore the default field styles"></div>
            </div>
            <div id="pf-style-list" class="pf-style-list"></div>
            <small>Set these with the sliders button on a field or group in the Forge.</small>

            <div class="pf-settings-head">
                <b>Avatar prompts</b>
                <div id="pf-reset-avatar" class="menu_button fa-solid fa-rotate-left" title="Restore the default avatar prompt settings"></div>
            </div>
            <label class="checkbox_label" for="pf-booru-underscores">
                <input id="pf-booru-underscores" type="checkbox">
                <span>Booru tags use underscores (long_hair, not long hair)</span>
            </label>
            <label for="pf-booru-quality">Booru quality tags (put first)</label>
            <input id="pf-booru-quality" class="text_pole" type="text">
            <label for="pf-booru-negative">Booru base negative</label>
            <textarea id="pf-booru-negative" class="text_pole pf-settings-area" rows="4"></textarea>
            <label for="pf-krea-negative">Krea 2 base negative</label>
            <textarea id="pf-krea-negative" class="text_pole pf-settings-area" rows="3"></textarea>
            <small>The AI adds negatives specific to the persona; these are merged in after. With NSFW off, nudity terms are added too.</small>
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
    bindArea('#pf-booru-quality', 'booruQuality');
    bindArea('#pf-booru-negative', 'booruNegative');
    bindArea('#pf-krea-negative', 'kreaNegative');
    $('#pf-booru-underscores').prop('checked', s.booruUnderscores).on('change', function() {
        s.booruUnderscores = $(this).prop('checked');
        save();
    });
    $('#pf-reset-avatar').on('click', () => {
        for (const key of ['booruUnderscores', 'booruQuality', 'booruNegative', 'kreaNegative']) s[key] = defaultSettings[key];
        $('#pf-booru-underscores').prop('checked', s.booruUnderscores);
        $('#pf-booru-quality').val(s.booruQuality);
        $('#pf-booru-negative').val(s.booruNegative);
        $('#pf-krea-negative').val(s.kreaNegative);
        save();
    });

    $('#pf-reset-template').on('click', () => { s.template = DEFAULT_TEMPLATE; $('#pf-template').val(s.template); save(); });
    $('#pf-reset-system').on('click', () => { s.systemPrompt = DEFAULT_SYSTEM_PROMPT; $('#pf-system').val(s.systemPrompt); save(); });
    $('#pf-open-settings').on('click', openForge);

    renderStyleList();
    $('#pf-style-list').on('click', '.pf-style-delete', function() {
        delete s.fieldStyles[String($(this).attr('data-plain'))];
        save();
        renderStyleList();
        if (ui) renderFields();
    });
    $('#pf-reset-styles').on('click', () => {
        s.fieldStyles = structuredClone(DEFAULT_FIELD_STYLES);
        save();
        renderStyleList();
        if (ui) renderFields();
    });
}

function renderStyleList() {
    const list = $('#pf-style-list').empty();
    const entries = Object.entries(settings().fieldStyles);
    if (!entries.length) return list.append('<div class="pf-style-empty">No field styles.</div>');
    for (const [path, style] of entries) {
        const row = $('<div class="pf-style-row"><b></b><span></span><i class="fa-solid fa-xmark pf-style-delete" title="Remove this style"></i></div>');
        row.find('b').text(prettyPath(path));
        row.find('span').text(styleText(style));
        row.find('i').attr('data-plain', path);
        list.append(row);
    }
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
