# Persona Forge

A SillyTavern extension for designing personas with the AI. You describe a concept, the model fills
an XML template, and then you keep shaping it until it's right. When you're done, you save it as a
persona.

> **Mobile compatibility is still pending.** Persona Forge is built and tested for desktop browsers. On a
> phone the window may be cramped or awkward to use.

## Install

Copy this folder into your SillyTavern user extensions directory and reload ST:

```
SillyTavern/data/default-user/extensions/persona-forge/
```

(`public/scripts/extensions/third-party/persona-forge/` also works for an all-users install.)

## Open it

- Wand menu → **Persona Forge**
- Persona Management → the hammer button next to "Create a dummy persona"
- `/persona-forge`

## Designing a persona

| Tool | What it does |
| --- | --- |
| **Generate** | Builds a new version from the concept. If the concept is blank, the model invents one. |
| **Refine** | Describe a change in plain words (Ctrl+Enter). The model revises the whole document so everything stays consistent, and leaves the rest as it was. |
| **Lock** (padlock) | Keeps a field fixed. The model is told to use the value as-is, and the value is put back after every Generate or Refine. Lock what you like, then regenerate the rest. |
| **Reroll** (dice) | On a field: rewrites that field. On a group title: rewrites the whole group in one go (locked fields inside are kept). Shift+click to give direction ("more unusual", "something floral"). |
| **Edit** | Type into any field, or edit the raw XML in the XML tab. |
| **Add** (+) | In a freeform section or any group inside one: add your own field ("Favorite drink"), or fill in sub-fields to make a nested group ("Tattoos" with "Left arm, Back"). Leave the values blank and the AI writes them. In a group of repeated items like Scent, the name defaults to another of that item. |
| **Remove** (×) | Removes a field or group in a freeform section. A group left empty goes too. Removals stick: the model isn't asked for that field again, even if the template has it. |
| **Style** (sliders) | Shapes how a field is written without changing what it says: a length (terse, short phrase, one or two sentences, detailed) plus an optional note, e.g. *"Like a candle scent name: 'smoky vanilla'"*. Set it on a field (covers every repeat of it, like all Scent Hints) or on a group (covers everything inside). Styles are followed by every Generate, Refine and Reroll. |
| **Restyle** | Rewrites the fields that have a style so they fit it, keeping their content. Locked fields are left alone. Setting a style offers to restyle its current values straight away. |
| **Versions** | Every AI change is a new version. Step through them with ◀ ▶, or click `→ vN` in the design log. |
| **Load** | Pulls an existing persona's description in as a starting point. |
| **Save to selected** / **Save as new persona** | Writes the current version into a persona description. |

The session (concept, versions, locks, log) is saved, so closing the window doesn't lose work.

## Avatar prompts

The **Avatar** tab turns the persona's looks into image-generation prompts, for **Krea 2** (a natural-language
paragraph) and **booru-tag** models such as Anima, each with a positive and a negative prompt.

- Pick the shot from dropdowns: framing, camera angle, pose, expression, outfit, setting, lighting and (for Krea)
  photo style. Anything left on *AI's choice* is picked to suit the character. Add free-text extra details if you like.
- **NSFW** allows nudity and unlocks the NSFW choices. With it off, the prompt is kept clothed and nudity terms are
  added to both negatives.
- The AI writes the persona-specific parts, including negatives for things that would be wrong for this
  character, like "long hair" for a crew cut. Your fixed quality tags and base negatives from the settings are merged
  in, and duplicates are dropped.
- Krea 2 Turbo runs at CFG 1, where ComfyUI ignores negative prompts, so the Krea negative only matters if you raise CFG.
- Prompts are written for the version you're viewing, and you can edit them in place before copying.

## Settings (Extensions panel → Persona Forge)

- **Connection profile**: design with a different model than the one you chat with (uses Connection Manager profiles).
- **Max response tokens**: raise this if the XML comes back cut off.
- **Template**: any XML structure. Leaf tags become fields, and repeated tags (`<scent_hint>` ×3) ask for several values.
  Mark a section `freeform="true"` (the default template does this for `<misc_attributes>`) to make it open-ended:
  you can add and remove fields and nested groups there, and the model may add one when a refinement asks for a
  new detail. Once a persona exists, its freeform sections take their shape from the persona rather than the template.
- **Instructions**: the system prompt.
- **Example persona**: paste a finished persona to show the model the depth and tone you want.
- **Avatar prompts**: booru tags with underscores or spaces, the booru quality tags that lead every prompt, and the base negatives for booru and Krea 2.
- **Field styles**: every style you've set, with the option to remove them. The default styles Scent Hints as terse candle-scent names.
