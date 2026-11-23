// ==UserScript==
// @name        Needs Infobox Remover
// @description Removes needs-infobox tags from a page's Talk page and saves the edit as a minor edit without changing the watchlist setting
// ==/UserScript==
(() => {
// Single place to change the script version (used in the edit summary).
const SCRIPT_VERSION = 'v0.0.1';

// Which menu the link is added to.
//   'p-cactions' = the "More" menu (as in RecordingCover.js)
//   'p-tb'       = the "Tools" menu
const PORTLET_ID = 'p-cactions';

mw.loader.using(['mediawiki.util', 'mediawiki.api', 'mediawiki.Title']).then(() => {
    $(document).ready(() => {
        const link = mw.util.addPortletLink(PORTLET_ID, '#', 'Needs Infobox Remover');
        if (!link) return;
        $(link).on('click', e => {
            e.preventDefault();
            runNeedsInfoboxRemover();
        });
    });
});

// ============================================================
// HELPERS
// ============================================================

// Given the index of an opening "{{", return the index just past its matching "}}"
// (nested templates included), or -1 if the template is never closed.
function findTemplateEnd(text, start) {
    let depth = 0;
    let i = start;
    while (i < text.length) {
        if (text.startsWith('{{', i)) {
            depth++;
            i += 2;
        } else if (text.startsWith('}}', i)) {
            depth--;
            i += 2;
            if (depth === 0) return i;
        } else {
            i++;
        }
    }
    return -1;
}

// Remove text.slice(start, end). If what's left of that line would be blank,
// remove the whole line (including its line break) instead.
// Returns the new text and the index where the text following the cut now begins.
function cutMatch(text, start, end) {
    const lineStart = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1;
    let lineEnd = text.indexOf('\n', end);
    const hasNewline = lineEnd !== -1;
    if (!hasNewline) lineEnd = text.length;

    const aloneOnLine = text.slice(lineStart, start).trim() === '' &&
                        text.slice(end, lineEnd).trim() === '';
    if (aloneOnLine) {
        return {
            text: text.slice(0, lineStart) + text.slice(hasNewline ? lineEnd + 1 : lineEnd),
            pos: lineStart
        };
    }
    return { text: text.slice(0, start) + text.slice(end), pos: start };
}

// Finds and removes every needs-infobox tag in the given wikitext:
//   |needs-infobox=yes   |needs-infobox=y
//   {{Infobox requested}}  {{Infobox requested|...}}
//   {{Reqinfobox}}         {{Reqinfobox|...}}
// Matching is case-insensitive, tolerates spaces/underscores and whitespace
// around "|" and "=", and treats template parameters (including nested
// templates) as part of the match. Returns { text, removed }, where removed
// lists the exact text removed by each match.
function removeNeedsInfoboxTags(text) {
    const removed = [];
    let searchFrom;

    // 1) Templates: {{Infobox requested...}} and {{Reqinfobox...}}
    const templateStart = /\{\{[ \t\r\n]*(?:Infobox[ _]+requested|Reqinfobox)[ \t\r\n]*(?=\||\}\})/gi;
    searchFrom = 0;
    while (true) {
        templateStart.lastIndex = searchFrom;
        const m = templateStart.exec(text);
        if (!m) break;
        const end = findTemplateEnd(text, m.index);
        if (end === -1) {            // Unclosed template: leave it alone
            searchFrom = m.index + m[0].length;
            continue;
        }
        removed.push(text.slice(m.index, end));
        const cut = cutMatch(text, m.index, end);
        text = cut.text;
        searchFrom = cut.pos;
    }

    // 2) Banner parameters: |needs-infobox=yes and |needs-infobox=y (whole values only)
    const flagPattern = /\|[ \t]*needs-infobox[ \t]*=[ \t]*(?:yes|y)(?!\w)/gi;
    searchFrom = 0;
    while (true) {
        flagPattern.lastIndex = searchFrom;
        const m = flagPattern.exec(text);
        if (!m) break;
        removed.push(m[0]);
        const cut = cutMatch(text, m.index, m.index + m[0].length);
        text = cut.text;
        searchFrom = cut.pos;
    }

    return { text: text, removed: removed };
}

// Tells the user what was removed.
function notifyRemoved(removed, talkPageTitle) {
    console.log('Removed needs-infobox matches:', removed);
    const $msg = $('<div>');
    $('<p>').text('Removed ' + removed.length + ' needs-infobox match' +
        (removed.length === 1 ? '' : 'es') + ' from ' + talkPageTitle + ':').appendTo($msg);
    const $list = $('<ul>').appendTo($msg);
    removed.forEach(str => {
        $('<li>').append($('<code>').css('white-space', 'pre-wrap').text(str)).appendTo($list);
    });
    mw.notify($msg, { type: 'success', autoHideSeconds: 'long' });
}

// Works out which Talk page to edit: the current page if it is already a Talk page,
// otherwise the Talk page that corresponds to the current page.
function getTalkPageTitle() {
    const title = mw.Title.newFromText(mw.config.get('wgPageName'));
    if (!title) return null;
    const ns = title.getNamespaceId();
    if (ns >= 0 && ns % 2 === 1) return title.getPrefixedText();
    const talk = title.getTalkPage();
    return talk ? talk.getPrefixedText() : null;
}

// ============================================================
// MAIN
// ============================================================
async function runNeedsInfoboxRemover() {
    const talkPageTitle = getTalkPageTitle();
    if (!talkPageTitle) {
        mw.notify('This page has no Talk page.', { type: 'error' });
        return;
    }

    const api = new mw.Api();

    try {
        // Step 1: Fetch the Talk page content
        const result = await api.get({
            action: 'query',
            prop: 'revisions',
            rvprop: ['content', 'ids'],
            rvslots: 'main',
            titles: talkPageTitle,
            formatversion: 2
        });

        const page = result.query && result.query.pages && result.query.pages[0];
        if (!page || page.invalid) {
            mw.notify('Unable to look up the Talk page.', { type: 'error' });
            return;
        }
        if (page.missing) {
            mw.notify(talkPageTitle + ' does not exist; nothing to remove.', { type: 'info' });
            return;
        }
        const revision = page.revisions && page.revisions[0];
        const pageText = revision && (revision.slots && revision.slots.main
            ? revision.slots.main.content : revision.content);
        if (typeof pageText !== 'string') {
            mw.notify('Talk page content not found.', { type: 'error' });
            return;
        }
        if (/^\s*#REDIRECT\b/i.test(pageText)) {
            mw.notify(talkPageTitle + ' is a redirect; nothing was changed.', { type: 'info' });
            return;
        }

        // Step 2: Remove the tags
        const { text: updatedText, removed } = removeNeedsInfoboxTags(pageText);

        if (!removed.length || updatedText === pageText) {
            mw.notify('No needs-infobox tags found on ' + talkPageTitle + '.', { type: 'info' });
            return;
        }

        // Step 3: Save as a minor edit, leaving the watchlist setting unchanged
        try {
            await api.postWithEditToken({
                action: 'edit',
                title: talkPageTitle,
                text: updatedText,
                summary: 'Removed needs-infobox tag(s) using Needs Infobox Remover script ' + SCRIPT_VERSION + '.',
                minor: true,
                watchlist: 'nochange',
                nocreate: true,
                baserevid: revision.revid,
                formatversion: 2
            });
        } catch (e) {
            console.error(e);
            mw.notify('Error editing ' + talkPageTitle + '. Nothing was changed.', { type: 'error' });
            return;
        }

        // Step 4: Report the results, then reload
        notifyRemoved(removed, talkPageTitle);
        setTimeout(() => { location.reload(); }, 10000);
    } catch (error) {
        console.error('Error:', error);
        mw.notify('Error removing needs-infobox tags from the Talk page.', { type: 'error' });
    }
}

})();
