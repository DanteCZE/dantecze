const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DIRECTORY = __dirname;
const INDEX_PATH = path.join(DIRECTORY, 'index.html');
const EDITOR_PATH = path.join(DIRECTORY, 'editor.html');
const DATA_BLOCK = /(?<start><!-- EDITOR_DATA_START -->\s*<script type="application\/json" id="directory-data">)(?<data>[\s\S]*?)(?<end><\/script>\s*<!-- EDITOR_DATA_END -->)/;
const FIELDS = new Set([
    'nazev',
    'popis',
    'odkaz',
    'ikona',
    'barvaPozadiIkony',
    'barvaIkony',
    'kategorie'
]);
const LEGACY_COLORS = new Set(['bg-gray-200', 'text-gray-700']);
const MAX_ENTRIES = 200;
const MAX_BODY_BYTES = 1_000_000;

class RequestError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function validateApps(apps) {
    if (!Array.isArray(apps)) throw new RequestError(400, 'Očekával se seznam položek.');
    if (apps.length > MAX_ENTRIES) {
        throw new RequestError(400, `Rozcestník může obsahovat nejvýše ${MAX_ENTRIES} položek.`);
    }

    const limits = {
        nazev: 120,
        popis: 2000,
        odkaz: 2048,
        ikona: 80,
        barvaPozadiIkony: 32,
        barvaIkony: 32,
        kategorie: 120
    };

    return apps.map((app, index) => {
        if (!app || typeof app !== 'object' || Array.isArray(app)
            || Object.keys(app).length !== FIELDS.size
            || Object.keys(app).some(field => !FIELDS.has(field))) {
            throw new RequestError(400, `Položka ${index + 1} nemá očekávaná pole.`);
        }

        const item = {};
        for (const field of FIELDS) {
            const value = app[field];
            if (typeof value !== 'string') {
                throw new RequestError(400, `Položka ${index + 1}: pole ${field} musí být text.`);
            }
            item[field] = value.trim();
            if (!item[field]) {
                throw new RequestError(400, `Položka ${index + 1}: pole ${field} nesmí být prázdné.`);
            }
            if (item[field].length > limits[field]) {
                throw new RequestError(400, `Položka ${index + 1}: pole ${field} je příliš dlouhé.`);
            }
        }

        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.ikona)) {
            throw new RequestError(400, `Položka ${index + 1}: neplatný název ikony Lucide.`);
        }

        for (const [field, prefix] of [['barvaPozadiIkony', 'bg'], ['barvaIkony', 'text']]) {
            const value = item[field];
            const colorMatches = new RegExp(`^${prefix}-\\[#([0-9a-fA-F]{6})\\]$`).test(value);
            if (!colorMatches && !(LEGACY_COLORS.has(value) && value.startsWith(prefix + '-'))) {
                throw new RequestError(400, `Položka ${index + 1}: neplatná barva ${field}.`);
            }
        }

        const link = item.odkaz;
        if (/\s/.test(link) || link.startsWith('//')) {
            throw new RequestError(400, `Položka ${index + 1}: neplatný odkaz.`);
        }
        let parsedLink;
        try {
            parsedLink = new URL(link, 'http://editor.local');
        } catch {
            throw new RequestError(400, `Položka ${index + 1}: neplatný odkaz.`);
        }
        if (!['http:', 'https:'].includes(parsedLink.protocol)) {
            throw new RequestError(400, `Položka ${index + 1}: povoleny jsou pouze odkazy HTTP(S).`);
        }
        if (/^[a-z][a-z0-9+.-]*:/i.test(link) && !/^https?:\/\//i.test(link)) {
            throw new RequestError(400, `Položka ${index + 1}: povoleny jsou pouze odkazy HTTP(S).`);
        }

        return item;
    });
}

function extractDataBlock(contents) {
    const match = DATA_BLOCK.exec(contents);
    if (!match) throw new Error('V index.html nebyl nalezen datový blok editoru.');
    return match;
}

function readApps() {
    const contents = fs.readFileSync(INDEX_PATH, 'utf8');
    const match = extractDataBlock(contents);
    let apps;
    try {
        apps = JSON.parse(match.groups.data);
    } catch (error) {
        throw new Error(`Data aplikací v index.html nejsou platný JSON: ${error.message}`);
    }
    try {
        return validateApps(apps);
    } catch (error) {
        throw new Error(`Data aplikací v index.html nejsou platná: ${error.message}`);
    }
}

function replaceApps(apps) {
    const contents = fs.readFileSync(INDEX_PATH, 'utf8');
    const match = extractDataBlock(contents);
    const serialized = JSON.stringify(apps, null, 4).replace(/[&<>\u2028\u2029]/g, character => ({
        '&': '\\u0026',
        '<': '\\u003c',
        '>': '\\u003e',
        '\u2028': '\\u2028',
        '\u2029': '\\u2029'
    })[character]);
    const replacement = match.groups.start + '\n' + serialized + '\n    ' + match.groups.end;
    const updated = contents.slice(0, match.index)
        + replacement
        + contents.slice(match.index + match[0].length);
    const temporaryPath = path.join(DIRECTORY, `.index.html-${crypto.randomUUID()}.tmp`);

    try {
        fs.writeFileSync(temporaryPath, updated, {
            flag: 'wx',
            mode: fs.statSync(INDEX_PATH).mode
        });
        fs.renameSync(temporaryPath, INDEX_PATH);
    } finally {
        if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
}

function sendJson(response, status, payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    });
    response.end(body);
}

async function readJsonBody(request) {
    const declaredLength = Number(request.headers['content-length']);
    if (!Number.isInteger(declaredLength) || declaredLength < 0) {
        throw new RequestError(411, 'Chybí platná délka požadavku.');
    }
    if (declaredLength > MAX_BODY_BYTES) {
        throw new RequestError(413, 'Požadavek je příliš velký.');
    }

    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) throw new RequestError(413, 'Požadavek je příliš velký.');
        chunks.push(chunk);
    }

    let payload;
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        payload = JSON.parse(text);
    } catch {
        throw new RequestError(400, 'Požadavek neobsahuje platný JSON.');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || Object.keys(payload).length !== 1 || !Object.hasOwn(payload, 'apps')) {
        throw new RequestError(400, 'Požadavek musí obsahovat pouze seznam apps.');
    }
    return payload.apps;
}

async function handleRequest(request, response) {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (request.method === 'GET' && pathname === '/api/apps') {
        try {
            sendJson(response, 200, { apps: readApps() });
        } catch (error) {
            sendJson(response, 500, { error: error.message });
        }
        return;
    }

    if (request.method === 'GET' && (pathname === '/' || pathname === '/editor.html')) {
        try {
            const body = fs.readFileSync(EDITOR_PATH);
            response.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Content-Length': body.length,
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff'
            });
            response.end(body);
        } catch (error) {
            sendJson(response, 500, { error: `Editor nelze načíst: ${error.message}` });
        }
        return;
    }

    if (request.method === 'PUT' && pathname === '/api/apps') {
        const expectedOrigin = `http://127.0.0.1:${server.address().port}`;
        if (request.headers.origin !== expectedOrigin) {
            sendJson(response, 403, { error: 'Požadavek nebyl odeslán z tohoto editoru.' });
            return;
        }
        if ((request.headers['content-type'] || '').split(';')[0].trim() !== 'application/json') {
            sendJson(response, 415, { error: 'Očekává se požadavek typu application/json.' });
            return;
        }

        try {
            const apps = validateApps(await readJsonBody(request));
            replaceApps(apps);
            sendJson(response, 200, { saved: apps.length });
        } catch (error) {
            if (error instanceof RequestError) {
                sendJson(response, error.status, { error: error.message });
            } else {
                console.error('Uložení do index.html se nezdařilo:', error);
                sendJson(response, 500, { error: `Uložení do index.html se nezdařilo: ${error.message}` });
            }
        }
        return;
    }

    sendJson(response, 404, { error: 'Požadavek nebyl nalezen.' });
}

const server = http.createServer((request, response) => {
    handleRequest(request, response).catch(error => {
        console.error('Zpracování požadavku se nezdařilo:', error);
        if (!response.headersSent) {
            sendJson(response, 500, { error: 'Interní chyba editoru.' });
        } else {
            response.destroy();
        }
    });
});

function openEditor(url) {
    const command = process.platform === 'win32' ? 'cmd.exe' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    const browser = spawn(command, args, { detached: true, stdio: 'ignore' });
    browser.on('error', error => {
        console.error(`Editor se nepodařilo otevřít automaticky: ${error.message}`);
        console.log(`Otevřete tuto adresu ručně: ${url}`);
    });
    browser.unref();
}

function main() {
    if (!fs.existsSync(INDEX_PATH)) throw new Error(`V adresáři ${DIRECTORY} nebyl nalezen index.html.`);
    if (!fs.existsSync(EDITOR_PATH)) throw new Error(`V adresáři ${DIRECTORY} nebyl nalezen editor.html.`);

    server.listen(0, '127.0.0.1', () => {
        const url = `http://127.0.0.1:${server.address().port}/`;
        console.log(`Editor běží na ${url}`);
        console.log('Ukončíte jej stisknutím Ctrl+C.');
        if (process.env.EDITOR_NO_OPEN !== '1') openEditor(url);
    });
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
