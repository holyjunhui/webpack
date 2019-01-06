/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

"use strict";

const AsyncQueue = require("./util/AsyncQueue");

let FS_ACCURACY = 2000;

/**
 * @typedef {Object} FileSystemInfoEntry
 * @property {number} safeTime
 * @property {number} timestamp
 */

/* istanbul ignore next */
const applyMtime = mtime => {
	if (FS_ACCURACY > 1 && mtime % 2 !== 0) FS_ACCURACY = 1;
	else if (FS_ACCURACY > 10 && mtime % 20 !== 0) FS_ACCURACY = 10;
	else if (FS_ACCURACY > 100 && mtime % 200 !== 0) FS_ACCURACY = 100;
	else if (FS_ACCURACY > 1000 && mtime % 2000 !== 0) FS_ACCURACY = 1000;
};

class FileSystemInfo {
	constructor(fs) {
		this.fs = fs;
		/** @type {Map<string, FileSystemInfoEntry | null>} */
		this._fileTimestamps = new Map();
		/** @type {Map<string, FileSystemInfoEntry | null>} */
		this._contextTimestamps = new Map();
		this.fileTimestampQueue = new AsyncQueue({
			name: "file timestamp",
			parallelism: 30,
			processor: this._readFileTimestamp.bind(this)
		});
		this.contextTimestampQueue = new AsyncQueue({
			name: "context timestamp",
			parallelism: 2,
			processor: this._readContextTimestamp.bind(this)
		});
	}

	/**
	 * @param {Map<string, FileSystemInfoEntry | null>} map timestamps
	 * @returns {void}
	 */
	addFileTimestamps(map) {
		for (const [path, ts] of map) {
			this._fileTimestamps.set(path, ts);
		}
	}

	/**
	 * @param {Map<string, FileSystemInfoEntry | null>} map timestamps
	 * @returns {void}
	 */
	addContextTimestamps(map) {
		for (const [path, ts] of map) {
			this._contextTimestamps.set(path, ts);
		}
	}

	/**
	 * @param {string} path file path
	 * @param {function(Error=, FileSystemInfoEntry=): void} callback callback function
	 * @returns {void}
	 */
	getFileTimestamp(path, callback) {
		const cache = this._fileTimestamps.get(path);
		if (cache !== undefined) return callback(null, cache);
		this.fileTimestampQueue.add(path, callback);
	}

	/**
	 * @param {string} path context path
	 * @param {function(Error=, FileSystemInfoEntry=): void} callback callback function
	 * @returns {void}
	 */
	getContextTimestamp(path, callback) {
		const cache = this._contextTimestamps.get(path);
		if (cache !== undefined) return callback(null, cache);
		this.contextTimestampQueue.add(path, callback);
	}

	createSnapshot(startTime, files, directories, missing, options, callback) {
		const fileTimestamps = new Map();
		const contextTimestamps = new Map();
		const missingTimestamps = new Map();
		let jobs = 1;
		const jobDone = () => {
			if (--jobs === 0) {
				callback(null, {
					startTime,
					fileTimestamps,
					contextTimestamps,
					missingTimestamps
				});
			}
		};
		for (const path of files) {
			const cache = this._fileTimestamps.get(path);
			if (cache !== undefined) {
				fileTimestamps.set(path, cache);
			} else {
				jobs++;
				this.fileTimestampQueue.add(path, (err, entry) => {
					if (err) {
						fileTimestamps.set(path, "error");
					} else {
						fileTimestamps.set(path, entry);
					}
					jobDone();
				});
			}
		}
		for (const path of directories) {
			contextTimestamps.set(path, "error");
			// TODO: getContextTimestamp is not implemented yet
		}
		for (const path of missing) {
			const cache = this._fileTimestamps.get(path);
			if (cache !== undefined) {
				fileTimestamps.set(path, cache);
			} else {
				jobs++;
				this.fileTimestampQueue.add(path, (err, entry) => {
					if (err) {
						fileTimestamps.set(path, "error");
					} else {
						fileTimestamps.set(path, entry);
					}
					jobDone();
				});
			}
		}
		jobDone();
	}

	checkSnapshotValid(snapshot, callback) {
		const {
			startTime,
			fileTimestamps,
			contextTimestamps,
			missingTimestamps
		} = snapshot;
		let jobs = 1;
		const jobDone = () => {
			if (--jobs === 0) {
				callback(null, true);
			}
		};
		const invalid = () => {
			if (jobs > 0) {
				jobs = NaN;
				callback(null, false);
			}
		};
		const checkFile = (current, snap) => {
			if (snap === "error") {
				return current && current.safeTime <= startTime;
			}
			if (!current !== !snap) return false;
			if (current && current.timestamp) {
				return current.timestamp === snap.timestamp;
			}
			return !current;
		};
		for (const [path, ts] of fileTimestamps) {
			const cache = this._fileTimestamps.get(path);
			if (cache !== undefined) {
				if (!checkFile(cache, ts)) {
					invalid();
				}
			} else {
				jobs++;
				console.log("MISSING FOR VALIDATION", path);
				this.fileTimestampQueue.add(path, (err, entry) => {
					if (!checkFile(entry, ts)) {
						invalid();
					} else {
						jobDone();
					}
				});
			}
		}
		if (contextTimestamps.size > 0) {
			// TODO: getContextTimestamp is not implemented yet
			invalid();
		}
		for (const [path, ts] of missingTimestamps) {
			const cache = this._fileTimestamps.get(path);
			if (cache !== undefined) {
				if (!checkFile(cache, ts)) {
					invalid();
				}
			} else {
				jobs++;
				console.log("MISSING FOR VALIDATION", path);
				this.fileTimestampQueue.add(path, (err, entry) => {
					if (!checkFile(entry, ts)) {
						invalid();
					} else {
						jobDone();
					}
				});
			}
		}
		jobDone();
	}

	// TODO getFileHash(path, callback)

	_readFileTimestamp(path, callback) {
		this.fs.stat(path, (err, stat) => {
			if (err) {
				if (err.code === "ENOENT") {
					this._fileTimestamps.set(path, null);
					return callback(null, null);
				}
				return callback(err);
			}

			if (stat.mtime) applyMtime(+stat.mtime);

			const mtime = +stat.mtime || Infinity;
			const ts = {
				safeTime: mtime + FS_ACCURACY,
				timestamp: mtime
			};

			this._fileTimestamps.set(path, ts);

			callback(null, ts);
		});
	}

	_readContextTimestamp(path, callback) {
		// TODO read whole folder
		this._contextTimestamps.set(path, null);
		callback(null, null);
	}

	getDeprecatedFileTimestamps() {
		const map = new Map();
		for (const [path, info] of this._fileTimestamps) {
			if (info) map.set(path, info.safeTime);
		}
		return map;
	}

	getDeprecatedContextTimestamps() {
		const map = new Map();
		for (const [path, info] of this._contextTimestamps) {
			if (info) map.set(path, info.safeTime);
		}
		return map;
	}
}

module.exports = FileSystemInfo;
