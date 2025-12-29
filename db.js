class CodeIDEDatabase {
    constructor(name = 'CodeIDE', version = 1) {
        this.name = name;
        this.version = version;
        this.db = null;
        this.stores = {
            settings: 'settings',
            code: 'code',
            history: 'history',
            snippets: 'snippets'
        };
    }

    async init() {
        if (this.db) return this;
        this.db = await new Promise((resolve, reject) => {
            const request = indexedDB.open(this.name, this.version);
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(this.stores.settings)) {
                    db.createObjectStore(this.stores.settings, { keyPath: 'key' });
                }
                if (!db.objectStoreNames.contains(this.stores.code)) {
                    const store = db.createObjectStore(this.stores.code, { keyPath: 'id' });
                    store.createIndex('by_lang', 'lang', { unique: false });
                    store.createIndex('by_lang_filename', ['lang', 'filename'], { unique: true });
                }
                if (!db.objectStoreNames.contains(this.stores.history)) {
                    const store = db.createObjectStore(this.stores.history, { keyPath: 'id', autoIncrement: true });
                    store.createIndex('by_lang', 'lang', { unique: false });
                    store.createIndex('by_lang_timestamp', ['lang', 'timestamp'], { unique: false });
                    store.createIndex('by_lang_filename', ['lang', 'filename'], { unique: false });
                    store.createIndex('by_lang_filename_timestamp', ['lang', 'filename', 'timestamp'], { unique: false });
                }
                if (!db.objectStoreNames.contains(this.stores.snippets)) {
                    const store = db.createObjectStore(this.stores.snippets, { keyPath: 'id', autoIncrement: true });
                    store.createIndex('by_lang', 'lang', { unique: false });
                    store.createIndex('by_lang_name', ['lang', 'name'], { unique: false });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        return this;
    }

    _requestToPromise(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    _txComplete(tx) {
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onabort = () => reject(tx.error);
            tx.onerror = () => reject(tx.error);
        });
    }

    async saveSetting(key, value) {
        const tx = this.db.transaction([this.stores.settings], 'readwrite');
        tx.objectStore(this.stores.settings).put({ key, value });
        await this._txComplete(tx);
        return true;
    }

    async loadSetting(key, fallback = null) {
        const tx = this.db.transaction([this.stores.settings], 'readonly');
        const request = tx.objectStore(this.stores.settings).get(key);
        const result = await this._requestToPromise(request);
        await this._txComplete(tx);
        return result && Object.prototype.hasOwnProperty.call(result, 'value') ? result.value : fallback;
    }

    async deleteSetting(key) {
        const tx = this.db.transaction([this.stores.settings], 'readwrite');
        tx.objectStore(this.stores.settings).delete(key);
        await this._txComplete(tx);
        return true;
    }

    async get(storeName, key) {
        const tx = this.db.transaction([storeName], 'readonly');
        const request = tx.objectStore(storeName).get(key);
        const result = await this._requestToPromise(request);
        await this._txComplete(tx);
        return result;
    }

    async getAll(storeName) {
        const tx = this.db.transaction([storeName], 'readonly');
        const request = tx.objectStore(storeName).getAll();
        const result = await this._requestToPromise(request);
        await this._txComplete(tx);
        return result || [];
    }

    async loadCodeRecord(lang, filename) {
        if (!lang || !filename) return null;
        const id = `${lang}:${filename}`;
        return this.get(this.stores.code, id);
    }

    async loadCode(lang, filename) {
        const record = await this.loadCodeRecord(lang, filename);
        return record ? record.code : '';
    }

    async saveCode(lang, code, options = {}) {
        if (!lang) return null;
        const filename = options.filename || 'main';
        const id = `${lang}:${filename}`;
        const existing = await this.loadCodeRecord(lang, filename);
        if (options.skipIfUnchanged !== false && existing && existing.code === code) {
            return existing;
        }
        const now = Date.now();
        const version = existing && existing.version ? existing.version + 1 : 1;
        const record = {
            id,
            lang,
            filename,
            code,
            updatedAt: now,
            version,
            author: options.author || '',
            description: options.description || ''
        };
        const tx = this.db.transaction([this.stores.code, this.stores.history], 'readwrite');
        tx.objectStore(this.stores.code).put(record);
        if (options.saveHistory !== false) {
            const message = options.message || options.description || (options.auto ? 'Auto-save' : 'Saved');
            const historyRecord = {
                lang,
                filename,
                version,
                code,
                message,
                timestamp: now,
                size: code ? code.length : 0,
                lines: code ? code.split('\n').length : 0
            };
            tx.objectStore(this.stores.history).add(historyRecord);
        }
        await this._txComplete(tx);
        return record;
    }

    async getHistory(lang, filename = '', limit = 50) {
        if (!lang) return [];
        const tx = this.db.transaction([this.stores.history], 'readonly');
        const store = tx.objectStore(this.stores.history);
        const items = [];
        let index;
        let range;
        if (filename) {
            index = store.index('by_lang_filename_timestamp');
            range = IDBKeyRange.bound([lang, filename, 0], [lang, filename, Number.MAX_SAFE_INTEGER]);
        } else {
            index = store.index('by_lang_timestamp');
            range = IDBKeyRange.bound([lang, 0], [lang, Number.MAX_SAFE_INTEGER]);
        }
        await new Promise((resolve, reject) => {
            const request = index.openCursor(range, 'prev');
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (!cursor || items.length >= limit) {
                    resolve();
                    return;
                }
                items.push(cursor.value);
                cursor.continue();
            };
            request.onerror = () => reject(request.error);
        });
        await this._txComplete(tx);
        return items;
    }

    async restoreFromHistory(historyId) {
        const historyRecord = await this.get(this.stores.history, historyId);
        if (!historyRecord) return null;
        const existing = await this.loadCodeRecord(historyRecord.lang, historyRecord.filename);
        const version = existing && existing.version ? existing.version + 1 : 1;
        const now = Date.now();
        const record = {
            id: `${historyRecord.lang}:${historyRecord.filename}`,
            lang: historyRecord.lang,
            filename: historyRecord.filename,
            code: historyRecord.code,
            updatedAt: now,
            version,
            author: 'restore',
            description: `Restore from version ${historyRecord.version}`
        };
        const tx = this.db.transaction([this.stores.code], 'readwrite');
        tx.objectStore(this.stores.code).put(record);
        await this._txComplete(tx);
        return historyRecord;
    }

    async saveSnippet(lang, name, code, tags = []) {
        const tx = this.db.transaction([this.stores.snippets], 'readwrite');
        const record = {
            lang,
            name,
            code,
            tags,
            createdAt: Date.now(),
            usageCount: 0
        };
        const request = tx.objectStore(this.stores.snippets).add(record);
        const id = await this._requestToPromise(request);
        await this._txComplete(tx);
        return id;
    }

    async getSnippetsByLanguage(lang) {
        const tx = this.db.transaction([this.stores.snippets], 'readonly');
        const store = tx.objectStore(this.stores.snippets);
        const index = store.index('by_lang');
        const items = [];
        await new Promise((resolve, reject) => {
            const request = index.openCursor(IDBKeyRange.only(lang));
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (!cursor) {
                    resolve();
                    return;
                }
                items.push(cursor.value);
                cursor.continue();
            };
            request.onerror = () => reject(request.error);
        });
        await this._txComplete(tx);
        return items;
    }

    async incrementSnippetUsage(snippetId) {
        const snippet = await this.get(this.stores.snippets, snippetId);
        if (!snippet) return null;
        snippet.usageCount = (snippet.usageCount || 0) + 1;
        const tx = this.db.transaction([this.stores.snippets], 'readwrite');
        tx.objectStore(this.stores.snippets).put(snippet);
        await this._txComplete(tx);
        return snippet;
    }

    async exportDatabase() {
        return {
            meta: {
                dbName: this.name,
                version: this.version,
                exportedAt: Date.now()
            },
            settings: await this.getAll(this.stores.settings),
            code: await this.getAll(this.stores.code),
            history: await this.getAll(this.stores.history),
            snippets: await this.getAll(this.stores.snippets)
        };
    }

    async importDatabase(data) {
        if (!data) throw new Error('No data provided');
        const settings = Array.isArray(data.settings) ? data.settings : [];
        const code = Array.isArray(data.code) ? data.code : [];
        const history = Array.isArray(data.history) ? data.history : [];
        const snippets = Array.isArray(data.snippets) ? data.snippets : [];
        const tx = this.db.transaction([this.stores.settings, this.stores.code, this.stores.history, this.stores.snippets], 'readwrite');
        const settingsStore = tx.objectStore(this.stores.settings);
        const codeStore = tx.objectStore(this.stores.code);
        const historyStore = tx.objectStore(this.stores.history);
        const snippetsStore = tx.objectStore(this.stores.snippets);
        settingsStore.clear();
        codeStore.clear();
        historyStore.clear();
        snippetsStore.clear();
        settings.forEach(item => settingsStore.put(item));
        code.forEach(item => codeStore.put(item));
        history.forEach(item => historyStore.put(item));
        snippets.forEach(item => snippetsStore.put(item));
        await this._txComplete(tx);
        return true;
    }

    async clear(storeName) {
        const tx = this.db.transaction([storeName], 'readwrite');
        tx.objectStore(storeName).clear();
        await this._txComplete(tx);
        return true;
    }

    async getStats() {
        const [settings, code, history, snippets] = await Promise.all([
            this.getAll(this.stores.settings),
            this.getAll(this.stores.code),
            this.getAll(this.stores.history),
            this.getAll(this.stores.snippets)
        ]);
        const calcSize = (items, field) => items.reduce((sum, item) => {
            const value = field ? item[field] : JSON.stringify(item);
            return sum + (value ? String(value).length : 0);
        }, 0);
        const size = calcSize(code, 'code') + calcSize(history, 'code') + calcSize(snippets, 'code') + calcSize(settings);
        return {
            totalSize: size,
            settings: { count: settings.length },
            code: { count: code.length },
            history: { count: history.length },
            snippets: { count: snippets.length }
        };
    }
}

window.CodeIDEDatabase = CodeIDEDatabase;
