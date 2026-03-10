/**
 * Text Extractor Connector
 * 
 * Extracts specific text sections from input text using markers.
 * Designed to parse Gemini output that contains **IMAGE PROMPT:** and **VIDEO PROMPT:** sections.
 * 
 * Output fields:
 *   - imagePrompt: extracted text after IMAGE PROMPT marker
 *   - videoPrompt: extracted text after VIDEO PROMPT marker
 *   - fullText: the original full text
 */

import { BaseConnector } from '../base-connector.js';

export class TextExtractorConnector extends BaseConnector {
    static get metadata() {
        return {
            name: 'Text Extractor',
            description: 'Extract IMAGE PROMPT and VIDEO PROMPT sections from AI output',
            icon: '✂️',
            category: 'utility',
            configSchema: {
                marker1: {
                    type: 'text',
                    label: 'Marker 1 (Image Prompt)',
                    description: 'Section header to extract as imagePrompt',
                    default: 'IMAGE PROMPT',
                },
                marker2: {
                    type: 'text',
                    label: 'Marker 2 (Video Prompt)',
                    description: 'Section header to extract as videoPrompt',
                    default: 'VIDEO PROMPT',
                },
            },
        };
    }

    async execute(input, credentials, config) {
        const text = input.text || input.content || '';

        if (!text) {
            throw new Error('No text input received. Connect this node after a Gemini or Text node.');
        }

        const marker1 = config.marker1 || 'IMAGE PROMPT';
        const marker2 = config.marker2 || 'VIDEO PROMPT';

        console.log(`[TextExtractor] Extracting "${marker1}" and "${marker2}" from text (${text.length} chars)`);

        const imagePrompt = this._extractSection(text, marker1, marker2);
        const videoPrompt = this._extractSection(text, marker2, null);

        console.log(`[TextExtractor] imagePrompt: ${imagePrompt.length} chars`);
        console.log(`[TextExtractor] videoPrompt: ${videoPrompt.length} chars`);

        if (!imagePrompt && !videoPrompt) {
            console.log(`[TextExtractor] ⚠️ No markers found, returning full text as imagePrompt`);
            return {
                imagePrompt: text.trim(),
                videoPrompt: '',
                fullText: text,
                text: text,
            };
        }

        return {
            imagePrompt: imagePrompt.trim(),
            videoPrompt: videoPrompt.trim(),
            fullText: text,
            text: imagePrompt.trim(), // default "text" field = imagePrompt for backward compat
        };
    }

    /**
     * Extract text between startMarker and endMarker.
     * Handles many AI output formats:
     *   **IMAGE PROMPT:**        **1️⃣ IMAGE PROMPT**
     *   ## IMAGE PROMPT          **Image Prompt:**
     *   IMAGE PROMPT:            ---IMAGE PROMPT---
     */
    _extractSection(text, startMarker, endMarker) {
        if (!startMarker) return '';

        // Build flexible regex: allow any prefix chars (**, ##, emoji, numbers)
        // before the marker text, case-insensitive
        const escMarker = startMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Allow optional chars before marker: **, ##, emoji, numbering like "1️⃣", "1.", etc.
        const startPattern = new RegExp(
            `[*#\\-_\\s]*(?:[\\d️⃣]+[.\\)\\s]*)?[*#\\-_\\s]*${escMarker}[*#:\\-_\\s]*\\n?`,
            'i'
        );

        const startMatch = startPattern.exec(text);
        if (!startMatch) return '';

        const contentStart = startMatch.index + startMatch[0].length;

        let extracted;
        if (endMarker) {
            const escEnd = endMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const endPattern = new RegExp(
                `[*#\\-_\\s]*(?:[\\d️⃣]+[.\\)\\s]*)?[*#\\-_\\s]*${escEnd}[*#:\\-_\\s]*`,
                'i'
            );

            const remaining = text.substring(contentStart);
            const endMatch = endPattern.exec(remaining);

            if (endMatch) {
                extracted = remaining.substring(0, endMatch.index).trim();
            } else {
                extracted = text.substring(contentStart).trim();
            }
        } else {
            // No end marker — take everything after start
            extracted = text.substring(contentStart).trim();
        }

        // Clean up: remove leading/trailing markdown artifacts and quotes
        extracted = extracted
            .replace(/^```(?:json|text|plaintext)?\s*\n?/i, '')  // leading ```json or ```
            .replace(/\n?```\s*$/i, '')                          // trailing ```
            .replace(/^\s*\*\*\s*/, '')   // leading **
            .replace(/\s*\*\*\s*$/, '')   // trailing **
            .replace(/^\s*---+\s*/, '')   // leading ---
            .replace(/\s*---+\s*$/, '')   // trailing ---
            .replace(/^\s*json\s*\n/i, '') // leading standalone "json" word (from code blocks)
            .replace(/^\s*[""\u201C\u201D]+\s*/, '')  // leading quotes " " "
            .replace(/\s*[""\u201C\u201D]+\s*$/, '')  // trailing quotes " " "
            .trim();

        return extracted;
    }
}
