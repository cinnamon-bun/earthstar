import Logger from '../util/log';
import {
    Document,
    IValidator,
    ValidationError,
    WorkspaceAddress,
} from '../util/types';
import {
    Query,
    QueryForForget,
    cleanUpQuery,
    documentIsExpired,
    queryMatchesDoc,
    sortLatestFirst,
    sortPathAscAuthorAsc,
} from './query';
import {
    StorageBase,
} from './storageBase';

//================================================================================

let logger = new Logger('StorageMemory');

export class StorageMemory extends StorageBase {
    _docs: Record<string, Record<string, Document>> = {};  // { path: { author: document }}
    _config: Record<string, string> = {};

    constructor(validators: [IValidator, ...IValidator[]], workspace: WorkspaceAddress) {
        super(validators, workspace);
        logger.log('constructor for workspace ' + workspace);        
    }

    setConfig(key: string, content: string): void {
        this._config[key] = content;
    }
    getConfig(key: string): string | undefined {
        return this._config[key];
    }
    deleteConfig(key: string): void {
        delete this._config[key];
    }
    deleteAllConfig(): void {
        this._config = {};
    }

    documents(q?: Query): Document[] {
        this._assertNotClosed();
        let query = cleanUpQuery(q || {});

        if (query.limit === 0 || query.limitBytes === 0) { return []; }

        let now = this._now || (Date.now() * 1000);
        let results: Document[] = [];

        // which paths should we consider?
        let pathsToConsider: string[];
        if (query.path !== undefined) {
            // optimize when a specific path is requested
            pathsToConsider = [query.path];
            if (this._docs[query.path] === undefined) { return []; }
        } else {
            pathsToConsider = Object.keys(this._docs);
        }

        // Sort the pathsToConsider
        // to prepare for the optimizations in the loop below
        // which assume it's sorted.
        if (query.pathStartsWith !== undefined || query.limit !== undefined) {
            pathsToConsider.sort();
        }

        for (let path of pathsToConsider) {

            // Optimization when pathStartsWith is set:
            // skip ahead until we reach paths starting with pathStartsWith,
            // work through those,
            // then break when we pass the end of those.
            // This assumes that pathsToConsider is sorted already.
            if (query.pathStartsWith !== undefined) {
                if (!path.startsWith(query.pathStartsWith)) {
                    if (path < query.pathStartsWith) {
                        // skip ahead until we reach paths starting with pathStartsWith
                        continue; 
                    } else {
                        // now we've gone past the pathStartsWith, so we can stop
                        break;
                    }
                }
            }

            // within one path...
            let pathSlots = this._docs[path];
            let docsThisPath = Object.values(pathSlots);

            if (query.history === 'latest') {
                // only keep latest, and use signature as tiebreaker
                docsThisPath.sort(sortLatestFirst);
                docsThisPath = [docsThisPath[0]];
            } else if (query.history === 'all') {
                // keep all docs at this path
            } else {
                /* istanbul ignore next */
                throw new ValidationError('unexpected query.history value: ' + JSON.stringify(query.history));
            }

            // apply the rest of the individual query selectors: path, timestamp, author, contentLength
            // and continueAfter
            // and skip expired ephemeral docs
            docsThisPath = docsThisPath
                .filter(doc => queryMatchesDoc(query, doc) && (doc.deleteAfter === null || now <= doc.deleteAfter));

            docsThisPath
                .forEach(doc => results.push(doc));

            // optimization: stop when limit is reached
            // this assumes that pathsToConsider is sorted already
            if (query.limit !== undefined && results.length >= query.limit) {
                break;
            }
        }

        // sort overall results by path, then author within a path
        results.sort(sortPathAscAuthorAsc);

        // apply limit and limitBytes
        if (query.limit !== undefined) {
            results = results.slice(0, query.limit);
        }

        if (query.limitBytes !== undefined) {
            let bytes = 0;
            for (let ii = 0; ii < results.length; ii++) {
                let doc = results[ii];
                // count content length in bytes in utf-8 encoding, not number of characters
                // TODO: test this works in browsers
                // https://stackoverflow.com/questions/5515869/string-length-in-bytes-in-javascript
                let len = Buffer.byteLength(doc.content, 'utf-8');
                bytes += len;
                // if we hit limitBytes but the next item's content is '',
                // return early (don't include the empty item)
                if (bytes > query.limitBytes || (bytes === query.limitBytes && len === 0)) {
                    results = results.slice(0, ii);
                    break;
                }
            }
        }

        return results;
    }

    _upsertDocument(doc: Document): void {
        this._assertNotClosed();
        Object.freeze(doc);
        let slots: Record<string, Document> = this._docs[doc.path] || {};
        slots[doc.author] = doc;
        this._docs[doc.path] = slots;
    }

    _filterDocs(shouldKeep: (doc: Document) => boolean): void {
        this._assertNotClosed();
        let now = this._now || (Date.now() * 1000);
        // using "for... in" on purpose since we're deleting while iterating
        for (let path in this._docs) {
            let slots = this._docs[path];
            // delete expired docs from slots
            for (let author in slots) {
                let doc = slots[author];
                if (!shouldKeep(doc)) {
                    delete slots[author];
                }
            }
            // if slots are empty, remove the entire set of slots
            if (Object.keys(slots).length === 0) {
                delete this._docs[path];
            }
        }
    }

    forgetDocuments(q: QueryForForget): void {
        this._assertNotClosed();
        let query = cleanUpQuery(q);
        if (query.limit === 0 || query.limitBytes === 0) { return; }
        if (query.history !== 'all') {
            throw new ValidationError('forgetDocuments can only be called with history: "all"');
        }
        this._filterDocs((doc) => !queryMatchesDoc(query, doc));
    }

    discardExpiredDocuments(): void {
        this._assertNotClosed();
        let now = this._now || (Date.now() * 1000);
        this._filterDocs((doc) => !documentIsExpired(doc, now));
    }

    _close(opts: { delete: boolean }): void { 
        // we don't really need to do this, but maybe it will help garbage collection
        logger.log(`🛑 _close() - ${this.workspace} - (is mostly a no-nop for StorageMemory)`)
        this._docs = {};
        this._config = {};
    }
}
